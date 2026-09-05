/* ============================================================
   views/history.js — Bill History: search, filter and open any
   past bill. A table on the left, a collapsible detail split pane
   on the right shows the full bill (customer, items, totals) with
   Open PDF / Print / Edit / Delete.
   ============================================================ */

import { api } from '../api.js';
import * as Panels from '../panels.js';
import {
  q, qa, on, esc, icon, inr, qty, toast, confirm, menu, emptyState, debounce,
  dmy, hm12, todayISO,
} from '../core.js';

const DATE_PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'week',  label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'all',   label: 'All' },
];

let S = null;

export default {
  title: 'Bill History',

  async mount(root, ctx) {
    S = {
      ctx, root,
      bills: [], filtered: [],
      search: '', type: 'all', dateMode: 'all', dateFrom: '', dateTo: '',
      selectedId: null, selectedBill: null, loadingDetail: false,
      loading: true,
    };

    paint(root);
    renderThead();
    renderDateFilter();
    renderDetail();
    wire();

    ctx.setActions([
      { label: 'New bill', icon: 'plusCircle', cls: 'btn-grad', onClick: () => ctx.go('newbill') },
    ]);

    await reload();

    // Land on a specific bill when navigated here from the command
    // palette's search results (see app.js's quick_search handling).
    const wantId = ctx.params?.billId;
    if (wantId && S.bills.some(b => b.id === wantId)) selectBill(wantId);
  },

  destroy() { S = null; },
};

/* ============================ layout ============================ */
function paint(root) {
  root.innerHTML = `
  <div class="split split-h grow" data-split="history.detail" style="padding:var(--s4) var(--s5) var(--s5)">
    <div class="pane pane-fill" style="padding-right:6px">
      <div class="panel grow">
        <div class="panel-head col" style="align-items:stretch;gap:10px;padding-bottom:10px;height:auto">
          <div class="row gap3 wrap">
            <div class="search" style="width:270px;flex:none">
              ${icon('search', 15)}<input id="q" placeholder="Search by bill number or customer…" autocomplete="off">
            </div>
            <div class="seg" id="typeSeg">
              <button class="on" data-t="all">All</button>
              <button data-t="sale">Sale</button>
              <button data-t="purchase">Purchase</button>
            </div>
            <span class="small muted grow" id="count" style="text-align:right"></span>
          </div>
          <div class="row gap3 wrap" id="dateRange"></div>
        </div>
        <div class="tbl-head" id="thead"></div>
        <div class="tbl-body" id="tbody"></div>
        <div class="panel-foot row between" id="footStrip"></div>
      </div>
    </div>

    <div class="pane pane-sized" data-collapsed="1" data-size="400" data-min="320" data-max="640" style="padding-left:6px">
      <div class="panel grow" id="detailPanel"></div>
    </div>
  </div>`;
}

// What the backend says this user may do (security.py decides, not us).
// With sign-in switched off every permission comes back true, which is
// why this must never be inferred from a role string.
function can(perm) { return S.ctx.app.can?.[perm] !== false; }
function isOwner() { return can('delete_bill'); }

/* ============================ data ============================ */
async function reload() {
  S.loading = true;
  renderTbody();
  try {
    S.bills = await api.get_bills(S.search) || [];
  if (!S) return;   // the screen was left while this was in flight
  } catch (e) {
    S.bills = [];
    toast('Could not load bill history', e.message, 'bad');
  }
  S.loading = false;
  applyFilterSort();
  renderAll();
}

function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function startOfWeek(d) { const n = new Date(d); n.setDate(n.getDate() - ((n.getDay() + 6) % 7)); return n; }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }

function computeRange() {
  const today = new Date();
  if (S.dateMode === 'today') { const t = todayISO(); return { from: t, to: t }; }
  if (S.dateMode === 'week')  return { from: isoDate(startOfWeek(today)), to: todayISO() };
  if (S.dateMode === 'month') return { from: isoDate(startOfMonth(today)), to: todayISO() };
  if (S.dateMode === 'custom') return { from: S.dateFrom || '', to: S.dateTo || '' };
  return { from: '', to: '' };
}

