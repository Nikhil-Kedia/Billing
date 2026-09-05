/* ============================================================
   views/dashboard.js — the morning screen.

   KPI tiles (delta chip + sparkline) → a resizable revenue hero
   chart (smooth area/line + hover crosshair) with a bill-count bar
   strip sharing its x-scale → a resizable lower block: top products,
   a day-of-week bar chart, a day×hour heatmap, collected-vs-credit
   and receivables ageing. Every boundary is a live split panel.

   All charts are hand-drawn inline SVG or the `.bars`/`.bar`/`.heat`
   CSS patterns — no libraries. The hero chart's SVG coordinate space
   is tied to measured pixels, so it redraws on `nova:resize` and on
   ResizeObserver (the panels either side of it can be dragged).
   ============================================================ */

import { api } from '../api.js';
import {
  q, qa, el, node, on, esc, icon, inr, inrShort, qty, dmy, todayISO,
  toast, modal, emptyState, debounce, prefs,
} from '../core.js';

const RANGES = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'all', label: 'All time' },
];

const MONTHS_LONG = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];

/** Month selection is a per-session choice, not a remembered setting —
    it must not survive an app restart, unlike everything `prefs` stores.
    sessionStorage already gives exactly that lifetime for free. */
const sessionPrefs = {
  get(k, d = null) {
    try { const v = sessionStorage.getItem('nova.' + k); return v == null ? d : JSON.parse(v); }
    catch { return d; }
  },
  set(k, v) { try { sessionStorage.setItem('nova.' + k, JSON.stringify(v)); } catch {} },
};

const TILE_DEF = {
  revenue:     { icon: 'rupee', label: () => `${rangeLabel(S.range)} Revenue` },
  bills:       { icon: 'book', label: () => 'Bills' },
  avg:         { icon: 'chart', label: () => 'Average Bill' },
  outstanding: { icon: 'card', label: () => 'Outstanding Dues' },
  low_stock:   { icon: 'box', label: () => 'Low Stock' },
};

const TONE = {
  revenue: () => 'primary',
  bills: () => 'neutral',
  avg: () => 'neutral',
  outstanding: (k) => (k.outstanding || 0) > 0.009 ? 'danger' : 'success',
  low_stock: (k) => (k.low_stock || 0) > 0 ? 'warning' : 'success',
};

let S = null;   // screen state

export default {
  title: 'Dashboard',

  async mount(root, ctx) {
    const savedMonth = sessionPrefs.get('dash.month', null);
    S = {
      ctx, root, range: prefs.get('dash.range', 'month'),
      month: (savedMonth && /^\d{4}-\d{2}$/.test(savedMonth)) ? savedMonth : todayISO().slice(0, 7),
      bounds: { first: null, last: null },
      data: null, ro: null, onResize: null, el: null, xr: null,
    };
    paint(root);
    ctx.setActions(buildActions());
    ctx.setSub(rangeSubtitle(S.range));
    wireResize();

    try { S.bounds = await api.bill_date_bounds() || S.bounds; } catch {}
    if (S) {
      // A month remembered from earlier this session could now be out of
      // range (fresh install, or the one bill that set the lower bound
      // was deleted) — clamp quietly rather than asking the server to.
      const mn = minMonth(), mx = maxMonth();
      if (S.month < mn) S.month = mn;
      if (S.month > mx) S.month = mx;
      if (S.range === 'month') { ctx.setActions(buildActions()); ctx.setSub(rangeSubtitle(S.range)); }
    }

    await load();
  },

  destroy() {
    if (S?.onResize) window.removeEventListener('nova:resize', S.onResize);
    S?.ro?.disconnect();
    S = null;
  },
};

/* ============================ top bar ============================ */
function monthLongLabel(m) {
  if (!m) return '';
  const [y, mo] = m.split('-').map(Number);
  return `${MONTHS_LONG[mo - 1]} ${y}`;
}

function minMonth() { return S.bounds?.first ? S.bounds.first.slice(0, 7) : todayISO().slice(0, 7); }
function maxMonth() { return todayISO().slice(0, 7); }

function rangeLabel(r) {
  if (r === 'today') return "Today's";
  if (r === 'week') return "This Week's";
  if (r === 'all') return 'All-time';
  if (S.month === maxMonth()) return "This Month's";
  return `${MONTHS_LONG[+S.month.slice(5, 7) - 1]}'s`;
}

function rangeSubtitle(r) {
  if (r === 'today') return `Showing today, ${dmy(todayISO())}`;
  if (r === 'week') return 'Showing the last 7 days';
  if (r === 'all') return S.bounds?.first ? `Showing every bill since ${dmy(S.bounds.first)}` : 'Showing every bill on record';
  return S.month === maxMonth() ? 'Showing this month so far' : `Showing ${monthLongLabel(S.month)}`;
}

function buildActions() {
  const seg = el('div', 'seg');
  seg.id = 'dashRangeSeg';
  seg.innerHTML = RANGES.map(r => `<button data-r="${r.key}" class="${r.key === S.range ? 'on' : ''}">${esc(r.label)}</button>`).join('');
  on(seg, 'click', 'button', (e, b) => setRange(b.dataset.r));
  const actions = [{ el: seg }];
  if (S.range === 'month') actions.push({ el: buildMonthNav() });
  actions.push({ label: 'New bill', icon: 'plus', cls: 'btn-primary', onClick: () => S.ctx.go('newbill') });
  return actions;
}

function setRange(key) {
  if (!S || key === S.range) return;
  S.range = key;
  prefs.set('dash.range', key);
  S.ctx.setActions(buildActions());
  S.ctx.setSub(rangeSubtitle(S.range));
  showSkeletons();
  load();
}

/* ---------- month navigator (only shown when range === 'month') ---------- */
function shiftedMonth(m, delta) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function setMonth(m) {
  if (!S) return;
  const mn = minMonth(), mx = maxMonth();
  if (m < mn) m = mn;
  if (m > mx) m = mx;
  if (m === S.month) return;
  S.month = m;
  sessionPrefs.set('dash.month', m);
  S.ctx.setActions(buildActions());
  S.ctx.setSub(rangeSubtitle(S.range));
  showSkeletons();
  load();
}

function buildMonthNav() {
  const wrap = el('div', 'row gap1');
  const mn = minMonth(), mx = maxMonth();
  const canPrev = shiftedMonth(S.month, -1) >= mn;
  const canNext = shiftedMonth(S.month, 1) <= mx;
  wrap.innerHTML = `
    <button class="btn btn-icon btn-sm" id="mnPrev" title="Previous month" ${canPrev ? '' : 'disabled'}>${icon('chevLeft', 14)}</button>
    <button class="btn btn-sm" id="mnLabel" style="min-width:132px;font-variant-numeric:tabular-nums" title="Choose a month">${esc(monthLongLabel(S.month))}</button>
    <button class="btn btn-icon btn-sm" id="mnNext" title="Next month" ${canNext ? '' : 'disabled'}>${icon('chevRight', 14)}</button>`;
  q('#mnPrev', wrap).onclick = () => setMonth(shiftedMonth(S.month, -1));
  q('#mnNext', wrap).onclick = () => setMonth(shiftedMonth(S.month, 1));
  q('#mnLabel', wrap).onclick = () => openMonthPicker();
  return wrap;
}

