/* ============================================================
   views/customers.js — every person who owes you money or might
   again: search, add/edit, delete, and a right-hand summary pane
   that hands off to full Customer Insights.

   Table: avatar + name, phone, address, outstanding balance (red
   when > 0), last purchase. Row hover gives quick view-insights /
   edit / delete. Selecting a row fills the collapsible detail pane
   on the right with balance, bill count, lifetime value and the
   five most recent bills.
   ============================================================ */

import { api } from '../api.js';
import * as Panels from '../panels.js';
import {
  q, qa, on, node, esc, icon, inr, dmy, initials, toast, modal, confirm,
  emptyState, debounce,
} from '../core.js';

let S = null;

export default {
  title: 'Customers',

  async mount(root, ctx) {
    S = {
      ctx, root,
      customers: [], byId: new Map(), filtered: [],
      search: '', sort: { key: 'name', dir: 'asc' },
      selectedId: null, loading: true,
    };

    paint(root);
    renderThead();
    wire();

    ctx.setActions([
      { label: 'Add customer', icon: 'plus', cls: 'btn-grad', onClick: () => openCustomerModal(null) },
    ]);

    renderDetail();
    await reload();
  },

  destroy() { S = null; },
};

/* ============================ layout ============================ */
function paint(root) {
  root.innerHTML = `
  <div class="split split-h grow" data-split="customers.detail" style="padding:var(--s4) var(--s5) var(--s5)">
    <div class="pane pane-fill">
      <div class="panel grow">
        <div class="panel-head">
          <div class="search" style="width:300px;flex:none">
            ${icon('search', 15)}<input id="q" placeholder="Search by name, phone or address…" autocomplete="off">
          </div>
          <span class="small muted" id="count"></span>
          <div class="grow"></div>
        </div>
        <div class="tbl-head" id="thead"></div>
        <div class="tbl-body" id="tbody"></div>
      </div>
    </div>

    <div class="pane pane-sized" data-collapsed="1" data-size="340" data-min="280" data-max="480" style="padding-left:6px">
      <div class="panel grow scroll-y" id="detailBody"></div>
    </div>
  </div>`;
}

/* ============================ data ============================ */
async function reload() {
  S.loading = true;
  refreshTable();
  try {
    S.customers = await api.customers_overview() || [];
  if (!S) return;   // the screen was left while this was in flight
  } catch (e) {
    S.customers = [];
    toast('Could not load customers', e.message, 'bad');
  }
  S.byId = new Map(S.customers.map(c => [c.id, c]));
  if (S.selectedId && !S.byId.has(S.selectedId)) S.selectedId = null;
  S.loading = false;
  refreshTable();
  renderDetail();
}

function comparator({ key, dir }) {
  const mul = dir === 'asc' ? 1 : -1;
  return (a, b) => {
    let r = 0;
    switch (key) {
      case 'name':    r = String(a.name || '').localeCompare(String(b.name || '')); break;
      case 'balance': r = (a.balance || 0) - (b.balance || 0); break;
      case 'last':    r = String(a.last_purchase || '').localeCompare(String(b.last_purchase || '')); break;
      default: r = 0;
    }
    return r * mul;
  };
}

function applyFiltersSort() {
  const term = S.search.trim().toLowerCase();
  const list = S.customers.filter(c => {
    if (!term) return true;
    return String(c.name || '').toLowerCase().includes(term)
      || String(c.phone || '').includes(term)
      || String(c.address || '').toLowerCase().includes(term);
  });
  list.sort(comparator(S.sort));
  S.filtered = list;
}

function setSort(key) {
  if (S.sort.key === key) S.sort.dir = S.sort.dir === 'asc' ? 'desc' : 'asc';
  else S.sort = { key, dir: 'asc' };
  refreshTable();
}

/* ============================ render: table ============================ */
function refreshTable() {
  applyFiltersSort();
  renderTbody();
  renderCount();
}

function renderThead() {
  const arrow = (key) => S.sort.key === key ? icon(S.sort.dir === 'asc' ? 'arrowUp' : 'arrowDown', 11) : '';
  q('#thead', S.root).innerHTML = `
    <div style="width:230px"><span class="sortable" data-sort="name">Customer${arrow('name')}</span></div>
    <div style="width:130px">Phone</div>
    <div class="grow">Address</div>
    <div class="num-cell" style="width:150px"><span class="sortable" data-sort="balance">Balance${arrow('balance')}</span></div>
    <div style="width:132px"><span class="sortable" data-sort="last">Last purchase${arrow('last')}</span></div>
    <div style="width:96px"></div>`;
}