function statusOf(b) {
  const total = Number(b.total) || 0, paid = Number(b.amount_paid) || 0;
  if (paid - total >= -0.009) return 'paid';
  if (paid <= 0.009) return 'credit';
  return 'partial';
}
const STATUS_PILL = { paid: 'pill-ok', partial: 'pill-warn', credit: 'pill-bad' };
const STATUS_LABEL = { paid: 'Paid', partial: 'Partial', credit: 'Credit' };

function applyFilterSort() {
  const { from, to } = computeRange();
  S.filtered = S.bills.filter(b => {
    if (S.type !== 'all' && (b.bill_type || 'sale') !== S.type) return false;
    if (from && b.bill_date < from) return false;
    if (to && b.bill_date > to) return false;
    return true;
  });

  // Newest bill on top — what you just rang up is what you most often need
  // to reopen. Date then time then bill number, all plain string compares
  // because that is exactly how the database stores them (YYYY-MM-DD,
  // HH:MM, zero-padded number), so they sort correctly as text.
  S.filtered.sort((a, b) =>
    String(b.bill_date || '').localeCompare(String(a.bill_date || '')) ||
    String(b.bill_time || '').localeCompare(String(a.bill_time || '')) ||
    String(b.bill_number || '').localeCompare(String(a.bill_number || '')));
}

/* ============================ render ============================ */
function renderAll() {
  renderTbody();
  renderCount();
  renderFooter();
}

function renderDateFilter() {
  const host = q('#dateRange', S.root);
  host.innerHTML = `
    <div class="row gap2 wrap none">
      ${DATE_PRESETS.map(p => `<button class="chip ${S.dateMode === p.key ? 'on' : ''}" data-preset="${p.key}">${esc(p.label)}</button>`).join('')}
      <button class="chip ${S.dateMode === 'custom' ? 'on' : ''}" id="customChip">${icon('calendar', 13)}Custom</button>
    </div>
    <div class="row gap2" id="customDates" style="${S.dateMode === 'custom' ? '' : 'display:none'}">
      <input type="date" class="input input-sm" id="dFrom" style="width:140px" value="${esc(S.dateFrom)}">
      <span class="muted small">–</span>
      <input type="date" class="input input-sm" id="dTo" style="width:140px" value="${esc(S.dateTo)}">
    </div>`;
}

function renderThead() {
  q('#thead', S.root).innerHTML = `
    <div style="width:118px">Bill No</div>
    <div class="grow">Customer</div>
    <div style="width:132px">Phone</div>
    <div style="width:126px">Date</div>
    <div style="width:100px">Time</div>
    <div class="num-cell" style="width:56px">Items</div>
    <div class="num-cell" style="width:132px">Total</div>
    <div style="width:88px;text-align:center">Status</div>
    <div style="width:104px"></div>`;
}

function rowHtml(b) {
  const st = statusOf(b);
  const itemsCount = Array.isArray(b.items) ? b.items.length : (b.item_count ?? '—');
  return `<div class="tr ${S.selectedId === b.id ? 'on' : ''}" data-id="${b.id}" tabindex="0" role="button" title="Open bill ${esc(b.bill_number)}">
    <div class="mono ellipsis" style="width:118px">${esc(b.bill_number)}</div>
    <div class="grow ellipsis strong">${esc(b.customer_name || 'Walk-in')}</div>
    <div class="mono ellipsis" style="width:132px">${esc(b.customer_phone || '—')}</div>
    <div class="mono ellipsis" style="width:126px">${dmy(b.bill_date)}</div>
    <div class="mono ellipsis" style="width:100px">${hm12(b.bill_time)}</div>
    <div class="num-cell mono" style="width:56px">${itemsCount}</div>
    <div class="num-cell mono" style="width:132px">${inr(b.total)}</div>
    <div style="width:88px;text-align:center"><span class="pill ${STATUS_PILL[st]}">${STATUS_LABEL[st]}</span></div>
    <div class="acts" style="width:104px">
      <button class="btn btn-ghost btn-icon btn-sm" data-act="view" title="View bill">${icon('eye', 14)}</button>
      <button class="btn btn-ghost btn-icon btn-sm" data-act="print" title="Print">${icon('print', 14)}</button>
      <button class="btn btn-ghost btn-icon btn-sm" data-act="edit" title="Edit bill">${icon('pencil', 14)}</button>
      <button class="btn btn-ghost btn-icon btn-sm" data-act="delete" title="Delete bill">${icon('trash', 14)}</button>
    </div>
  </div>`;
}