async function openMonthPicker() {
  const mn = minMonth(), mx = maxMonth();
  let curY = +S.month.slice(0, 4);
  const body = node('<div class="col gap3" style="min-width:236px"></div>');
  let closeModal;

  function paintGrid() {
    const canPrevYear = `${curY - 1}-12` >= mn;
    const canNextYear = `${curY + 1}-01` <= mx;
    body.innerHTML = `
      <div class="row between">
        <button class="btn btn-icon btn-sm" id="mpPrevY" ${canPrevYear ? '' : 'disabled'}>${icon('chevLeft', 14)}</button>
        <div class="h3">${curY}</div>
        <button class="btn btn-icon btn-sm" id="mpNextY" ${canNextYear ? '' : 'disabled'}>${icon('chevRight', 14)}</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">
        ${MONTHS_LONG.map((nm, i) => {
          const m = `${curY}-${String(i + 1).padStart(2, '0')}`;
          const disabled = m < mn || m > mx;
          const on = m === S.month;
          return `<button class="btn btn-sm ${on ? 'btn-primary' : ''}" data-m="${m}" ${disabled ? 'disabled' : ''}>${nm.slice(0, 3)}</button>`;
        }).join('')}
      </div>`;
    q('#mpPrevY', body).onclick = () => { curY--; paintGrid(); };
    q('#mpNextY', body).onclick = () => { curY++; paintGrid(); };
    qa('[data-m]', body).forEach(b => { b.onclick = () => closeModal(b.dataset.m); });
  }

  const picked = await modal({
    title: 'Choose month', icon: 'calendar', body,
    onOpen: (bd, close) => { closeModal = close; paintGrid(); },
  });
  if (picked) setMonth(picked);
}

/* ============================ layout ============================ */
function paint(root) {
  root.innerHTML = `
  <div class="col grow gap4" style="padding:var(--s4) var(--s5) var(--s5);min-height:0">
    <div class="kpis stagger" id="kpis"></div>

    <div class="split split-v grow" data-split="dashboard.custom">
    <div class="pane pane-fill">
    <div class="split split-v grow" data-split="dashboard.main">
      <div class="pane pane-sized" data-size="380" data-min="260" data-max="560">
        <div class="panel grow">
          <div class="panel-head">
            <div class="col grow" style="gap:1px">
              <div class="h2">Revenue trend</div>
              <div class="tiny muted" id="heroSub">—</div>
            </div>
            <div class="legend">
              <span><i style="background:var(--accent)"></i>Revenue</span>
              <span><i style="background:var(--accent-soft-2)"></i>Bills</span>
            </div>
          </div>
          <div class="chart-wrap" id="heroChart" style="padding:14px 18px 0;position:relative"></div>
          <div class="chart-wrap" id="heroBars" style="flex:none;height:64px;padding:0 18px 10px;border-top:1px solid var(--line-soft)"></div>
        </div>
      </div>

      <div class="pane pane-fill" style="padding-top:6px">
        <div class="split split-h grow" data-split="dashboard.lower">
          <div class="pane pane-sized" data-size="440" data-min="320" data-max="640" style="padding-right:6px">
            <div class="split split-v grow" data-split="dashboard.products">
              <div class="pane pane-fill">
                <div class="panel grow">
                  <div class="panel-head">
                    <div class="h2 grow">Top Products</div>
                    <span class="tiny muted">by revenue</span>
                  </div>
                  <div class="panel-body" id="topProducts" style="padding:6px 10px"></div>
                </div>
              </div>
              <div class="pane pane-sized" data-size="210" data-min="150" data-max="340" style="padding-top:6px">
                <div class="panel grow">
                  <div class="panel-head"><div class="h2 grow">Revenue by Day of Week</div></div>
                  <div class="chart-wrap col" id="weekdayChart" style="padding:12px 16px"></div>
                </div>
              </div>
            </div>
          </div>

          <div class="pane pane-fill" style="padding-left:6px">
            <div class="split split-v grow" data-split="dashboard.customers">
              <div class="pane pane-sized" data-size="250" data-min="190" data-max="400">
                <div class="panel grow">
                  <div class="panel-head"><div class="h2 grow">Revenue Intensity, Day by Hour</div></div>
                  <div class="panel-body" id="heatmap" style="padding:12px 16px"></div>
                </div>
              </div>
              <div class="pane pane-fill" style="padding-top:6px">
                <div class="split split-h grow" data-split="dashboard.money">
                  <div class="pane pane-fill">
                    <div class="panel grow">
                      <div class="panel-head">
                        <div class="h2 grow">Collected vs On Credit</div>
                        <span class="tiny muted" id="ccSub"></span>
                      </div>
                      <div class="panel-body" id="cashCredit" style="padding:16px"></div>
                    </div>
                  </div>
                  <div class="pane pane-sized" data-size="290" data-min="230" data-max="420" style="padding-left:6px">
                    <div class="panel grow">
                      <div class="panel-head"><div class="h2 grow">Money Owed, By Age</div></div>
                      <div class="panel-body" id="ageing" style="padding:14px 16px"></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    </div>

    <div class="pane pane-sized" data-collapsed="1" data-size="380" data-min="280" data-max="640" style="padding-top:6px">
      <div class="panel grow">
        <div class="panel-head" style="flex-wrap:wrap;row-gap:8px">
          <div class="h2">Custom chart</div>
          <span class="tiny muted grow" id="xrTotal"></span>
          <button class="btn btn-ghost btn-sm btn-icon" id="xrSaveBtn" title="Save this view">${icon('save', 14)}</button>
          <button class="btn btn-ghost btn-sm btn-icon" id="xrExportBtn" title="Export as CSV">${icon('download', 14)}</button>
        </div>
        <div class="panel-body col gap3" style="padding:14px 16px;min-height:0">
          <div class="row gap3 wrap">
            <div class="field" style="width:170px">
              <label class="label">Group by</label>
              <select class="input" id="xrX"></select>
            </div>
            <div class="field" style="width:170px">
              <label class="label">Measure</label>
              <select class="input" id="xrY"></select>
            </div>
            <div class="field" style="width:160px">
              <label class="label">Chart type</label>
              <select class="input" id="xrChart"></select>
            </div>
            <div class="field" id="xrLimitField" style="width:84px">
              <label class="label">Top N</label>
              <input class="input mono" id="xrLimit" value="10" autocomplete="off">
            </div>
            <div class="field grow" style="min-width:180px">
              <label class="label">Saved views</label>
              <select class="input" id="xrSaved"></select>
            </div>
          </div>
          <div class="tiny muted" id="xrHint" style="min-height:14px"></div>
          <div class="chart-wrap" id="xrHost" style="min-height:200px;position:relative"></div>
        </div>
      </div>
    </div>
    </div>
  </div>`;

  S.el = {
    kpis: q('#kpis', root),
    heroSub: q('#heroSub', root),
    heroChart: q('#heroChart', root),
    heroBars: q('#heroBars', root),
    topProducts: q('#topProducts', root),
    weekdayChart: q('#weekdayChart', root),
    heatmap: q('#heatmap', root),
    cashCredit: q('#cashCredit', root),
    ccSub: q('#ccSub', root),
    ageing: q('#ageing', root),
  };

  initCustomChart();
  showSkeletons();
}

