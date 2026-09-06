/* ============================================================
   views/earnings.js — Earnings: where the profit came from, and
   whether any of it is wrong.

   Owner-only end to end: the nav item only appears when
   app.can.view_profit is true, and every call here is re-checked
   server-side by security.py regardless.

   THE SHAPE OF THE SCREEN

   It is a drill-down, not a report. Every number is a door:

     Overview  →  an item / a customer / a bill
               →  the bills behind it
               →  one bill, line by line, with the cost that was
                  actually used to work out its profit

   The last step is the one that matters most. A profit figure is only
   as trustworthy as the cost behind it, and the cost behind it is NOT
   the item's cost price as it stands today - it is what the batches
   that line consumed cost at the moment it was sold. Those two drift
   apart the moment stock is bought at a new price, which is exactly
   when a wrong-looking number needs explaining. So the bill view shows
   the applied cost, per line, and says where it came from.

   The "Worth a look" panel is the other half of the job: lines sold
   below cost, lines with no cost recorded at all, giveaways and
   impossible margins. None of them is automatically a mistake, and no
   total would ever reveal any of them.
   ============================================================ */

import { api } from '../api.js';
import {
  q, qa, on, node, esc, icon, inr, qty as fmtQty, dmy, toast, emptyState, prefs,
} from '../core.js';

const RANGES = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'all', label: 'All time' },
];

const RANGE_LABEL = { today: "Today's", week: "This week's", month: "This month's", all: 'All-time' };

/* The four checks, in the order they deserve attention. */
const CHECKS = [
  { key: 'sold_below_cost', label: 'Sold below cost', tone: 'bad',
    why: 'The line lost money. Sometimes deliberate — old stock, a favour — but usually a price typed wrong, or a cost recorded per carton against a per-piece quantity.' },
  { key: 'no_cost', label: 'No cost recorded', tone: 'warn',
    why: 'Nothing is known about what these cost, so their whole selling price is being counted as profit. Every one of them inflates the figures above.' },
  { key: 'suspicious_margin', label: 'Margin over 90%', tone: 'warn',
    why: 'Possible, but usually a cost that is out by a factor of ten.' },
  { key: 'free', label: 'Given away', tone: 'info',
    why: 'Sold at zero. Real often enough — a replacement, a sample — but it should be a decision rather than a slip.' },
];

let S = null;

export default {
  title: 'Earnings',

  async mount(root, ctx) {
    S = {
      ctx, root,
      range: prefs.get('earn.range', 'month'),
      data: null,
      checks: null,
      tab: prefs.get('earn.tab', 'items'),   // items | customers | bills | categories
      // The drill-down stack. Empty = the overview. Each entry is
      // {kind, label, ...} and the breadcrumb is just this list.
      trail: [],
      drill: null,
      bill: null,
      loading: true,
    };

    paint(root);
    wire();
    ctx.setActions(buildActions());
    await load();
  },

  destroy() { S = null; },
};

/* ============================ chrome ============================ */
function buildActions() {
  const seg = node(`<div class="seg" id="earnRange">
    ${RANGES.map(r => `<button data-r="${r.key}" class="${r.key === S.range ? 'on' : ''}">${esc(r.label)}</button>`).join('')}
  </div>`);
  on(seg, 'click', 'button', (e, b) => {
    if (b.dataset.r === S.range) return;
    S.range = b.dataset.r;
    prefs.set('earn.range', S.range);
    qa('button', seg).forEach(x => x.classList.toggle('on', x === b));
    // A drill-down belongs to the window it was opened from, so changing
    // the window returns to the top rather than showing bills from one
    // period under a heading from another.
    S.trail = []; S.drill = null; S.bill = null;
    load();
  });
  return [
    { el: seg },
    { label: 'Export', icon: 'download', cls: 'btn-ghost', onClick: doExport },
  ];
}

async function doExport() {
  const view = ['items', 'customers', 'bills'].includes(S.tab) ? S.tab : 'items';
  try {
    const p = await api.earnings_export(S.range, null, view);
    toast('Exported', `Saved to ${p}`, 'ok', 6000);
  } catch (e) {
    if (!/no location/i.test(e.message || '')) toast('Could not export', e.message, 'bad');
  }
}