function rowHtml(c) {
  const bal = c.balance || 0;
  return `<div class="tr tap ${S.selectedId === c.id ? 'on' : ''}" data-id="${c.id}" tabindex="0">
    <div class="row gap2" style="width:230px">
      <div class="avatar">${esc(initials(c.name))}</div>
      <span class="ellipsis strong">${esc(c.name)}</span>
    </div>
    <div class="mono ellipsis" style="width:130px">${esc(c.phone || '—')}</div>
    <div class="ellipsis grow">${esc(c.address || '—')}</div>
    <div class="num-cell mono" style="width:150px;${bal > 0.009 ? 'color:var(--bad-ink)' : ''}">${inr(bal)}</div>
    <div class="ellipsis" style="width:132px">${c.last_purchase ? dmy(c.last_purchase) : '—'}</div>
    <div class="acts" style="width:96px">
      <button class="btn btn-ghost btn-icon btn-sm" data-act="insights" title="View insights">${icon('chart', 14)}</button>
      <button class="btn btn-ghost btn-icon btn-sm" data-act="edit" title="Edit customer">${icon('pencil', 14)}</button>
      <button class="btn btn-ghost btn-icon btn-sm" data-act="delete" title="Delete customer">${icon('trash', 14)}</button>
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
    host.innerHTML = S.customers.length
      ? emptyState('search', 'No customers match', 'Try a different search.')
      : emptyState('users', 'No customers yet', 'Customers appear here once you save your first bill, or you can add one directly.');
    return;
  }
  host.innerHTML = S.filtered.map(rowHtml).join('');
}

function renderCount() {
  const el_ = q('#count', S.root);
  if (!el_) return;
  const total = S.customers.length, shown = S.filtered.length;
  if (!S.search.trim()) {
    el_.textContent = `${total} customer${total !== 1 ? 's' : ''}`;
    el_.style.color = '';
  } else if (shown === 0) {
    el_.textContent = `No matches in ${total} customer${total !== 1 ? 's' : ''}`;
    el_.style.color = 'var(--warn-ink)';
  } else {
    el_.textContent = `${shown} of ${total} customers`;
    el_.style.color = '';
  }
}

/* ============================ render: detail pane ============================ */
function renderDetail() {
  const host = q('#detailBody', S.root);
  if (!host) return;
  if (!S.selectedId) {
    host.innerHTML = emptyState('users', 'Select a customer', 'Pick a customer from the list to see their summary here.');
    return;
  }
  const c = S.byId.get(S.selectedId);
  if (!c) {
    host.innerHTML = emptyState('warn', 'Customer not found', 'This customer may have just been deleted.');
    return;
  }
  const bal = c.balance || 0;
  host.innerHTML = `
    <div class="col gap4" style="padding:16px">
      <div class="row gap3">
        <div class="avatar avatar-lg">${esc(initials(c.name))}</div>
        <div class="col" style="gap:2px;min-width:0">
          <div class="h2 ellipsis">${esc(c.name)}</div>
          <div class="small muted ellipsis">${esc([c.phone, c.address].filter(Boolean).join(' · ') || 'No contact details on file')}</div>
        </div>
      </div>

      <div class="divider"></div>

      <div class="row gap6 wrap">
        <div class="col gap1">
          <span class="overline">Balance</span>
          <span class="h1 mono" style="color:${bal > 0.009 ? 'var(--bad-ink)' : 'var(--ok-ink)'}">${inr(bal)}</span>
        </div>
        <div class="col gap1">
          <span class="overline">Bills</span>
          <span class="h1 mono">${c.bill_count || 0}</span>
        </div>
      </div>

      <div class="row between" style="padding:10px 12px;background:var(--surface-2);border-radius:var(--r-md)">
        <span class="small">Lifetime value</span>
        <b class="mono">${inr(c.total_revenue || 0)}</b>
      </div>

      <div>
        <div class="overline" style="margin-bottom:8px">Recent bills</div>
        <div class="col" id="recentBills"><div class="skel" style="height:60px"></div></div>
      </div>

      <button class="btn btn-primary" style="width:100%" id="fullInsights">${icon('chart', 14)}View full insights</button>
    </div>`;

  q('#fullInsights', S.root).onclick = () => S.ctx.go('insights', { customerId: c.id });
  loadRecentBills(c.id);
}

async function loadRecentBills(id) {
  let bills = [];
  try { bills = (await api.customer_bills(id) || []).slice(0, 5); }
  catch { /* the detail pane fails quietly here; the main table already loaded fine */ }
  if (!S || S.selectedId !== id) return;         // selection moved on while we awaited
  const host = q('#recentBills', S.root);
  if (!host) return;
  if (!bills.length) { host.innerHTML = `<div class="small muted">No bills yet.</div>`; return; }
  host.innerHTML = bills.map(b => `
    <div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line-soft)">
      <div class="col" style="gap:1px;min-width:0">
        <span class="small mono ellipsis">${esc(b.bill_number)}</span>
        <span class="tiny muted">${dmy(b.bill_date)}</span>
      </div>
      <span class="small mono strong">${inr(b.total)}</span>
    </div>`).join('');
}

function selectCustomer(id) {
  // the detail pane stays out of the way until someone is picked
  Panels.get('customers.detail')?.setCollapsed(false);
  S.selectedId = id;
  qa('.tr[data-id]', S.root).forEach(r => r.classList.toggle('on', +r.dataset.id === id));
  renderDetail();
}

/* ============================ interaction ============================ */
function wire() {
  const root = S.root;

  const doSearch = debounce(() => { S.search = q('#q', root).value; refreshTable(); }, 180);
  on(root, 'input', '#q', doSearch);
  on(root, 'click', '.sortable', (e, b) => setSort(b.dataset.sort));

  on(root, 'click', '.tr[data-id]', (e, row) => {
    const id = +row.dataset.id;
    const c = S.byId.get(id);
    if (!c) return;
    const actBtn = e.target.closest('[data-act]');
    if (actBtn) {
      const act = actBtn.dataset.act;
      if (act === 'insights') S.ctx.go('insights', { customerId: id });
      else if (act === 'edit') openCustomerModal(c);
      else if (act === 'delete') deleteCustomer(c);
      return;
    }
    selectCustomer(id);
  });

  on(root, 'keydown', '.tr[data-id]', (e, row) => {
    if (e.key === 'Enter') { e.preventDefault(); selectCustomer(+row.dataset.id); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); row.nextElementSibling?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); row.previousElementSibling?.focus(); }
  });
}

/* ============================ add / edit modal ============================ */
function fieldRow(label, id, opts = {}) {
  return `<div class="field grow" style="${opts.style || ''}">
    <label class="label">${esc(label)}${opts.req ? '<span class="req">*</span>' : ''}</label>
    <input class="input" id="${id}" autocomplete="off" placeholder="${esc(opts.ph || '')}" value="${esc(opts.val ?? '')}">
    <div class="tiny" style="color:var(--bad-ink);min-height:14px" data-err="${id}"></div>
  </div>`;
}

function setErr(body, id, msg) {
  const input = q('#' + id, body), err = q(`[data-err="${id}"]`, body);
  if (input) input.classList.toggle('is-bad', !!msg);
  if (err) err.textContent = msg || '';
}

async function openCustomerModal(cust) {
  const isEdit = !!cust;
  const body = node(`<div class="col gap4">
    ${fieldRow('Customer name', 'f-name', { req: true, val: cust?.name || '' })}
    <div class="row gap3">
      ${fieldRow('Phone', 'f-phone', { val: cust?.phone || '', ph: '98530 21456' })}
      ${fieldRow('Address', 'f-addr', { val: cust?.address || '', ph: 'Town, district' })}
    </div>
    ${isEdit ? fieldRow('Notes', 'f-notes', { val: cust?.notes || '', ph: 'Optional' }) : ''}
  </div>`);

  const res = await modal({
    title: isEdit ? `Edit customer: ${cust.name}` : 'Add customer',
    icon: isEdit ? 'pencil' : 'plus',
    body,
    actions: [
      { label: 'Cancel', value: false },
      {
        label: isEdit ? 'Save changes' : 'Add customer', cls: 'btn-primary', default: true,
        onClick: async () => {
          setErr(body, 'f-name', '');
          const name = q('#f-name', body).value.trim();
          if (!name) { setErr(body, 'f-name', 'Customer name is required.'); return false; }
          const data = {
            name,
            phone: q('#f-phone', body).value.trim(),
            address: q('#f-addr', body).value.trim(),
            ...(isEdit ? { notes: q('#f-notes', body).value.trim() } : {}),
          };
          try {
            if (isEdit) await api.update_customer(cust.id, data);
            else await api.add_customer(data);
            toast(isEdit ? 'Customer updated' : 'Customer added', `${name} was saved.`, 'ok');
          } catch (e) {
            toast(isEdit ? 'Could not save customer' : 'Could not add customer', e.message, 'bad');
            return false;
          }
          return true;
        },
      },
    ],
  });
  if (res) await reload();
}

/* ============================ delete ============================ */
async function deleteCustomer(cust) {
  const yes = await confirm('Delete this customer?',
    `Delete "${cust.name}"? This removes them from your customer list.\n\n` +
    "It does NOT delete their past bills or ledger history — those records stay in your data, they just won't be linked to a customer anymore.",
    { danger: true, ok: 'Delete' });
  if (!yes) return;
  try {
    await api.delete_customer(cust.id);
    toast('Customer deleted', `${cust.name} was removed.`, 'ok');
    if (S.selectedId === cust.id) S.selectedId = null;
    await reload();
  } catch (e) { toast('Could not delete customer', e.message, 'bad'); }
}