function showSkeletons() {
  paintKpiSkeleton();
  [S.el.heroChart, S.el.heroBars, S.el.topProducts, S.el.weekdayChart, S.el.heatmap, S.el.cashCredit, S.el.ageing, S.xr.el.host]
    .forEach(elm => { elm.innerHTML = `<div class="skel" style="width:100%;height:100%;min-height:56px"></div>`; });
}

/* ============================ data ============================ */
async function load() {
  try {
    const data = await api.dashboard(S.range, S.month);
    if (!S) return;               // view was left while awaiting
    S.data = data;
    renderKPIs(data);
    renderHero(data);
    renderTopProducts(data);
    renderWeekday(data);
    renderHeatmap(data);
    renderCashCredit(data);
    renderAgeing(data);
    loadCustomChart();           // every panel — including the builder — follows the same range/month
  } catch (e) {
    if (!S) return;
    toast('Could not load the dashboard', e.message, 'bad');
    S.el.heroChart.innerHTML = emptyState('warn', 'Could not load this data', e.message || 'Please try again.');
    S.el.heroBars.innerHTML = '';
  }
}

function wireResize() {
  const redraw = debounce(() => {
    if (S?.data) renderHero(S.data);
    if (S?.xr?.data && (S.xr.chart === 'line' || S.xr.chart === 'area')) renderCustomChart();
  }, 100);
  S.onResize = redraw;
  window.addEventListener('nova:resize', redraw);
  if (window.ResizeObserver) {
    S.ro = new ResizeObserver(redraw);
    S.ro.observe(S.el.heroChart);
    S.ro.observe(S.el.heroBars);
    S.ro.observe(S.xr.el.host);
  }
}

/* ============================ KPI tiles ============================ */
function kpiKeys() {
  const keys = ['revenue', 'bills', 'avg'];
  if (S.ctx.app.flags.khata) keys.push('outstanding');
  if (S.ctx.app.flags.stock) keys.push('low_stock');
  return keys;
}

function toneStyle(tone) {
  return {
    primary: 'background:var(--accent-soft);color:var(--accent-ink)',
    neutral: 'background:var(--surface-2);color:var(--ink-3)',
    danger: 'background:var(--bad-soft);color:var(--bad-ink)',
    success: 'background:var(--ok-soft);color:var(--ok-ink)',
    warning: 'background:var(--warn-soft);color:var(--warn-ink)',
  }[tone] || 'background:var(--surface-2);color:var(--ink-3)';
}

function sparkColor(tone) {
  return { danger: 'var(--bad)', warning: 'var(--warn)', success: 'var(--ok)' }[tone] || 'var(--accent)';
}

function deltaSentence(pct) {
  if (pct == null || !isFinite(pct)) return '';
  if (Math.abs(pct) < 1) return 'about the same as last period';
  return `${pct > 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(0)}% on last period`;
}

function deltaChip(pct) {
  if (pct == null || !isFinite(pct) || Math.abs(pct) < 1) return '';
  const up = pct > 0;
  return `<span class="delta ${up ? 'delta-up' : 'delta-down'}">${icon(up ? 'arrowUp' : 'arrowDown', 11)}${Math.abs(pct).toFixed(0)}%</span>`;
}

function hintText(key, k) {
  // "All time" has no previous period to compare against — a delta chip
  // would be a made-up number, so these captions never mention one.
  if (S.range === 'all') {
    switch (key) {
      case 'revenue': return 'across every bill on record';
      case 'bills': return 'since the very first bill';
      case 'avg': return k.avg ? 'across every sale' : 'no bills yet';
      case 'outstanding': return (k.outstanding || 0) > 0.009
        ? `across ${k.outstanding_accounts || 0} khata${k.outstanding_accounts === 1 ? '' : 's'}` : 'all settled';
      case 'low_stock': return (k.low_stock || 0) > 0 ? 'need restocking' : 'all stocked';
      default: return '';
    }
  }
  switch (key) {
    case 'revenue': return deltaSentence(k.revenue_delta) || 'first period on record';
    case 'bills': return deltaSentence(k.bills_delta) || 'first period on record';
    case 'avg': return k.avg ? (deltaSentence(k.avg_delta) || 'first period on record') : 'no bills yet';
    case 'outstanding': return (k.outstanding || 0) > 0.009
      ? `across ${k.outstanding_accounts || 0} khata${k.outstanding_accounts === 1 ? '' : 's'}` : 'all settled';
    case 'low_stock': return (k.low_stock || 0) > 0 ? 'need restocking' : 'all stocked';
    default: return '';
  }
}

/** Tiny inline area+line sparkline. Flat data (e.g. a single number repeated)
    reads honestly as a flat line rather than fabricating a trend. */
