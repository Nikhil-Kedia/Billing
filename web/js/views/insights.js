/* ============================================================
   views/insights.js — Customer Insights: one person's whole
   history with the shop — what they've spent, what they buy, and
   every bill they've ever been given, in one place.

   Left  — every customer (not only debtors), searchable, collapsible.
   Right — KPI tiles, then a split of: purchase-trend bars above,
           "Products they buy" and "Invoice history" side by side below.

   Clicking a product loads its price history for this customer
   (api.customer_product_history) — the point is spotting what rate
   they were last given. Double-clicking an invoice opens its PDF.
   ============================================================ */

import { api } from '../api.js';
import { openCustomerModal } from '../customer-edit.js';
import {
  q, qa, node, on, esc, icon, inr, dmy, qty, initials,
  toast, modal, emptyState, debounce,
} from '../core.js';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let S = null;

export default {
  title: 'Customer Insights',

  async mount(root, ctx) {
    S = {
      ctx, root,
      customers: [], byId: new Map(), filtered: [], search: '',
      products: [], productSearch: '',
      selectedId: null, loadingList: true,
    };

    paint(root);
    wire();
    renderEmptyWorkspace();

    await reload();

    const wantId = ctx.params?.customerId;
    if (wantId && S.byId.has(wantId)) selectCustomer(wantId);
  },

  destroy() { S = null; },
};