function paint(root) {
  root.innerHTML = `<div class="col grow" style="min-height:0">
    <div id="crumbs" class="row gap2" style="padding:var(--s4) var(--s5) 0;align-items:center"></div>
    <div id="earnBody" class="col grow" style="min-height:0"></div>
  </div>`;
  S.el = { crumbs: q('#crumbs', root), body: q('#earnBody', root) };
}

function wire() {
  on(S.root, 'click', '[data-crumb]', (e, b) => {
    const n = +b.dataset.crumb;
    S.trail = S.trail.slice(0, n);
    S.drill = S.trail.length ? S.drill : null;
    S.bill = null;
    if (!S.trail.length) { S.drill = null; render(); return; }
    openTrailTop();
  });

  on(S.root, 'click', '[data-tab]', (e, b) => {
    S.tab = b.dataset.tab;
    prefs.set('earn.tab', S.tab);
    render();
  });

  on(S.root, 'click', '[data-drill-item]', (e, b) => drillInto('item', b.dataset.drillItem));
  on(S.root, 'click', '[data-drill-cust]', (e, b) => drillInto('customer', b.dataset.drillCust));
  on(S.root, 'click', '[data-bill]', (e, b) => openBill(+b.dataset.bill, b.dataset.billNo || ''));

  // Esc walks back up the drill-down, the way it closes everything else
  // in this app.
  S._esc = (e) => {
    if (e.key !== 'Escape' || !S || !S.trail.length) return;
    if (e.target.matches('input,textarea,select')) return;
    S.trail.pop();
    S.bill = null;
    if (!S.trail.length) { S.drill = null; render(); } else openTrailTop();
  };
  document.addEventListener('keydown', S._esc);
}

/* ============================ data ============================ */
async function load() {
  S.loading = true;
  render();
  try {
    const [data, checks] = await Promise.all([
      api.earnings(S.range, null),
      api.earnings_checks(S.range, null),
    ]);
    if (!S) return;
    S.data = data;
    S.checks = checks;
  } catch (e) {
    if (!S) return;
    S.el.body.innerHTML = emptyState('warn', 'Could not load earnings', e.message || 'Please try again.');
    S.loading = false;
    return;
  }
  S.loading = false;
  render();
}

async function drillInto(kind, label) {
  S.trail = [{ kind, label }];
  S.bill = null;
  await openTrailTop();
}

async function openTrailTop() {
  const top = S.trail[S.trail.length - 1];
  if (!top) { render(); return; }
  if (top.kind === 'bill') { render(); return; }
  S.loading = true; render();
  try {
    S.drill = await api.earnings_bills(S.range, null,
      top.kind === 'item' ? top.label : null,
      top.kind === 'customer' ? top.label : null);
  } catch (e) {
    toast('Could not open that', e.message, 'bad');
    S.trail.pop();
  }
  S.loading = false;
  render();
}

async function openBill(billId, billNo) {
  S.loading = true; render();
  try {
    S.bill = await api.bill_profit(billId);
    S.trail.push({ kind: 'bill', label: billNo || `Bill ${billId}`, id: billId });
  } catch (e) {
    toast('Could not open that bill', e.message, 'bad');
  }
  S.loading = false;
  render();
}

/* ============================ render ============================ */
function render() {
  renderCrumbs();
  const host = S.el.body;
  if (S.loading) {
    host.innerHTML = `<div class="pad col gap4">
      <div class="skel" style="height:84px;border-radius:var(--r-xl)"></div>
      <div class="skel grow" style="border-radius:var(--r-xl)"></div></div>`;
    return;
  }
  const top = S.trail[S.trail.length - 1];
  if (top?.kind === 'bill') host.innerHTML = billView();
  else if (top) host.innerHTML = drillView(top);
  else host.innerHTML = overview();
}