function sparkline(values, { w = 62, h = 22, color = 'var(--accent)' } = {}) {
  let vals = (values || []).filter(v => isFinite(v));
  if (vals.length < 2) vals = [vals[0] ?? 0, vals[0] ?? 0];
  const pad = 2;
  const min = Math.min(...vals), max = Math.max(...vals), span = (max - min) || 1;
  const step = (w - pad * 2) / (vals.length - 1);
  const pts = vals.map((v, i) => [pad + i * step, pad + (1 - (v - min) / span) * (h - pad * 2)]);
  const line = pts.map(p => p.join(',')).join(' ');
  const area = `M${pts[0][0]},${h} L${line.replace(/ /g, ' L')} L${pts[pts.length - 1][0]},${h} Z`;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${area}" fill="${color}" opacity=".14"></path>
    <polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></polyline>
  </svg>`;
}

function tileHTML(key, i, k, sd) {
  const def = TILE_DEF[key], tone = TONE[key](k);
  let value, deltaPct, series;
  switch (key) {
    case 'revenue': value = inrShort(k.revenue || 0); deltaPct = k.revenue_delta; series = sd.rev; break;
    case 'bills': value = String(k.bills ?? 0); deltaPct = k.bills_delta; series = sd.bills; break;
    case 'avg': value = k.avg ? inrShort(k.avg) : '—'; deltaPct = k.avg ? k.avg_delta : null; series = sd.avg; break;
    case 'outstanding': value = inrShort(k.outstanding || 0); series = sd.ageing; break;
    case 'low_stock': value = String(k.low_stock ?? 0); series = sd.flat; break;
  }
  return `
  <div class="tile" data-k="${key}" style="--i:${i}">
    <div class="row between">
      <div class="tile-ico" style="${toneStyle(tone)}">${icon(def.icon, 15)}</div>
      ${deltaChip(deltaPct)}
    </div>
    <div class="small muted" style="margin-top:8px">${esc(def.label())}</div>
    <div class="tile-val mono">${esc(value)}</div>
    <div class="row between" style="margin-top:8px">
      <span class="tiny muted ellipsis" style="min-width:0">${esc(hintText(key, k))}</span>
      <span style="flex:none">${sparkline(series, { color: sparkColor(tone) })}</span>
    </div>
  </div>`;
}

function paintKpiSkeleton() {
  const keys = kpiKeys();
  S.el.kpis.innerHTML = keys.map((key, i) => `
    <div class="tile" data-k="${key}" style="--i:${i}">
      <div class="row between">
        <div class="tile-ico" style="background:var(--surface-2);color:var(--ink-3)">${icon(TILE_DEF[key].icon, 15)}</div>
      </div>
      <div class="small muted" style="margin-top:8px">${esc(TILE_DEF[key].label())}</div>
      <div class="skel" style="width:64%;height:24px;margin-top:9px"></div>
      <div class="row between" style="margin-top:10px">
        <span class="skel" style="width:72px;height:12px"></span>
        <span class="skel" style="width:58px;height:20px"></span>
      </div>
    </div>`).join('');
}

function renderKPIs(data) {
  const k = data.kpis || {};
  const daily = data.daily || [];
  const sd = {
    rev: daily.map(d => d.revenue),
    bills: daily.map(d => d.bills),
    avg: daily.map(d => d.bills ? d.revenue / d.bills : 0),
    ageing: (data.ageing || []).slice().reverse().map(a => a.amount),
    flat: [k.low_stock || 0, k.low_stock || 0],
  };
  S.el.kpis.innerHTML = kpiKeys().map((key, i) => tileHTML(key, i, k, sd)).join('');
}

/* ============================ hero: revenue trend ============================ */
function smoothPath(pts) {
  if (pts.length < 3) return 'M' + pts.map(p => p.join(',')).join(' L');
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`;
  }
  return d;
}

function renderHero(data) {
  const daily = data.daily || [];
  S.el.heroSub.textContent = daily.length ? `${daily.length} trading day${daily.length === 1 ? '' : 's'}` : '';

  if (!daily.length) {
    S.el.heroChart.innerHTML = emptyState('chart', 'No sales in this period', 'Daily revenue and bill counts appear here once bills are saved.');
    S.el.heroBars.innerHTML = '';
    return;
  }
  if (daily.length < 4) {
    const total = daily.reduce((s, d) => s + d.revenue, 0);
    const bills = daily.reduce((s, d) => s + d.bills, 0);
    S.el.heroChart.innerHTML = `<div class="col center grow" style="gap:6px;text-align:center;height:100%">
      <div class="tile-val mono" style="font-size:var(--t-30)">${esc(inr(total))}</div>
      <div class="small muted" style="max-width:320px">across ${daily.length} day${daily.length === 1 ? '' : 's'} · ${bills} bill${bills === 1 ? '' : 's'} — not enough days yet for a trend line</div>
    </div>`;
    S.el.heroBars.innerHTML = '';
    return;
  }
  drawHero(daily);
}

function drawHero(daily) {
  const host = S.el.heroChart, barsHost = S.el.heroBars;
  if (!host.isConnected) return;
  const rect = host.getBoundingClientRect();
  const W = Math.max(240, Math.round(rect.width)), H = Math.max(90, Math.round(rect.height));
  const padL = 48, padR = 10, padT = 10, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = daily.length;
  const xs = (i) => padL + (n > 1 ? i * (plotW / (n - 1)) : plotW / 2);
  const maxRev = Math.max(...daily.map(d => d.revenue), 1);
  const ys = (v) => padT + plotH - (v / maxRev) * plotH;

  const pts = daily.map((d, i) => [xs(i), ys(d.revenue)]);
  const linePath = smoothPath(pts);
  const areaPath = `${linePath} L${pts[pts.length - 1][0]},${padT + plotH} L${pts[0][0]},${padT + plotH} Z`;

  const ticks = 4;
  let gridSvg = '';
  for (let t = 0; t <= ticks; t++) {
    const v = maxRev * t / ticks, y = ys(v);
    gridSvg += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"></line>`;
    gridSvg += `<text class="axis-lbl" x="${padL - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(inrShort(v).replace('Rs. ', ''))}</text>`;
  }

  const targetLabels = Math.max(2, Math.floor(plotW / 64));
  const step = Math.max(1, Math.round(n / targetLabels));
  let xLabelSvg = '';
  daily.forEach((d, i) => {
    if (i % step !== 0 && i !== n - 1) return;
    // the final date is always drawn, so drop any stepped label that would
    // collide with it rather than letting two dates overlap
    if (i !== n - 1 && (n - 1 - i) < step * 0.7) return;
    xLabelSvg += `<text class="axis-lbl" x="${xs(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(dmy(d.date, true))}</text>`;
  });

  host.innerHTML = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="heroFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity=".22"></stop>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      ${gridSvg}${xLabelSvg}
      <path d="${areaPath}" fill="url(#heroFill)" stroke="none"></path>
      <path d="${linePath}" fill="none" stroke="var(--accent)" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"></path>
      <g id="heroCross" style="opacity:0">
        <line x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--ink-4)" stroke-width="1" stroke-dasharray="3,3"></line>
        <circle r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"></circle>
      </g>
      <rect id="heroOverlay" x="${padL}" y="0" width="${Math.max(1, plotW)}" height="${H}" fill="transparent"></rect>
    </svg>
    <div id="heroTip" style="position:absolute;display:none;pointer-events:none;
      background:var(--ink);color:var(--ink-invert);border-radius:var(--r-md);
      box-shadow:var(--sh-3);padding:7px 10px;font-size:var(--t-12);line-height:1.5;white-space:nowrap;z-index:20"></div>`;

  const maxBills = Math.max(...daily.map(d => d.bills), 1);
  const bh = Math.max(28, Math.round(barsHost.getBoundingClientRect().height) || 44);
  const barW = Math.max(2, (plotW / n) * 0.6);
  let barsSvg = '';
  daily.forEach((d, i) => {
    const bx = xs(i), hgt = (d.bills / maxBills) * (bh - 8);
    barsSvg += `<rect data-i="${i}" x="${(bx - barW / 2).toFixed(1)}" y="${(bh - 4 - hgt).toFixed(1)}" width="${barW.toFixed(1)}" height="${hgt.toFixed(1)}" rx="1.5" fill="var(--accent-soft-2)"></rect>`;
  });
  barsHost.innerHTML = `<svg width="${W}" height="${bh}" viewBox="0 0 ${W} ${bh}" preserveAspectRatio="none">${barsSvg}</svg>`;

  wireHeroHover({ host, barsHost, daily, xs, ys, padL, plotW, n });
}