function renderTbody() {
  const host = q('#tbody', S.root);
  if (S.loading) {
    host.innerHTML = Array.from({ length: 8 }).map(() =>
      `<div class="tr"><div class="skel" style="height:18px;width:100%;margin:auto 10px"></div></div>`).join('');
    return;
  }
  if (!S.filtered.length) {
    host.innerHTML = S.bills.length
      ? emptyState('filter', 'No bills match', 'Try a different search, date range or type.')
      : emptyState('book', 'No bills yet', 'Bills you save from New Bill will show up here.');
    return;
  }
  host.innerHTML = S.filtered.map(rowHtml).join('');
}

function renderCount() {
  const el_ = q('#count', S.root);
  if (!el_) return;
  const total = S.bills.length, shown = S.filtered.length;
  const active = S.type !== 'all' || S.dateMode !== 'all';
  el_.textContent = active ? `${shown} of ${total} bills` : `${total} bill${total !== 1 ? 's' : ''}`;
}

function renderFooter() {
  const host = q('#footStrip', S.root);
  const list = S.filtered;
  const total = list.reduce((s, b) => s + (Number(b.total) || 0), 0);
  host.innerHTML = `
    <span class="small muted">${list.length} bill${list.length !== 1 ? 's' : ''} shown</span>
    <span class="mono strong">${inr(total)}</span>`;
}