function renderCrumbs() {
  if (!S.trail.length) { S.el.crumbs.innerHTML = ''; return; }
  const parts = [`<button class="btn btn-ghost btn-sm" data-crumb="0">${icon('chart', 14)}Earnings</button>`];
  S.trail.forEach((t, i) => {
    const last = i === S.trail.length - 1;
    parts.push(`<span class="muted">${icon('chevRight', 13)}</span>`);
    parts.push(last
      ? `<span class="small strong ellipsis" style="max-width:340px">${esc(t.label)}</span>`
      : `<button class="btn btn-ghost btn-sm" data-crumb="${i + 1}">${esc(t.label)}</button>`);
  });
  parts.push(`<span class="grow"></span><span class="tiny muted">Esc goes back</span>`);
  S.el.crumbs.innerHTML = parts.join('');
}

/* ---------- overview ---------- */
function overview() {
  const d = S.data || {};
  const s = d.summary || {};
  const period = d.date_from ? `${dmy(d.date_from)} – ${dmy(d.date_to)}` : 'everything on file';

  return `<div class="pad col gap4 grow scroll-y" style="min-height:0">
    ${kpiRow(s, d.delta || {})}
    ${trendPanel(d.daily || [])}
    ${confidenceNote(s, period)}
    <div class="split split-h" data-split="earnings.lists" style="min-height:340px">
      <div class="pane pane-fill" style="padding-right:6px">${rankPanel()}</div>
      <div class="pane pane-sized" data-size="420" data-min="320" data-max="620" style="padding-left:6px">
        ${checksPanel()}
      </div>
    </div>
  </div>`;
}

function kpiRow(s, delta) {
  const tiles = [
    { k: 'Revenue', v: inr(s.revenue || 0), tone: '', d: delta.revenue,
      hint: `${(s.bills || 0)} bill${s.bills === 1 ? '' : 's'}` },
    { k: 'Cost of goods', v: inr(s.cost || 0), tone: '',
      hint: 'what the stock that went out actually cost' },
    { k: `${RANGE_LABEL[S.range] || ''} profit`, v: inr(s.profit || 0),
      tone: (s.profit || 0) < 0 ? 'bad' : 'ok', d: delta.profit,
      hint: 'revenue minus that cost' },
    { k: 'Margin', v: `${(s.margin || 0).toFixed(1)}%`, tone: '',
      hint: 'profit as a share of revenue' },
  ];
  return `<div class="kpis">${tiles.map(t => `
    <div class="tile">
      <div class="row between">
        <span class="overline">${esc(t.k)}</span>
        ${t.d == null ? '' : `<span class="pill ${t.d >= 0 ? 'pill-ok' : 'pill-bad'}">${t.d >= 0 ? '+' : ''}${t.d}%</span>`}
      </div>
      <div class="h1 mono" style="margin-top:6px;${t.tone === 'bad' ? 'color:var(--bad-ink)' : t.tone === 'ok' ? 'color:var(--ok-ink)' : ''}">${esc(t.v)}</div>
      <div class="tiny muted">${esc(t.hint)}</div>
    </div>`).join('')}</div>`;
}

/** Profit per day, as bars above and below zero - a losing day should
    look like one, not like a short bar. */