function wireHeroHover({ host, barsHost, daily, xs, ys, padL, plotW, n }) {
  const overlay = q('#heroOverlay', host);
  const cross = q('#heroCross', host);
  const dot = cross.querySelector('circle');
  const line = cross.querySelector('line');
  const tip = q('#heroTip', host);
  const step = n > 1 ? plotW / (n - 1) : 0;
  const barRects = [...barsHost.querySelectorAll('rect')];

  const move = (e) => {
    const r = host.getBoundingClientRect();
    const mx = e.clientX - r.left;
    let i = step ? Math.round((mx - padL) / step) : 0;
    i = Math.max(0, Math.min(n - 1, i));
    const d = daily[i];
    const x = xs(i), y = ys(d.revenue);

    cross.style.opacity = '1';
    line.setAttribute('x1', x); line.setAttribute('x2', x);
    dot.setAttribute('cx', x); dot.setAttribute('cy', y);

    tip.style.display = 'block';
    tip.innerHTML = `<div style="font-weight:650;margin-bottom:3px">${esc(dmy(d.date))}</div>
      <div class="mono">Revenue&nbsp; ${esc(inr(d.revenue))}</div>
      <div class="mono">Bills&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; ${d.bills}</div>`;
    let tx = x + 12, ty = y - 12;
    const tw = tip.offsetWidth, th = tip.offsetHeight, hw = host.clientWidth, hh = host.clientHeight;
    if (tx + tw > hw) tx = x - tw - 12;
    if (ty < 0) ty = 4;
    if (ty + th > hh) ty = hh - th - 4;
    tip.style.left = tx + 'px'; tip.style.top = ty + 'px';

    barRects.forEach(rc => rc.setAttribute('fill', +rc.dataset.i === i ? 'var(--accent)' : 'var(--accent-soft-2)'));
  };
  const leave = () => {
    cross.style.opacity = '0';
    tip.style.display = 'none';
    barRects.forEach(rc => rc.setAttribute('fill', 'var(--accent-soft-2)'));
  };
  overlay.addEventListener('mousemove', move);
  overlay.addEventListener('mouseleave', leave);
}

/* ============================ top products ============================ */
function renderTopProducts(data) {
  const items = data.top_products || [];
  const host = S.el.topProducts;
  if (!items.length) {
    host.innerHTML = emptyState('box', 'Nothing sold in this period', 'Your best sellers by volume and by value appear here.');
    return;
  }
  const max = Math.max(...items.map(p => p.revenue), 1);
  host.innerHTML = items.map((p, i) => `
    <div class="rank-row">
      <div class="rank-n">${i + 1}</div>
      <div class="col grow" style="gap:4px;min-width:0">
        <div class="row between gap2">
          <span class="small ellipsis" title="${esc(p.name)}">${esc(p.name)}</span>
          <span class="small mono strong" style="flex:none">${esc(inr(p.revenue))}</span>
        </div>
        <div class="bar"><i style="width:${Math.max(2, (p.revenue / max) * 100)}%"></i></div>
      </div>
      <span class="tiny muted mono" style="flex:none;width:64px;text-align:right">${esc(qty(p.qty))} u</span>
    </div>`).join('');
}

/* ============================ weekday bars ============================ */
function renderWeekday(data) {
  const wk = data.weekday || [];
  const host = S.el.weekdayChart;
  if (!wk.length || !wk.some(d => d.revenue > 0)) {
    host.innerHTML = emptyState('chart', 'No sales in this period', 'This shows which days of the week carry the business.');
    return;
  }
  const max = Math.max(...wk.map(d => d.revenue), 1);
  let peak = 0;
  wk.forEach((d, i) => { if (d.revenue > wk[peak].revenue) peak = i; });
  const bars = wk.map((d, i) => `<i style="height:${Math.max(3, (d.revenue / max) * 100)}%;
    background:${i === peak ? 'var(--accent)' : 'var(--accent-soft-2)'}"
    title="${esc(d.day)}${'\n'}Revenue ${esc(inr(d.revenue))}"></i>`).join('');
  const labels = wk.map(d => `<span class="tiny muted" style="flex:1;text-align:center">${esc(d.day)}</span>`).join('');
  host.innerHTML = `<div class="bars grow">${bars}</div><div class="row" style="margin-top:6px">${labels}</div>`;
}

/* ============================ heatmap ============================ */
function renderHeatmap(data) {
  const grid = data.heatmap || [];
  const host = S.el.heatmap;
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const nCols = grid[0]?.length || 0;
  const flatMax = Math.max(0, ...grid.flat());
  if (!grid.length || !nCols || !flatMax) {
    host.innerHTML = emptyState('chart', 'No sales in this period', 'Busy blocks of the week appear here once there are bills to place.');
    return;
  }
  const startHour = 8;
  const hourLabel = (h) => { const ap = h >= 12 ? 'p' : 'a'; return `${((h + 11) % 12) + 1}${ap}`; };

  let rows = `<div></div>`;
  for (let c = 0; c < nCols; c++) rows += `<div class="tiny muted" style="text-align:center">${esc(hourLabel(startHour + c))}</div>`;
  days.forEach((day, r) => {
    rows += `<div class="tiny muted">${esc(day)}</div>`;
    for (let c = 0; c < nCols; c++) {
      const v = grid[r]?.[c] || 0;
      const op = (0.08 + (v / flatMax) * 0.84).toFixed(2);
      rows += `<i style="background:var(--accent);opacity:${op}" title="${esc(day)} ${esc(hourLabel(startHour + c))}${'\n'}Revenue ${esc(inr(v))}"></i>`;
    }
  });
  host.innerHTML = `<div class="heat" style="grid-template-columns:32px repeat(${nCols},1fr)">${rows}</div>`;
}

/* ============================ collected vs credit ============================ */
function renderCashCredit(data) {
  const host = S.el.cashCredit, sub = S.el.ccSub;
  if (!S.ctx.app.flags.khata) {
    host.innerHTML = emptyState('rupee', 'Ledger tracking is off', 'Turn on Khata / Ledger in Settings to see collected vs credit here.');
    sub.textContent = '';
    return;
  }
  const cc = data.cash_credit || { collected: 0, credit: 0 };
  const billed = (cc.collected || 0) + (cc.credit || 0);
  if (billed <= 0) {
    host.innerHTML = emptyState('rupee', 'Nothing billed yet', 'Once you save a bill, this shows how much of it you actually collected.');
    sub.textContent = '';
    return;
  }
  const pctCollected = (cc.collected / billed) * 100;
  sub.textContent = `${Math.round(pctCollected)}% collected`;
  const wCredit = 100 - pctCollected;
  host.innerHTML = `
    <div style="display:flex;height:38px;border-radius:var(--r-md);overflow:hidden;background:var(--surface-2)">
      ${pctCollected > 0 ? `<div style="width:${pctCollected}%;height:100%;background:var(--ok);
        display:flex;align-items:center;justify-content:center;color:var(--ink-invert);font-size:var(--t-12);font-weight:650">
        ${pctCollected >= 8 ? esc(inrShort(cc.collected)) : ''}</div>` : ''}
      ${wCredit > 0 ? `<div style="width:${wCredit}%;height:100%;background:var(--warn);
        display:flex;align-items:center;justify-content:center;color:var(--ink-invert);font-size:var(--t-12);font-weight:650">
        ${wCredit >= 8 ? esc(inrShort(cc.credit)) : ''}</div>` : ''}
    </div>
    <div class="legend" style="margin-top:14px">
      <span><i style="background:var(--ok)"></i>Collected</span>
      <span><i style="background:var(--warn)"></i>On credit</span>
    </div>`;
}