/* ============================ layout ============================ */
function paint(root) {
  root.innerHTML = `
  <div class="split split-h grow" data-split="insights.main" style="padding:var(--s4) var(--s5) var(--s5)">
    <div class="pane pane-sized" data-size="300" data-min="240" data-max="440" style="padding-right:6px">
      <div class="panel grow">
        <div class="panel-head">
          <div class="search grow">${icon('search', 15)}<input id="q" placeholder="Search by name, phone or address…" autocomplete="off"></div>
        </div>
        <div class="scroll-y grow" id="list" style="padding:6px"></div>
      </div>
    </div>

    <div class="pane pane-fill" style="padding-left:6px">
      <div class="col grow gap4" style="min-height:0">
        <div class="kpis" id="kpis"></div>

        <div class="split split-v grow" data-split="insights.trend">
          <div class="pane pane-sized" data-size="220" data-min="160" data-max="360">
            <div class="panel grow">
              <div class="panel-head">
                <div class="h2 grow">Purchase trend</div>
                <span class="tiny muted" id="trendSub"></span>
              </div>
              <div class="chart-wrap col" id="trendChart" style="padding:12px 16px"></div>
            </div>
          </div>

          <div class="pane pane-fill" style="padding-top:6px">
            <div class="split split-h grow" data-split="insights.lower">
              <div class="pane pane-sized" data-size="360" data-min="280" data-max="560" style="padding-right:6px">
                <div class="panel grow">
                  <div class="panel-head col" style="align-items:stretch;gap:8px;padding:10px 12px;height:auto">
                    <div class="row between gap2">
                      <div class="h2">Products they buy</div>
                      <span class="tiny muted" id="prodCount"></span>
                    </div>
                    <div class="search" style="height:30px">
                      ${icon('search', 14)}
                      <input id="prodQ" placeholder="Search this customer's products…" autocomplete="off">
                    </div>
                  </div>
                  <div class="scroll-y grow" id="products" style="padding:6px"></div>
                </div>
              </div>
              <div class="pane pane-fill" style="padding-left:6px">
                <div class="panel grow">
                  <div class="panel-head">
                    <div class="h2 grow">Invoice history</div>
                    <span class="tiny muted">Double-click to open PDF</span>
                  </div>
                  <div class="tbl-head" id="invHead">
                    <div style="width:96px">Date</div>
                    <div style="width:104px">Bill No.</div>
                    <div class="num-cell grow">Total</div>
                    <div style="width:88px;text-align:center">Status</div>
                  </div>
                  <div class="tbl-body" id="invBody"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function renderEmptyWorkspace() {
  q('#kpis', S.root).innerHTML = `<div style="grid-column:1/-1">
    ${emptyState('users', 'Select a customer', 'Pick a customer from the list to see their analytics, purchase trend and invoice history.')}
  </div>`;
  q('#trendSub', S.root).textContent = '';
  q('#trendChart', S.root).innerHTML = `<div class="col center grow small muted">Nothing to show yet.</div>`;
  q('#products', S.root).innerHTML = `<div class="col center grow small muted" style="padding:24px;text-align:center">Nothing to show yet.</div>`;
  q('#invBody', S.root).innerHTML = '';
}

/* ============================ data: left list ============================ */
async function reload() {
  S.loadingList = true;
  renderList();
  try {
    S.customers = (await api.get_customers('')) || [];
  if (!S) return;   // the screen was left while this was in flight
  } catch (e) {
    S.customers = [];
    toast('Could not load customers', e.message, 'bad');
  }
  S.byId = new Map(S.customers.map(c => [c.id, c]));
  S.loadingList = false;
  applyFilter();
}

function applyFilter() {
  const t = S.search.trim().toLowerCase();
  const list = !t ? S.customers : S.customers.filter(c =>
    String(c.name || '').toLowerCase().includes(t) ||
    String(c.phone || '').includes(t) ||
    String(c.address || '').toLowerCase().includes(t));
  list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  S.filtered = list;
  renderList();
}

function rowHtml(c) {
  const bal = c.balance || 0;
  const sub = c.phone || c.address || 'No contact details';
  return `<button class="list-row tap ${S.selectedId === c.id ? 'on' : ''}" data-id="${c.id}">
    <div class="avatar">${esc(initials(c.name))}</div>
    <div class="col grow" style="gap:1px;min-width:0">
      <span class="small strong ellipsis nm">${esc(c.name)}</span>
      <span class="tiny muted ellipsis">${esc(sub)}</span>
    </div>
    ${bal > 0.009 ? `<span class="mono tiny strong" style="flex:none;color:var(--bad-ink)">${inr(bal)}</span>` : ''}
  </button>`;
}

function renderList() {
  const host = q('#list', S.root);
  if (!host) return;
  if (S.loadingList) {
    host.innerHTML = Array.from({ length: 8 }).map(() =>
      `<div style="padding:7px 10px"><div class="skel" style="height:36px;border-radius:var(--r-md)"></div></div>`).join('');
    return;
  }
  if (!S.customers.length) {
    host.innerHTML = emptyState('users', 'No customers yet', 'Customers appear here once you save your first bill.');
    return;
  }
  if (!S.filtered.length) {
    host.innerHTML = emptyState('search', 'No customers match', 'Try a different search.');
    return;
  }
  host.innerHTML = S.filtered.map(rowHtml).join('');
}

/* ============================ selecting a customer ============================ */
function selectCustomer(id) {
  S.selectedId = id;
  qa('.list-row[data-id]', S.root).forEach(r => r.classList.toggle('on', +r.dataset.id === id));
  loadCustomer(id);
}

function showSkeleton() {
  q('#kpis', S.root).innerHTML = Array.from({ length: 5 }).map(() =>
    `<div class="tile"><div class="skel" style="width:26px;height:26px;border-radius:var(--r-sm)"></div>
      <div class="skel" style="width:60%;height:12px;margin-top:10px"></div>
      <div class="skel" style="width:80%;height:22px;margin-top:8px"></div></div>`).join('');
  q('#trendChart', S.root).innerHTML = `<div class="skel" style="width:100%;height:100%"></div>`;
  q('#products', S.root).innerHTML = `<div class="skel" style="height:60px;margin:6px"></div>`.repeat(4);
  q('#invBody', S.root).innerHTML = `<div class="tr"><div class="skel" style="height:18px;width:100%;margin:auto 10px"></div></div>`;
}

async function loadCustomer(id) {
  showSkeleton();
  const cust = S.byId.get(id);
  S.ctx.setSub(cust ? `Analytics: ${cust.name}` : '');

  let kpis = {}, bills = [], products = [];
  try {
    [kpis, bills, products] = await Promise.all([
      api.customer_kpis(id), api.customer_bills(id), api.customer_products(id),
    ]);
  } catch (e) {
    toast('Could not load this customer', e.message, 'bad');
  }
  if (!S || S.selectedId !== id) return;    // selection moved on while we awaited

  S.bills = bills || [];
  S.products = products || [];

  renderKpis(kpis || {}, cust);
  renderTrend(S.bills);
  renderProducts(visibleProducts());
  renderInvoices(S.bills);
  updateTopActions(kpis || {}, cust);
}

function updateTopActions(k, cust) {
  const actions = [];
  if (S.ctx.app.flags.khata && (k.balance || 0) > 0.009 && cust) {
    actions.push({ label: 'Receive payment', icon: 'rupee', cls: 'btn-primary',
      onClick: () => S.ctx.go('khata', { customerId: cust.id }) });
  }
  // This is the screen you actually sit on when looking at one person,
  // so it is also where a wrong phone number or a misspelt name gets
  // noticed - fixing it should not mean going back to the list and
  // hunting for a hover-only pencil.
  if (cust) {
    actions.push({ label: 'Edit details', icon: 'pencil',
      onClick: () => openCustomerModal(cust, { onSaved: onCustomerEdited }) });
  }
  S.ctx.setActions(actions);
}

/** After an edit: pull the customer list again (the name in the left
    rail, the sub-title and the bills all carry it) and re-render the
    person currently open. */
async function onCustomerEdited() {
  const id = S.selectedId;
  await reload();
  if (!S) return;
  if (id && S.byId.has(id)) selectCustomer(id);
}

/* ============================ KPI tiles ============================ */
function kpiDefs(k) {
  const defs = [
    { icon: 'rupee', label: 'Total revenue', value: inr(k.total_revenue || 0) },
    { icon: 'book', label: 'Bills', value: String(k.bill_count || 0) },
    { icon: 'chart', label: 'Avg. order value', value: k.bill_count ? inr(k.avg_order || 0) : '—' },
    { icon: 'clock', label: 'Last purchase', value: k.last_purchase ? dmy(k.last_purchase) : 'Never' },
  ];
  if (S.ctx.app.flags.khata) {
    const bal = k.balance || 0;
    defs.push({ icon: 'card', label: 'Current balance', value: inr(bal), tone: bal > 0.009 ? 'danger' : 'success' });
  }
  return defs;
}

function tileHtml(d) {
  const style = d.tone === 'danger' ? 'color:var(--bad-ink)' : d.tone === 'success' ? 'color:var(--ok-ink)' : '';
  return `<div class="tile">
    <div class="tile-ico" style="background:var(--surface-2);color:var(--ink-3)">${icon(d.icon, 15)}</div>
    <div class="small muted" style="margin-top:8px">${esc(d.label)}</div>
    <div class="tile-val mono" style="${style}">${esc(d.value)}</div>
  </div>`;
}

function renderKpis(k, cust) {
  q('#kpis', S.root).innerHTML = kpiDefs(k, cust).map(tileHtml).join('');
}

/* ============================ purchase-trend chart ============================ */
function monthLabel(m) {
  const [y, mm] = m.split('-');
  return `${MON[+mm - 1] || mm} ${y.slice(2)}`;
}

function monthlySeries(bills) {
  const map = new Map();
  bills.forEach(b => {
    const m = String(b.bill_date || '').slice(0, 7);
    if (!m) return;
    map.set(m, (map.get(m) || 0) + (b.total || 0));
  });
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, revenue]) => ({ month, revenue }));
}

function renderTrend(bills) {
  const host = q('#trendChart', S.root), sub = q('#trendSub', S.root);
  const series = monthlySeries(bills);
  if (!series.length) {
    sub.textContent = '';
    host.innerHTML = emptyState('chart', 'No purchases yet', 'Their monthly spend appears here once they have bills.');
    return;
  }
  if (series.length < 4) {
    sub.textContent = '';
    const total = series.reduce((s, d) => s + d.revenue, 0);
    host.innerHTML = `<div class="col center grow" style="gap:6px;text-align:center;height:100%">
      <div class="tile-val mono" style="font-size:var(--t-24)">${esc(inr(total))}</div>
      <div class="small muted">across ${series.length} month${series.length === 1 ? '' : 's'} — not enough months yet for a trend</div>
    </div>`;
    return;
  }
  sub.textContent = `${series.length} months`;
  const max = Math.max(...series.map(d => d.revenue), 1);
  const bars = series.map(d => `<i style="height:${Math.max(3, (d.revenue / max) * 100)}%"
    title="${esc(monthLabel(d.month))}&#10;${esc(inr(d.revenue))}"></i>`).join('');
  const labels = series.map(d => `<span class="tiny muted" style="flex:1;text-align:center">${esc(monthLabel(d.month))}</span>`).join('');
  host.innerHTML = `<div class="bars grow">${bars}</div><div class="row" style="margin-top:6px">${labels}</div>`;
}

/* ============================ products they buy ============================ */
/** The list the panel is actually showing, after the search box. */
function visibleProducts() {
  const t = (S.productSearch || '').trim().toLowerCase();
  const all = S.products || [];
  return t ? all.filter(p => String(p.item_name || '').toLowerCase().includes(t)) : all;
}

function renderProducts(list) {
  const host = q('#products', S.root);
  const countEl = q('#prodCount', S.root);
  const total = (S.products || []).length;
  if (countEl) countEl.textContent = total
    ? (list.length === total ? `${total} product${total === 1 ? '' : 's'}`
                             : `${list.length} of ${total}`)
    : '';
  if (!list.length && total) {
    host.innerHTML = emptyState('search', 'No matching product',
      `Nothing this customer bought matches “${S.productSearch}”.`);
    return;
  }
  if (!list.length) {
    host.innerHTML = emptyState('box', 'Nothing bought yet', 'Products this customer has purchased appear here, ranked by amount spent.');
    return;
  }
  const max = Math.max(...list.map(p => p.amount || 0), 1);
  host.innerHTML = list.map(p => `
    <button class="list-row tap" data-name="${esc(p.item_name)}" style="height:auto;padding:9px 10px;align-items:flex-start">
      <div class="col grow" style="gap:4px;min-width:0">
        <div class="row between gap2">
          <span class="small strong ellipsis" title="${esc(p.item_name)}">${esc(p.item_name)}</span>
          <span class="small mono strong" style="flex:none">${esc(inr(p.amount || 0))}</span>
        </div>
        <div class="bar"><i style="width:${Math.max(2, ((p.amount || 0) / max) * 100)}%"></i></div>
        <span class="tiny muted">${esc(qty(p.qty || 0))} units · ${p.times || 0} bill${p.times === 1 ? '' : 's'}</span>
      </div>
    </button>`).join('');
}

async function openProductHistory(custId, name) {
  let rows = [];
  try { rows = (await api.customer_product_history(custId, name)) || []; }
  catch (e) { toast('Could not load price history', e.message, 'bad'); return; }

  const body = node(`<div class="col" style="min-width:0">
    <div class="tbl-head" style="position:static;border-radius:var(--r-md) var(--r-md) 0 0">
      <div style="width:100px">Date</div>
      <div style="width:120px">Bill No.</div>
      <div class="num-cell" style="width:90px">Qty</div>
      <div class="num-cell" style="width:120px">Rate given</div>
      <div class="num-cell grow">Amount</div>
    </div>
    <div class="tbl-body" style="max-height:340px">
      ${rows.length ? rows.map(r => `
        <div class="tr">
          <div style="width:100px">${esc(dmy(r.bill_date))}</div>
          <div class="mono" style="width:120px">${esc(r.bill_number)}</div>
          <div class="num-cell mono" style="width:90px">${esc(qty(r.quantity))}</div>
          <div class="num-cell mono" style="width:120px">${esc(inr(r.price_per_unit))}</div>
          <div class="num-cell mono grow strong">${esc(inr(r.final_price))}</div>
        </div>`).join('') : `<div class="small muted" style="padding:24px;text-align:center">No purchase history for this product.</div>`}
    </div>
  </div>`);

  await modal({
    title: name, icon: 'box', wide: 'modal-wide', body,
    actions: [{ label: 'Close', cls: 'btn-primary', value: true, default: true }],
  });
}

/* ============================ invoice history ============================ */
function billStatus(b) {
  const paid = b.amount_paid || 0, total = b.total || 0;
  if (total > 0.009 && paid >= total - 0.009) return { label: 'Paid', cls: 'pill-ok' };
  if (paid <= 0.009) return { label: 'Unpaid', cls: 'pill-bad' };
  return { label: 'Partial', cls: 'pill-warn' };
}

function invRowHtml(b) {
  const st = billStatus(b);
  return `<div class="tr tap" data-id="${b.id}">
    <div style="width:96px">${esc(dmy(b.bill_date))}</div>
    <div class="mono ellipsis" style="width:104px">${esc(b.bill_number)}</div>
    <div class="num-cell mono grow strong">${esc(inr(b.total))}</div>
    <div style="width:88px;text-align:center"><span class="pill ${st.cls}">${st.label}</span></div>
  </div>`;
}

function renderInvoices(bills) {
  const host = q('#invBody', S.root);
  if (!bills.length) {
    host.innerHTML = emptyState('file', 'No bills yet', 'Every invoice for this customer will show up here.');
    return;
  }
  host.innerHTML = bills.map(invRowHtml).join('');
}

/* ============================ interaction ============================ */
function wire() {
  const root = S.root;
  const doSearch = debounce(() => { S.search = q('#q', root).value; applyFilter(); }, 180);
  on(root, 'input', '#q', doSearch);

  // Searching this customer's own products — purely local, the list is
  // already in memory, so it filters as fast as you can type.
  const doProdSearch = debounce(() => {
    S.productSearch = q('#prodQ', root)?.value || '';
    renderProducts(visibleProducts());
  }, 120);
  on(root, 'input', '#prodQ', doProdSearch);
  on(root, 'keydown', '#prodQ', (e) => {
    if (e.key === 'Escape') { e.target.value = ''; S.productSearch = ''; renderProducts(visibleProducts()); }
  });

  on(root, 'click', '.list-row[data-id]', (e, row) => selectCustomer(+row.dataset.id));
  on(root, 'keydown', '.list-row[data-id]', (e, row) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); row.nextElementSibling?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); row.previousElementSibling?.focus(); }
  });

  on(root, 'click', '.list-row[data-name]', (e, row) => {
    if (!S.selectedId) return;
    openProductHistory(S.selectedId, row.dataset.name);
  });

  on(root, 'dblclick', '#invBody .tr[data-id]', (e, row) => {
    const id = +row.dataset.id;
    api.open_pdf(id).catch(e2 => toast('Could not open the PDF', e2.message, 'bad'));
  });
}