function trendPanel(daily) {
  if (!daily.length) {
    return `<div class="panel" style="padding:16px">${emptyState('chart', 'No sales in this period', 'Nothing to plot yet.')}</div>`;
  }
  const w = 1000, h = 150, pad = 6;
  const vals = daily.map(d => d.profit || 0);
  const max = Math.max(1, ...vals.map(Math.abs));
  const bw = Math.max(2, (w - pad * 2) / daily.length - 2);
  const zero = h / 2;
  const bars = daily.map((d, i) => {
    const x = pad + i * ((w - pad * 2) / daily.length);
    const v = d.profit || 0;
    const bh = Math.max(1, Math.abs(v) / max * (h / 2 - 8));
    const y = v >= 0 ? zero - bh : zero;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}"
      rx="1.5" fill="${v >= 0 ? 'var(--ok)' : 'var(--bad)'}" opacity=".85">
      <title>${esc(dmy(d.date))} — profit ${esc(inr(v))} on ${esc(inr(d.revenue || 0))} revenue</title></rect>`;
  }).join('');
  const best = daily.reduce((a, b) => (b.profit || 0) > (a.profit || 0) ? b : a, daily[0]);
  const worst = daily.reduce((a, b) => (b.profit || 0) < (a.profit || 0) ? b : a, daily[0]);

  return `<div class="panel">
    <div class="panel-head">
      <div class="col grow">
        <div class="h2">Profit by day</div>
        <div class="tiny muted">Best ${esc(dmy(best.date))} ${esc(inr(best.profit))}${
          (worst.profit || 0) < 0 ? ` · worst ${esc(dmy(worst.date))} ${esc(inr(worst.profit))}` : ''}</div>
      </div>
    </div>
    <div style="padding:6px 16px 16px">
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:150px;display:block">
        <line x1="0" y1="${zero}" x2="${w}" y2="${zero}" stroke="var(--line)" stroke-width="1"/>
        ${bars}
      </svg>
    </div>
  </div>`;
}

function confidenceNote(s, period) {
  const uncosted = s.uncosted_lines || 0;
  if (!uncosted) {
    return `<div class="tiny muted" style="padding:0 2px">Covering ${esc(period)}. Every sold line in this
      period has a recorded cost, so the profit above is worked out from what the stock really cost.</div>`;
  }
  return `<div class="row gap3" style="padding:10px 12px;background:var(--warn-soft);border-radius:var(--r-md);
      color:var(--warn-ink)">
    ${icon('warn', 16)}
    <div class="small grow">Covering ${esc(period)}. ${uncosted} sold line${uncosted === 1 ? '' : 's'}
      had no recorded cost and fell back to the item's cost price — ${(s.costed_pct || 0).toFixed(0)}% of
      revenue is costed from real purchase records. Bills entered before cost tracking existed are the
      usual reason.</div>
  </div>`;
}

const TABS = [
  { id: 'items', label: 'By item' },
  { id: 'customers', label: 'By customer' },
  { id: 'categories', label: 'By category' },
  { id: 'bills', label: 'By bill' },
];

function rankPanel() {
  const d = S.data || {};
  const rows = S.tab === 'customers' ? (d.customers || [])
    : S.tab === 'categories' ? (d.categories || [])
    : S.tab === 'bills' ? null
    : (d.items || []);

  return `<div class="panel grow col" style="min-height:0">
    <div class="panel-head row between">
      <div class="seg">${TABS.map(t => `<button data-tab="${t.id}" class="${t.id === S.tab ? 'on' : ''}">${esc(t.label)}</button>`).join('')}</div>
      <span class="tiny muted">click a row to see the bills behind it</span>
    </div>
    ${S.tab === 'bills' ? billsListInline() : rankTable(rows)}
  </div>`;
}

function rankTable(rows) {
  if (!rows || !rows.length) {
    return emptyState('chart', 'Nothing here yet', 'No sales in this period.');
  }
  const max = Math.max(...rows.map(r => Math.abs(r.profit || 0)), 1);
  const clickable = S.tab === 'items' || S.tab === 'customers';
  const attr = S.tab === 'items' ? 'data-drill-item' : S.tab === 'customers' ? 'data-drill-cust' : '';

  return `
    <div class="tbl-head">
      <div class="grow">${S.tab === 'items' ? 'Item' : S.tab === 'customers' ? 'Customer' : 'Category'}</div>
      <div class="num-cell" style="width:110px">Revenue</div>
      <div class="num-cell" style="width:110px">Cost</div>
      <div class="num-cell" style="width:110px">Profit</div>
      <div style="width:120px">Margin</div>
    </div>
    <div class="tbl-body scroll-y grow">
      ${rows.map(r => {
        const p = r.profit || 0;
        const pct = Math.abs(p) / max * 100;
        return `<div class="tr${clickable ? ' tap' : ''}" ${clickable ? `${attr}="${esc(r.label)}"` : ''}
          ${clickable ? `role="button" tabindex="0" title="See the bills behind ${esc(r.label)}"` : ''}>
          <div class="grow ellipsis strong">${esc(r.label || 'Unknown')}
            ${r.uncosted_lines ? `<span class="pill pill-warn" style="margin-left:6px">${r.uncosted_lines} uncosted</span>` : ''}
            <div class="tiny muted">${r.quantity != null ? fmtQty(r.quantity) + ' sold · ' : ''}${r.bills || 0} bill${r.bills === 1 ? '' : 's'}</div>
          </div>
          <div class="num-cell mono" style="width:110px">${inr(r.revenue || 0)}</div>
          <div class="num-cell mono" style="width:110px">${inr(r.cost || 0)}</div>
          <div class="num-cell mono strong" style="width:110px;${p < 0 ? 'color:var(--bad-ink)' : ''}">${inr(p)}</div>
          <div style="width:120px">
            <div class="row gap2" style="align-items:center">
              <div class="bar grow"><i style="width:${pct.toFixed(1)}%;background:${p < 0 ? 'var(--bad)' : 'var(--ok)'}"></i></div>
              <span class="tiny mono muted" style="min-width:42px;text-align:right">${(r.margin || 0).toFixed(0)}%</span>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

function billsListInline() {
  const bills = (S.data?.bills) || null;
  if (!bills) {
    // Bills aren't part of the overview payload - fetched on demand the
    // first time this tab is opened.
    loadOverviewBills();
    return `<div class="pad"><div class="skel" style="height:120px"></div></div>`;
  }
  return billsTable(bills, { showCustomer: true });
}

async function loadOverviewBills() {
  if (S._billsPending) return;
  S._billsPending = true;
  try {
    const res = await api.earnings_bills(S.range, null);
    if (!S) return;
    S.data.bills = res.bills || [];
  } catch (e) { if (S) S.data.bills = []; }
  S._billsPending = false;
  if (S && S.tab === 'bills') render();
}

/* ---------- drill: the bills behind an item or a customer ---------- */
function drillView(top) {
  const d = S.drill || {};
  const bills = d.bills || [];
  const totals = bills.reduce((a, b) => ({
    revenue: a.revenue + (b.revenue || 0),
    cost: a.cost + (b.cost || 0),
    profit: a.profit + (b.profit || 0),
  }), { revenue: 0, cost: 0, profit: 0 });

  const what = top.kind === 'item' ? 'this item' : 'this customer';
  return `<div class="pad col gap4 grow" style="min-height:0">
    <div class="panel">
      <div class="panel-head row between">
        <div class="col grow">
          <div class="h2">${esc(top.label)}</div>
          <div class="tiny muted">${bills.length} bill${bills.length === 1 ? '' : 's'} ·
            figures below are ${top.kind === 'item' ? "<b>this item's share</b> of each bill" : 'the whole of each bill'}</div>
        </div>
        <div class="row gap5">
          ${[['Revenue', totals.revenue], ['Cost', totals.cost], ['Profit', totals.profit]].map(([k, v]) => `
            <div class="col" style="text-align:right">
              <span class="overline">${k}</span>
              <span class="mono strong" style="${k === 'Profit' && v < 0 ? 'color:var(--bad-ink)' : ''}">${inr(v)}</span>
            </div>`).join('')}
        </div>
      </div>
    </div>
    <div class="panel grow col" style="min-height:0">
      <div class="panel-head"><div class="h2 grow">Bills that made up ${esc(what)}</div>
        <span class="tiny muted">click a bill to see its costs line by line</span></div>
      ${bills.length ? billsTable(bills, { showCustomer: top.kind !== 'customer' })
                     : emptyState('history', 'No bills', 'Nothing in this period.')}
    </div>
  </div>`;
}

function billsTable(bills, { showCustomer = true } = {}) {
  return `
    <div class="tbl-head">
      <div style="width:110px">Bill</div>
      <div style="width:104px">Date</div>
      ${showCustomer ? '<div class="grow">Customer</div>' : '<div class="grow">Items</div>'}
      <div class="num-cell" style="width:110px">Revenue</div>
      <div class="num-cell" style="width:110px">Cost</div>
      <div class="num-cell" style="width:110px">Profit</div>
      <div style="width:70px;text-align:right">Margin</div>
    </div>
    <div class="tbl-body scroll-y grow">
      ${bills.map(b => `
        <div class="tr tap" data-bill="${b.bill_id}" data-bill-no="${esc(b.bill_number)}"
             role="button" tabindex="0" title="Open bill ${esc(b.bill_number)}">
          <div class="mono ellipsis" style="width:110px">${esc(b.bill_number)}</div>
          <div style="width:104px">${esc(dmy(b.bill_date))}</div>
          ${showCustomer
            ? `<div class="grow ellipsis">${esc(b.customer_name || '—')}
                 ${b.uncosted_lines ? `<span class="pill pill-warn" style="margin-left:6px">${b.uncosted_lines} uncosted</span>` : ''}</div>`
            : `<div class="grow">${b.lines} line${b.lines === 1 ? '' : 's'}
                 ${b.uncosted_lines ? `<span class="pill pill-warn" style="margin-left:6px">${b.uncosted_lines} uncosted</span>` : ''}</div>`}
          <div class="num-cell mono" style="width:110px">${inr(b.revenue || 0)}</div>
          <div class="num-cell mono" style="width:110px">${inr(b.cost || 0)}</div>
          <div class="num-cell mono strong" style="width:110px;${(b.profit || 0) < 0 ? 'color:var(--bad-ink)' : ''}">${inr(b.profit || 0)}</div>
          <div class="mono tiny muted" style="width:70px;text-align:right">${(b.margin || 0).toFixed(0)}%</div>
        </div>`).join('')}
    </div>`;
}

/* ---------- the bottom: one bill, and the cost actually applied ---------- */
const COST_SOURCE = {
  recorded: { pill: '', text: 'From the stock this line actually consumed' },
  default:  { pill: 'pill-warn', text: "Estimated from the item's current cost price — this line predates cost tracking" },
  none:     { pill: 'pill-bad',  text: 'No cost known, so all of this counts as profit' },
};

function billView() {
  const d = S.bill;
  if (!d) return emptyState('warn', 'Bill not loaded', '');
  const b = d.bill;
  const anyEstimated = d.lines.some(l => l.cost_source !== 'recorded');

  return `<div class="pad col gap4 grow scroll-y" style="min-height:0">
    <div class="panel">
      <div class="panel-head row between">
        <div class="col grow">
          <div class="h2">Bill ${esc(b.bill_number)}</div>
          <div class="tiny muted">${esc(dmy(b.bill_date))} ${esc(b.bill_time || '')} ·
            ${esc(b.customer_name || '—')}${b.customer_phone ? ' · ' + esc(b.customer_phone) : ''}</div>
        </div>
        <div class="row gap5">
          ${[['Revenue', d.revenue], ['Cost', d.cost], ['Profit', d.profit]].map(([k, v]) => `
            <div class="col" style="text-align:right">
              <span class="overline">${k}</span>
              <span class="mono strong" style="${k === 'Profit' && v < 0 ? 'color:var(--bad-ink)' : ''}">${inr(v)}</span>
            </div>`).join('')}
          <div class="col" style="text-align:right">
            <span class="overline">Margin</span>
            <span class="mono strong">${(d.margin || 0).toFixed(1)}%</span>
          </div>
        </div>
      </div>
    </div>

    ${!d.is_sale ? `<div class="row gap3" style="padding:10px 12px;background:var(--info-soft);
        border-radius:var(--r-md);color:var(--info-ink)">${icon('info', 16)}
      <div class="small grow">This is a purchase bill. Its prices are what was paid, so there is no profit on
        it — it is what put the stock, and its cost, into the shop in the first place.</div></div>` : ''}

    <div class="panel grow col" style="min-height:0">
      <div class="panel-head">
        <div class="col grow">
          <div class="h2">Line by line</div>
          <div class="tiny muted">The cost shown is what was applied when this bill's profit was worked out —
            not the item's cost price today.</div>
        </div>
      </div>
      <div class="tbl-head">
        <div class="grow">Item</div>
        <div class="num-cell" style="width:92px">Qty</div>
        <div class="num-cell" style="width:110px">Cost / unit</div>
        <div class="num-cell" style="width:110px">Sold at</div>
        <div class="num-cell" style="width:110px">Line total</div>
        <div class="num-cell" style="width:110px">Profit</div>
        <div style="width:70px;text-align:right">Margin</div>
      </div>
      <div class="tbl-body scroll-y grow">
        ${d.lines.map(l => {
          const src = COST_SOURCE[l.cost_source] || COST_SOURCE.recorded;
          return `<div class="tr" title="${esc(src.text)}">
            <div class="grow ellipsis">
              <span class="strong">${esc(l.item_name)}</span>
              ${src.pill ? `<span class="pill ${src.pill}" style="margin-left:6px">${l.cost_source === 'none' ? 'no cost' : 'estimated'}</span>` : ''}
              ${l.pack_qty && l.pack_unit_name ? `<div class="tiny muted">${fmtQty(l.pack_qty)} ${esc(l.pack_unit_name)}</div>` : ''}
            </div>
            <div class="num-cell mono" style="width:92px">${fmtQty(l.quantity)}${l.item_unit ? ' ' + esc(l.item_unit) : ''}</div>
            <div class="num-cell mono" style="width:110px">${inr(l.cost_per_unit)}</div>
            <div class="num-cell mono" style="width:110px">${inr(l.price_per_unit)}</div>
            <div class="num-cell mono" style="width:110px">${inr(l.line_revenue)}</div>
            <div class="num-cell mono strong" style="width:110px;${l.line_profit < 0 ? 'color:var(--bad-ink)' : ''}">${inr(l.line_profit)}</div>
            <div class="mono tiny muted" style="width:70px;text-align:right">${(l.margin || 0).toFixed(0)}%</div>
          </div>`;
        }).join('')}
      </div>
      <div class="row between" style="padding:10px 16px;border-top:1px solid var(--line)">
        <span class="tiny muted">
          ${anyEstimated ? 'Rows marked <b>estimated</b> or <b>no cost</b> are not costed from real purchases — treat their profit as a guess.'
                         : 'Every line here is costed from the stock it actually consumed.'}
        </span>
        <span class="tiny muted">Bill total ${esc(inr(b.total))}${
          b.freight_charges ? ` (incl. ${esc(inr(b.freight_charges))} addition)` : ''}${
          b.discount ? ` (less ${esc(inr(b.discount))})` : ''}</span>
      </div>
    </div>
  </div>`;
}

/* ---------- worth a look ---------- */
function checksPanel() {
  const ch = S.checks || {};
  const total = CHECKS.reduce((n, c) => n + ((ch[c.key] || []).length), 0);

  return `<div class="panel grow col" style="min-height:0">
    <div class="panel-head">
      <div class="col grow">
        <div class="h2">Worth a look</div>
        <div class="tiny muted">${total ? `${total} line${total === 1 ? '' : 's'} that usually mean a mistake somewhere`
                                        : 'Nothing unusual in this period'}</div>
      </div>
    </div>
    <div class="scroll-y grow" style="padding:6px 12px 12px">
      ${total ? CHECKS.map(c => {
        const rows = ch[c.key] || [];
        if (!rows.length) return '';
        return `<div style="margin-top:10px">
          <div class="row gap2" style="align-items:baseline">
            <span class="pill pill-${c.tone === 'bad' ? 'bad' : c.tone === 'warn' ? 'warn' : 'ok'}">${rows.length}</span>
            <span class="small strong">${esc(c.label)}</span>
          </div>
          <div class="tiny muted" style="margin:4px 0 6px">${esc(c.why)}</div>
          ${rows.slice(0, 8).map(r => `
            <button class="row between tap" data-bill="${r.bill_id}" data-bill-no="${esc(r.bill_number)}"
              style="width:100%;text-align:left;padding:6px 8px;border-radius:var(--r-sm);
                     border:1px solid var(--line);background:transparent;margin-bottom:4px">
              <span class="col" style="min-width:0">
                <span class="small ellipsis">${esc(r.item_name)}</span>
                <span class="tiny muted">${esc(r.bill_number)} · ${esc(dmy(r.bill_date))} · ${esc(r.customer_name || '')}</span>
              </span>
              <span class="mono small" style="${(r.line_profit || 0) < 0 ? 'color:var(--bad-ink)' : ''}">${inr(r.line_profit || 0)}</span>
            </button>`).join('')}
          ${rows.length > 8 ? `<div class="tiny muted">…and ${rows.length - 8} more</div>` : ''}
        </div>`;
      }).join('') : `<div class="col center grow" style="padding:24px;text-align:center">
          ${icon('check', 22)}
          <div class="small muted" style="margin-top:8px">No lines sold below cost, no missing costs,
            nothing given away by accident.</div>
        </div>`}
    </div>
  </div>`;
}