/* ============================ receivables ageing ============================ */
function renderAgeing(data) {
  const host = S.el.ageing;
  if (!S.ctx.app.flags.khata) {
    host.innerHTML = emptyState('card', 'Ledger tracking is off', 'Turn on Khata / Ledger in Settings to see receivables ageing here.');
    return;
  }
  const rows = data.ageing || [];
  const total = rows.reduce((s, r) => s + (r.amount || 0), 0);
  if (!rows.length || total <= 0) {
    host.innerHTML = emptyState('check', 'Nothing outstanding', 'Every customer has settled up.');
    return;
  }
  const colors = ['var(--ok)', 'var(--warn)', 'var(--warn-ink)', 'var(--bad)'];
  const max = Math.max(...rows.map(r => r.amount), 1);
  host.innerHTML = `<div class="col gap3">${rows.map((r, i) => `
    <div class="col" style="gap:4px">
      <div class="row between">
        <span class="tiny muted">${esc(r.bucket)}</span>
        <span class="tiny mono strong">${esc(inrShort(r.amount))}</span>
      </div>
      <div class="bar"><i style="width:${Math.max(2, (r.amount / max) * 100)}%;background:${colors[i] || 'var(--accent)'}"></i></div>
    </div>`).join('')}</div>`;
}

/* ============================ custom chart builder ============================
   Lets the user plot any x (grouping) against any y (measure) the backend
   supports. Only bar/line/area/hbar/donut combinations that actually make
   sense for the chosen grouping are offered — the rest stay in the list,
   disabled, with the reason shown underneath rather than just vanishing.
   Follows the dashboard's own date range/month, exactly like every other
   panel on the screen (see load()'s call into loadCustomChart()). */

const XR_X = [
  { key: 'date', label: 'Date (day)' },
  { key: 'month', label: 'Month' },
  { key: 'weekday', label: 'Day of week' },
  { key: 'hour', label: 'Hour of day' },
  { key: 'customer', label: 'Customer' },
  { key: 'product', label: 'Product' },
  { key: 'category', label: 'Product category' },
  { key: 'payment_status', label: 'Payment status' },
  { key: 'bill_type', label: 'Bill type' },
];
const XR_Y = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'bills', label: 'Bill count' },
  { key: 'items_sold', label: 'Items sold' },
  { key: 'quantity', label: 'Quantity' },
  { key: 'avg_bill', label: 'Average bill value' },
  { key: 'collected', label: 'Amount collected' },
  { key: 'outstanding', label: 'Outstanding' },
];
const XR_CHARTS = [
  { key: 'bar', label: 'Bar' },
  { key: 'line', label: 'Line' },
  { key: 'area', label: 'Area' },
  { key: 'hbar', label: 'Horizontal bar' },
  { key: 'donut', label: 'Donut' },
];
// date/month read as a trend; weekday/hour are ordered but cyclical;
// everything else is a plain, unordered category.
const XR_KIND = {
  date: 'time', month: 'time', weekday: 'cycle', hour: 'cycle',
  customer: 'cat', product: 'cat', category: 'cat', payment_status: 'cat', bill_type: 'cat',
};
const XR_CHARTS_BY_KIND = {
  time: ['bar', 'line', 'area'],
  cycle: ['bar', 'line', 'area', 'hbar'],
  cat: ['bar', 'hbar', 'donut'],
};
const XR_KIND_HINT = {
  time: "Horizontal bar and donut aren't offered here — neither can show a trend over time.",
  cycle: "Donut isn't offered here — it would lose the natural order of the days or hours.",
  cat: "Line and area aren't offered here — they'd imply an order between categories that isn't there.",
};
const XR_MONEY_Y = new Set(['revenue', 'avg_bill', 'collected', 'outstanding']);
const XR_TOPN_X = new Set(['customer', 'product', 'category']);
const XR_DONUT_PALETTE = ['var(--accent)', 'var(--info)', 'var(--ok)', 'var(--warn)', 'var(--bad)',
  'var(--accent-ink)', 'var(--info-ink)', 'var(--ok-ink)', 'var(--warn-ink)', 'var(--bad-ink)'];

const xrChartAllowed = (x, chart) => (XR_CHARTS_BY_KIND[XR_KIND[x]] || []).includes(chart);
const xrFmt = (yKey, v) => XR_MONEY_Y.has(yKey) ? inr(v) : qty(v);
const xrFmtShort = (yKey, v) => XR_MONEY_Y.has(yKey) ? inrShort(v).replace('Rs. ', '') : qty(v);

function xrAxisLabel(x, label) {
  if (x === 'date') return dmy(label, true);
  if (x === 'month') {
    const [y, m] = String(label).split('-');
    return `${MONTHS_LONG[+m - 1]?.slice(0, 3) || m} ${String(y).slice(2)}`;
  }
  return label;
}

function xrSavedViews() { return prefs.get('dash.customCharts', []); }

function initCustomChart() {
  S.xr = {
    x: 'date', y: 'revenue', chart: 'line', limit: 10, savedName: '', data: null,
    el: {
      x: q('#xrX', S.root), y: q('#xrY', S.root), chart: q('#xrChart', S.root),
      limit: q('#xrLimit', S.root), limitField: q('#xrLimitField', S.root),
      saved: q('#xrSaved', S.root), hint: q('#xrHint', S.root),
      total: q('#xrTotal', S.root), host: q('#xrHost', S.root),
    },
  };
  const xr = S.xr, e = xr.el;

  e.x.innerHTML = XR_X.map(o => `<option value="${o.key}">${esc(o.label)}</option>`).join('');
  e.y.innerHTML = XR_Y.map(o => `<option value="${o.key}">${esc(o.label)}</option>`).join('');
  e.x.value = xr.x; e.y.value = xr.y;
  xrPopulateChartOptions();
  xrRefreshLimitVisibility();
  xrPopulateSavedViews();

  e.x.addEventListener('change', () => {
    xr.x = e.x.value; xr.savedName = ''; e.saved.value = '';
    xrPopulateChartOptions(); xrRefreshLimitVisibility(); loadCustomChart();
  });
  e.y.addEventListener('change', () => { xr.y = e.y.value; xr.savedName = ''; e.saved.value = ''; loadCustomChart(); });
  e.chart.addEventListener('change', () => { xr.chart = e.chart.value; xr.savedName = ''; e.saved.value = ''; renderCustomChart(); });
  e.limit.addEventListener('input', debounce(() => {
    xr.limit = Math.max(1, Math.min(50, parseInt(e.limit.value, 10) || 10));
    xr.savedName = ''; e.saved.value = '';
    loadCustomChart();
  }, 400));
  e.saved.addEventListener('change', () => xrApplySavedView(e.saved.value));
  q('#xrSaveBtn', S.root).onclick = () => xrSaveCurrentView();
  q('#xrExportBtn', S.root).onclick = () => xrExportCurrentView();
}