/* ============================ detail panel ============================ */
function renderDetail() {
  const host = q('#detailPanel', S.root);
  if (!S.selectedId) {
    host.innerHTML = `<div class="panel-head"><div class="h2 grow">Bill detail</div></div>
      <div class="grow scroll-y">${emptyState('eye', 'No bill selected', 'Click a bill on the left to see its full detail here.')}</div>`;
    return;
  }
  if (S.loadingDetail) {
    host.innerHTML = `<div class="panel-head"><div class="h2 grow">Bill detail</div></div>
      <div class="grow col gap3" style="padding:16px">
        <div class="skel" style="height:20px;width:60%"></div>
        <div class="skel" style="height:120px"></div>
        <div class="skel" style="height:80px"></div>
      </div>`;
    return;
  }
  const b = S.selectedBill;
  if (!b) {
    host.innerHTML = `<div class="panel-head"><div class="h2 grow">Bill detail</div></div>
      <div class="grow">${emptyState('warn', 'Could not load this bill', 'Try selecting it again.')}</div>`;
    return;
  }
  const st = statusOf(b);
  const balance = (Number(b.total) || 0) - (Number(b.amount_paid) || 0);

  host.innerHTML = `
    <div class="panel-head">
      <div class="grow ellipsis">
        <div class="h2 ellipsis">Bill ${esc(b.bill_number)}</div>
        <div class="small muted">${dmy(b.bill_date)} · ${hm12(b.bill_time)}</div>
      </div>
      <span class="pill ${STATUS_PILL[st]}">${STATUS_LABEL[st]}</span>
      <button class="btn btn-ghost btn-icon btn-sm" id="detailMore" title="More actions">${icon('dots', 15)}</button>
      <button class="btn btn-ghost btn-icon btn-sm" id="detailClose" title="Close">${icon('x', 15)}</button>
    </div>
    <div class="grow scroll-y" style="padding:14px 16px">
      <div class="col gap1" style="margin-bottom:14px">
        <div class="strong">${esc(b.customer_name || 'Walk-in customer')}</div>
        ${b.customer_phone ? `<div class="small muted mono">${esc(b.customer_phone)}</div>` : ''}
        ${b.customer_address ? `<div class="small muted">${esc(b.customer_address)}</div>` : ''}
      </div>
      <div class="divider" style="margin-bottom:8px"></div>
      <div class="row" style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.045em;color:var(--ink-3);padding:2px 0 6px">
        <div class="grow">Item</div><div style="width:56px;text-align:right">Qty</div>
        <div style="width:88px;text-align:right">Price</div><div style="width:112px;text-align:right">Amount</div>
      </div>
      ${(b.items || []).map(li => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line-soft)">
          <div class="grow ellipsis">${esc(li.item_name)}</div>
          <div class="mono" style="width:56px;text-align:right">${qty(li.quantity)}</div>
          <div class="mono" style="width:88px;text-align:right">${inr(li.price_per_unit, false)}</div>
          <div class="mono strong" style="width:112px;text-align:right">${inr(li.final_price, false)}</div>
        </div>`).join('') || `<div class="small muted" style="padding:10px 0">No items recorded.</div>`}
      <div class="col" style="margin-top:12px">
        <div class="sum-line"><span class="k">Subtotal</span><span class="v">${inr(b.subtotal)}</span></div>
        ${Number(b.freight_charges) ? `<div class="sum-line"><span class="k">Addition</span><span class="v">${inr(b.freight_charges)}</span></div>` : ''}
        ${Number(b.discount) ? `<div class="sum-line"><span class="k">Less</span><span class="v">-${inr(b.discount)}</span></div>` : ''}
        <div class="grand" style="margin-top:4px"><span style="font-size:var(--t-13);font-weight:600">Total</span><span class="v">${inr(b.total)}</span></div>
        <div class="row between" style="padding-top:8px">
          <span class="small muted">Paid</span><span class="mono small strong">${inr(b.amount_paid)}</span>
        </div>
        ${balance > 0.009 ? `<div class="row between"><span class="small muted">Balance</span><span class="mono small strong" style="color:var(--bad-ink)">${inr(balance)}</span></div>` : ''}
      </div>
      ${b.notes ? `<div class="divider" style="margin:12px 0"></div><div class="small muted" style="white-space:pre-line">${esc(b.notes)}</div>` : ''}
    </div>
    <div class="panel-foot row gap2 wrap">
      <button class="btn btn-ghost" id="btnOpenPdf">${icon('file', 14)}Open PDF</button>
      <button class="btn btn-ghost" id="btnPrint">${icon('print', 14)}Print</button>
      <button class="btn btn-ghost" id="btnEdit">${icon('pencil', 14)}Edit</button>
      <div class="grow"></div>
      <button class="btn btn-danger ${isOwner() ? '' : 'is-disabled'}" id="btnDelete" ${isOwner() ? '' : 'title="Only the store owner can delete bills"'}>${icon('trash', 14)}Delete</button>
    </div>`;

  wireDetailButtons(b);
}

function wireDetailButtons(b) {
  const host = q('#detailPanel', S.root);
  q('#detailClose', host).onclick = () => { S.selectedId = null; S.selectedBill = null; renderDetail(); renderTbody(); };
  q('#detailMore', host).onclick = (e) => menu(e.currentTarget, [
    { label: 'Send on WhatsApp', icon: 'whatsapp', disabled: !b.customer_phone,
      onClick: async () => {
        toast('Opening WhatsApp Web…', 'Leave the browser window open until the message is sent.', 'info');
        try { const m = await api.send_whatsapp(b.id, b.customer_phone); toast('WhatsApp', m, 'ok'); }
        catch (e2) { toast('WhatsApp send failed', e2.message, 'bad'); }
      } },
  ]);
  q('#btnOpenPdf', host).onclick = () => openPdfFor(b);
  q('#btnPrint', host).onclick = () => printBill(b);
  q('#btnEdit', host).onclick = () => editBill(b);
  q('#btnDelete', host).onclick = () => { if (isOwner()) deleteBill(b); };
}

/* ============================ actions ============================ */
async function selectBill(id) {
  // The detail pane sits out of the way until a bill is actually picked,
  // so the table gets the full width for everyday scanning.
  Panels.get('history.detail')?.setCollapsed(false);
  S.selectedId = id;
  S.selectedBill = null;
  S.loadingDetail = true;
  renderTbody();
  renderDetail();
  try {
    S.selectedBill = await api.get_bill(id);
  } catch (e) {
    toast('Could not open this bill', e.message, 'bad');
  }
  S.loadingDetail = false;
  renderDetail();
}

async function editBill(b) {
  try {
    const full = await api.get_bill(b.id);
    S.ctx.go('newbill', { bill: full });
  } catch (e) {
    toast('Could not open this bill for editing', e.message, 'bad');
  }
}

async function printBill(b) {
  try {
    await api.print_bill(b.id);
    toast('Sent to print', `Bill ${b.bill_number} was opened for printing.`, 'ok');
  } catch (e) { toast('Could not print this bill', e.message, 'bad'); }
}

async function openPdfFor(b) {
  try { await api.open_pdf(b.id); }
  catch (e) { toast('Could not open the PDF', e.message, 'bad'); }
}

async function deleteBill(b) {
  if (!isOwner()) return;
  const yes = await confirm('Delete this bill?',
    `Delete bill ${b.bill_number}?\n\nInventory quantities used in this bill will be restored.`,
    { danger: true, ok: 'Delete' });
  if (!yes) return;
  try {
    await api.delete_bill(b.id, true);
    toast('Bill deleted', `Bill ${b.bill_number} was deleted and its stock restored.`, 'ok');
    if (S.selectedId === b.id) { S.selectedId = null; S.selectedBill = null; renderDetail(); }
    await reload();
  } catch (e) { toast('Could not delete this bill', e.message, 'bad'); }
}

/* ============================ interaction ============================ */
function wire() {
  const root = S.root;

  const doSearch = debounce(() => { S.search = q('#q', root).value.trim(); reload(); }, 220);
  on(root, 'input', '#q', doSearch);
  on(root, 'keydown', '#q', (e) => { if (e.key === 'Enter') doSearch.now(); });

  on(root, 'click', '#typeSeg button', (e, b) => {
    qa('#typeSeg button', root).forEach(x => x.classList.toggle('on', x === b));
    S.type = b.dataset.t;
    applyFilterSort(); renderAll();
  });

  on(root, 'click', '[data-preset]', (e, b) => {
    S.dateMode = b.dataset.preset;
    renderDateFilter();
    applyFilterSort(); renderAll();
  });
  on(root, 'click', '#customChip', () => {
    S.dateMode = 'custom';
    renderDateFilter();
    applyFilterSort(); renderAll();
  });
  on(root, 'change', '#dFrom', (e) => { S.dateFrom = e.target.value; applyFilterSort(); renderAll(); });
  on(root, 'change', '#dTo', (e) => { S.dateTo = e.target.value; applyFilterSort(); renderAll(); });

  on(root, 'click', '.tr[data-id]', (e, row) => {
    const id = +row.dataset.id;
    const b = S.filtered.find(x => x.id === id) || S.bills.find(x => x.id === id);
    if (!b) return;
    const actBtn = e.target.closest('[data-act]');
    if (actBtn) {
      const act = actBtn.dataset.act;
      if (act === 'view') selectBill(id);
      else if (act === 'print') printBill(b);
      else if (act === 'edit') editBill(b);
      else if (act === 'delete') deleteBill(b);
      return;
    }
    selectBill(id);
  });
  on(root, 'keydown', '.tr[data-id]', (e, row) => {
    if (e.key === 'Enter') { e.preventDefault(); selectBill(+row.dataset.id); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); row.nextElementSibling?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); row.previousElementSibling?.focus(); }
  });
}