function xrPopulateChartOptions() {
  const xr = S.xr;
  xr.el.chart.innerHTML = XR_CHARTS.map(c => {
    const allowed = xrChartAllowed(xr.x, c.key);
    return `<option value="${c.key}" ${allowed ? '' : 'disabled'}>${esc(c.label)}${allowed ? '' : ' — not for this grouping'}</option>`;
  }).join('');
  if (!xrChartAllowed(xr.x, xr.chart)) {
    xr.chart = XR_CHARTS_BY_KIND[XR_KIND[xr.x]][0];
  }
  xr.el.chart.value = xr.chart;
  const hidden = XR_CHARTS.some(c => !xrChartAllowed(xr.x, c.key));
  xr.el.hint.textContent = hidden ? XR_KIND_HINT[XR_KIND[xr.x]] : '';
}

function xrRefreshLimitVisibility() {
  S.xr.el.limitField.classList.toggle('hidden', !XR_TOPN_X.has(S.xr.x));
}

function xrPopulateSavedViews() {
  const list = xrSavedViews();
  S.xr.el.saved.innerHTML = `<option value="">— New chart —</option>` +
    list.map(v => `<option value="${esc(v.name)}">${esc(v.name)}</option>`).join('');
  S.xr.el.saved.value = S.xr.savedName || '';
}

function xrApplySavedView(name) {
  const xr = S.xr;
  if (!name) { xr.savedName = ''; return; }
  const v = xrSavedViews().find(v => v.name === name);
  if (!v) return;
  xr.x = v.x; xr.y = v.y; xr.chart = v.chart; xr.limit = v.limit || 10; xr.savedName = name;
  xr.el.x.value = xr.x; xr.el.y.value = xr.y; xr.el.limit.value = xr.limit;
  xrPopulateChartOptions();
  xr.el.chart.value = xr.chart;   // the saved chart type wins even if another type is also valid
  xrRefreshLimitVisibility();
  loadCustomChart();
}

async function xrSaveCurrentView() {
  const xr = S.xr;
  const body = node(`<div class="field">
    <label class="label">Name this view</label>
    <input class="input" id="xrSaveName" autocomplete="off" placeholder="e.g. Revenue by customer" value="${esc(xr.savedName || '')}">
  </div>`);
  const saved = await modal({
    title: 'Save chart view', icon: 'save', body,
    actions: [
      { label: 'Cancel', value: false },
      {
        label: 'Save', cls: 'btn-primary', default: true,
        onClick: () => {
          const name = q('#xrSaveName', body).value.trim();
          if (!name) { toast('Name required', 'Give this view a short name first.', 'warn'); return false; }
          const list = xrSavedViews().filter(v => v.name !== name);
          list.push({ name, x: xr.x, y: xr.y, chart: xr.chart, limit: xr.limit });
          prefs.set('dash.customCharts', list);
          xr.savedName = name;
          return true;
        },
      },
    ],
  });
  if (saved) { xrPopulateSavedViews(); toast('Saved', 'This chart view is ready in the dropdown next time.', 'ok'); }
}

async function xrExportCurrentView() {
  try {
    const path = await api.export_custom_report(xrSpec());
    toast('Exported', `Chart data saved to ${path}`, 'ok');
  } catch (e) {
    toast('Could not export the chart', e.message, 'bad');
  }
}

function xrSpec() {
  const period = S.data?.period || {};
  return { x: S.xr.x, y: S.xr.y, limit: S.xr.limit, date_from: period.from, date_to: period.to };
}

async function loadCustomChart() {
  if (!S?.xr) return;
  const xr = S.xr;
  xr.el.host.innerHTML = `<div class="skel" style="width:100%;height:100%;min-height:160px"></div>`;
  try {
    const res = await api.custom_report(xrSpec());
    if (!S) return;
    xr.data = res;
    xr.el.total.textContent = res.rows.length
      ? `${res.rows.length} ${res.rows.length === 1 ? 'group' : 'groups'} · total ${esc(xrFmt(xr.y, res.total))}` : '';
    renderCustomChart();
  } catch (e) {
    if (!S) return;
    xr.el.host.innerHTML = emptyState('warn', 'Could not build this chart', e.message || 'Please try again.');
  }
}

function renderCustomChart() {
  const xr = S?.xr;
  if (!xr?.data) return;
  const host = xr.el.host, rows = xr.data.rows || [];
  if (!rows.length || !rows.some(r => Math.abs(r.value) > 1e-9)) {
    host.innerHTML = emptyState('chart', 'Nothing to show yet', 'Once there are matching bills, this chart fills in.');
    return;
  }
  if (xr.chart === 'bar') xrDrawBars(host, rows);
  else if (xr.chart === 'hbar') xrDrawHBars(host, rows);
  else if (xr.chart === 'donut') xrDrawDonut(host, rows);
  else xrDrawLineArea(host, rows, xr.chart === 'area');
}

function xrDrawBars(host, rows) {
  const x = S.xr.x, y = S.xr.y;
  const max = Math.max(...rows.map(r => Math.abs(r.value)), 1);
  let peak = 0;
  rows.forEach((r, i) => { if (Math.abs(r.value) > Math.abs(rows[peak].value)) peak = i; });
  const bars = rows.map((r, i) => `<i style="height:${Math.max(3, Math.abs(r.value) / max * 100)}%;
    background:${i === peak ? 'var(--accent)' : 'var(--accent-soft-2)'}"
    title="${esc(xrAxisLabel(x, r.label))}${'\n'}${esc(xrFmt(y, r.value))}"></i>`).join('');
  const showLabels = rows.length <= 16;
  const labels = showLabels ? rows.map(r => `<span class="tiny muted ellipsis" style="flex:1;text-align:center;min-width:0" title="${esc(r.label)}">${esc(xrAxisLabel(x, r.label))}</span>`).join('') : '';
  host.innerHTML = `<div class="col grow" style="min-height:0;height:100%">
    <div class="bars grow">${bars}</div>
    ${showLabels ? `<div class="row" style="margin-top:6px">${labels}</div>` : ''}
  </div>`;
}

function xrDrawHBars(host, rows) {
  const x = S.xr.x, y = S.xr.y;
  const max = Math.max(...rows.map(r => Math.abs(r.value)), 1);
  host.innerHTML = `<div class="col gap3 scroll-y" style="height:100%">${rows.map(r => `
    <div class="col" style="gap:4px">
      <div class="row between gap2">
        <span class="small ellipsis" title="${esc(r.label)}">${esc(xrAxisLabel(x, r.label))}</span>
        <span class="tiny mono strong" style="flex:none">${esc(xrFmt(y, r.value))}</span>
      </div>
      <div class="bar"><i style="width:${Math.max(2, Math.abs(r.value) / max * 100)}%"></i></div>
    </div>`).join('')}</div>`;
}

function xrDrawDonut(host, rows) {
  const x = S.xr.x, y = S.xr.y;
  const total = rows.reduce((s, r) => s + Math.max(0, r.value), 0) || 1;
  const R = 40, C = 2 * Math.PI * R, CX = 50, CY = 50;
  let offset = 0;
  const arcs = rows.map((r, i) => {
    const frac = Math.max(0, r.value) / total;
    const dash = frac * C;
    const seg = `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${XR_DONUT_PALETTE[i % XR_DONUT_PALETTE.length]}"
      stroke-width="16" stroke-dasharray="${dash.toFixed(2)} ${(C - dash).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${CX} ${CY})">
      <title>${esc(r.label)}: ${esc(xrFmt(y, r.value))} (${(frac * 100).toFixed(1)}%)</title></circle>`;
    offset += dash;
    return seg;
  }).join('');
  const legend = rows.map((r, i) => `<span><i style="background:${XR_DONUT_PALETTE[i % XR_DONUT_PALETTE.length]}"></i>
    ${esc(xrAxisLabel(x, r.label))} · ${(Math.max(0, r.value) / total * 100).toFixed(0)}%</span>`).join('');
  host.innerHTML = `
    <div class="row grow" style="gap:18px;align-items:center;min-height:0;height:100%">
      <svg viewBox="0 0 100 100" style="width:min(200px,38%);flex:none">${arcs}</svg>
      <div class="legend" style="flex-direction:column;align-items:flex-start;gap:7px;overflow:auto;max-height:100%">${legend}</div>
    </div>`;
}

function xrDrawLineArea(host, rows, isArea) {
  if (!host.isConnected) return;
  const x = S.xr.x, y = S.xr.y;
  const rect = host.getBoundingClientRect();
  const W = Math.max(240, Math.round(rect.width)), H = Math.max(90, Math.round(rect.height));
  const padL = 54, padR = 10, padT = 10, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = rows.length;
  const xs = (i) => padL + (n > 1 ? i * (plotW / (n - 1)) : plotW / 2);
  const vals = rows.map(r => r.value);
  const maxV = Math.max(...vals, 0), minV = Math.min(...vals, 0);
  const span = (maxV - minV) || 1;
  const ys = (v) => padT + plotH - ((v - minV) / span) * plotH;

  const pts = rows.map((r, i) => [xs(i), ys(r.value)]);
  const linePath = 'M' + pts.map(p => p.join(',')).join(' L');
  const baseline = ys(Math.max(minV, 0));
  const areaPath = `${linePath} L${pts[pts.length - 1][0]},${baseline} L${pts[0][0]},${baseline} Z`;

  const ticks = 4;
  let gridSvg = '';
  for (let t = 0; t <= ticks; t++) {
    const v = minV + (span * t / ticks), yy = ys(v);
    gridSvg += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}"></line>`;
    gridSvg += `<text class="axis-lbl" x="${padL - 8}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${esc(xrFmtShort(y, v))}</text>`;
  }
  const targetLabels = Math.max(2, Math.floor(plotW / 70));
  const step = Math.max(1, Math.round(n / targetLabels));
  let xLabelSvg = '';
  rows.forEach((r, i) => {
    if (i % step !== 0 && i !== n - 1) return;
    if (i !== n - 1 && (n - 1 - i) < step * 0.7) return;
    xLabelSvg += `<text class="axis-lbl" x="${xs(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(xrAxisLabel(x, r.label))}</text>`;
  });

  host.innerHTML = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      ${isArea ? `<defs><linearGradient id="xrFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--accent)" stop-opacity=".22"></stop>
        <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"></stop>
      </linearGradient></defs>` : ''}
      ${gridSvg}${xLabelSvg}
      ${isArea ? `<path d="${areaPath}" fill="url(#xrFill)" stroke="none"></path>` : ''}
      <path d="${linePath}" fill="none" stroke="var(--accent)" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"></path>
      <g id="xrCross" style="opacity:0">
        <line x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--ink-4)" stroke-width="1" stroke-dasharray="3,3"></line>
        <circle r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"></circle>
      </g>
      <rect id="xrOverlay" x="${padL}" y="0" width="${Math.max(1, plotW)}" height="${H}" fill="transparent"></rect>
    </svg>
    <div id="xrTip" style="position:absolute;display:none;pointer-events:none;
      background:var(--ink);color:var(--ink-invert);border-radius:var(--r-md);
      box-shadow:var(--sh-3);padding:7px 10px;font-size:var(--t-12);line-height:1.5;white-space:nowrap;z-index:20"></div>`;

  xrWireHover({ host, rows, xs, ys, padL, plotW, n });
}

function xrWireHover({ host, rows, xs, ys, padL, plotW, n }) {
  const overlay = q('#xrOverlay', host);
  const cross = q('#xrCross', host);
  const dot = cross.querySelector('circle');
  const line = cross.querySelector('line');
  const tip = q('#xrTip', host);
  const step = n > 1 ? plotW / (n - 1) : 0;

  const move = (e) => {
    const r = host.getBoundingClientRect();
    const mx = e.clientX - r.left;
    let i = step ? Math.round((mx - padL) / step) : 0;
    i = Math.max(0, Math.min(n - 1, i));
    const row = rows[i];
    const x = xs(i), y = ys(row.value);

    cross.style.opacity = '1';
    line.setAttribute('x1', x); line.setAttribute('x2', x);
    dot.setAttribute('cx', x); dot.setAttribute('cy', y);

    tip.style.display = 'block';
    tip.innerHTML = `<div style="font-weight:650;margin-bottom:3px">${esc(xrAxisLabel(S.xr.x, row.label))}</div>
      <div class="mono">${esc(xrFmt(S.xr.y, row.value))}</div>`;
    let tx = x + 12, ty = y - 12;
    const tw = tip.offsetWidth, th = tip.offsetHeight, hw = host.clientWidth, hh = host.clientHeight;
    if (tx + tw > hw) tx = x - tw - 12;
    if (ty < 0) ty = 4;
    if (ty + th > hh) ty = hh - th - 4;
    tip.style.left = tx + 'px'; tip.style.top = ty + 'px';
  };
  const leave = () => { cross.style.opacity = '0'; tip.style.display = 'none'; };
  overlay.addEventListener('mousemove', move);
  overlay.addEventListener('mouseleave', leave);
}
