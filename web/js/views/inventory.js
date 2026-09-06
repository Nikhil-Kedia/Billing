/* ============================================================
   views/inventory.js — the catalogue: every item you sell, its
   price and what is left in stock.

   Layout: a collapsible filter rail (category, stock status, price
   range) on the left, the item table on the right. A banner surfaces
   items that need restocking; clicking it narrows the table to them.
   Row click opens the Edit Item dialog (doubling as the detail view);
   hover actions give quick edit / adjust-stock / delete shortcuts.
   ============================================================ */

import { api } from '../api.js';
import * as Panels from '../panels.js';
import {
  q, qa, on, node, esc, icon, inr, qty, num, toast, modal, confirm, menu,
  emptyState, debounce,
} from '../core.js';

const STATUS_OPTS = [
  { key: 'all',     label: 'All' },
  { key: 'in',      label: 'In stock' },
  { key: 'low',     label: 'Low' },
  { key: 'out',     label: 'Out of stock' },
  { key: 'restock', label: 'Needs restocking' },
];

let S = null;

export default {
  title: 'Inventory',

  async mount(root, ctx) {
    S = {
      ctx, root,
      items: [], byId: new Map(), filtered: [],
      search: '', sort: { key: 'code', dir: 'asc' },
      filters: { category: '', status: 'all', priceMin: '', priceMax: '' },
      loading: true,
    };

    paint(root);
    renderThead();
    wire();

    ctx.setActions([
      { label: 'Filters', icon: 'filter', cls: 'btn-ghost',
        title: 'Show or hide the filter panel',
        onClick: () => Panels.get('inventory.filters')?.toggle() },
      { label: 'Add item', icon: 'plus', cls: 'btn-grad', onClick: () => openItemModal(null) },
      { label: 'Import', icon: 'upload', cls: 'btn-ghost', onClick: doImport },
      { label: 'Export', icon: 'download', cls: 'btn-ghost', onClick: doExport },
      { label: '', icon: 'dots', cls: 'btn-ghost', iconOnly: true, title: 'More actions', onClick: (e, b) => moreMenu(b) },
    ]);

    await reload();

    // Open a specific item when navigated here from the command
    // palette's search results (see app.js's quick_search handling).
    const wantId = ctx.params?.itemId;
    if (wantId && S.byId.has(wantId)) openItemModal(S.byId.get(wantId));
  },

  destroy() { S = null; },
};

/* ============================ layout ============================ */
function paint(root) {
  root.innerHTML = `
  <div class="split split-h grow" data-split="inventory.filters" style="padding:var(--s4) var(--s5) var(--s5)">
    <div class="pane pane-sized" data-collapsed="1" data-size="248" data-min="200" data-max="380">
      <div class="panel grow">
        <div class="panel-head">
          ${icon('filter', 16)}<div class="h2 grow">Filters</div>
          <button class="btn btn-ghost btn-sm" id="clearFilters" style="display:none">Clear</button>
        </div>
        <div class="grow scroll-y" style="padding:14px">
          <div class="col gap5" id="filterBody"></div>
        </div>
      </div>
    </div>

    <div class="pane pane-fill" style="padding-left:6px">
      <div class="col grow gap3">
        <div id="banner"></div>
        <div class="panel grow">
          <div class="panel-head">
            <div class="search" style="width:300px;flex:none">
              ${icon('search', 15)}<input id="q" placeholder="Search by name, code or category…" autocomplete="off">
            </div>
            <span class="small muted" id="count"></span>
            <div class="grow"></div>
          </div>
          <div class="tbl-head" id="thead"></div>
          <div class="tbl-body" id="tbody"></div>
        </div>
      </div>
    </div>
  </div>`;
}

/* ============================ data ============================ */
async function reload() {
  S.loading = true;
  refreshTable();
  try {
    S.items = await api.get_items() || [];
  if (!S) return;   // the screen was left while this was in flight
  } catch (e) {
    S.items = [];
    toast('Could not load inventory', e.message, 'bad');
  }
  S.byId = new Map(S.items.map(i => [i.id, i]));
  S.loading = false;
  refreshFiltersAndTable();
}

function statusOf(it) {
  const qv = Number(it.quantity) || 0, th = Number(it.low_stock_threshold) || 0;
  if (qv <= 0) return 'out';
  if (qv <= th) return 'low';
  return 'in';
}

function uniqueCategories() {
  return [...new Set(S.items.map(i => i.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function codeKey(code) {
  const c = String(code || '');
  return /^\d+$/.test(c) ? [0, parseInt(c, 10), c] : [1, c.toLowerCase()];
}
function cmpArr(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}
function comparator({ key, dir }) {
  const mul = dir === 'asc' ? 1 : -1;
  return (a, b) => {
    let r = 0;
    switch (key) {
      case 'code':     r = cmpArr(codeKey(a.item_code), codeKey(b.item_code)); break;
      case 'name':     r = String(a.name || '').localeCompare(String(b.name || '')); break;
      case 'category': r = String(a.category || '').localeCompare(String(b.category || '')); break;
      case 'price':    r = (a.price || 0) - (b.price || 0); break;
      case 'cost':     r = (a.cost_price || 0) - (b.cost_price || 0); break;
      case 'stock':    r = (a.quantity || 0) - (b.quantity || 0); break;
      case 'unit':     r = String(a.unit || '').localeCompare(String(b.unit || '')); break;
      default: r = 0;
    }
    return r * mul;
  };
}

function applyFiltersSort() {
  const term = S.search.trim().toLowerCase();
  const stockOn = S.ctx.app.flags.stock;
  const list = S.items.filter(it => {
    if (term) {
      const hit = String(it.item_code || '').toLowerCase().includes(term)
        || String(it.name || '').toLowerCase().includes(term)
        || String(it.category || '').toLowerCase().includes(term);
      if (!hit) return false;
    }
    if (S.filters.category && (it.category || '') !== S.filters.category) return false;
    if (stockOn && S.filters.status !== 'all') {
      const st = statusOf(it);
      if (S.filters.status === 'restock') { if (st === 'in') return false; }
      else if (st !== S.filters.status) return false;
    }
    if (S.filters.priceMin !== '' && (it.price || 0) < num(S.filters.priceMin, 0)) return false;
    if (S.filters.priceMax !== '' && (it.price || 0) > num(S.filters.priceMax, 0)) return false;
    return true;
  });
  list.sort(comparator(S.sort));
  S.filtered = list;
}

function setSort(key) {
  if (S.sort.key === key) S.sort.dir = S.sort.dir === 'asc' ? 'desc' : 'asc';
  else S.sort = { key, dir: 'asc' };
  refreshTable();
}

/* ============================ render ============================ */
function refreshFiltersAndTable() { renderFilters(); refreshTable(); }

function refreshTable() {
  applyFiltersSort();
  renderBanner();
  renderThead();
  renderTbody();
  renderCount();
}

function renderFilters() {
  const stockOn = S.ctx.app.flags.stock;
  const cats = uniqueCategories();
  const body = q('#filterBody', S.root);
  body.innerHTML = `
    <div>
      <div class="overline" style="margin-bottom:8px">Category</div>
      <div class="row gap2 wrap">
        <button class="chip ${!S.filters.category ? 'on' : ''}" data-cat="">All</button>
        ${cats.map(c => `<button class="chip ${S.filters.category === c ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
      </div>
    </div>
    ${stockOn ? `
    <div>
      <div class="overline" style="margin-bottom:8px">Stock status</div>
      <div class="row gap2 wrap">
        ${STATUS_OPTS.map(s => `<button class="chip ${S.filters.status === s.key ? 'on' : ''}" data-status="${s.key}">${esc(s.label)}</button>`).join('')}
      </div>
    </div>` : ''}
    <div>
      <div class="overline" style="margin-bottom:8px">Price range</div>
      <div class="row gap2">
        <input class="input input-sm" id="priceMin" placeholder="Min" inputmode="decimal" autocomplete="off" style="min-width:0;flex:1 1 0" value="${esc(S.filters.priceMin)}">
        <span class="muted small">–</span>
        <input class="input input-sm" id="priceMax" placeholder="Max" inputmode="decimal" autocomplete="off" style="min-width:0;flex:1 1 0" value="${esc(S.filters.priceMax)}">
      </div>
    </div>`;

  const active = !!(S.filters.category || S.filters.status !== 'all' || S.filters.priceMin || S.filters.priceMax);
  q('#clearFilters', S.root).style.display = active ? '' : 'none';
}

function renderBanner() {
  const host = q('#banner', S.root);
  if (!S.ctx.app.flags.stock) { host.innerHTML = ''; return; }
  const count = S.items.filter(it => statusOf(it) !== 'in').length;
  if (!count) { host.innerHTML = ''; return; }
  host.innerHTML = `
    <button class="row gap3 tap" id="restockBanner" style="width:100%;text-align:left;padding:12px 16px;
      background:var(--warn-soft);border:1px solid var(--warn);border-radius:var(--r-lg);color:var(--warn-ink)">
      ${icon('warn', 18)}
      <span class="grow" style="font-size:var(--t-13);font-weight:620">${count} item${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} restocking</span>
      ${icon('chevRight', 16)}
    </button>`;
}

const COLS = () => {
  const stockOn = S.ctx.app.flags.stock;
  return [
    { key: 'code', label: 'Code', width: 90, sort: true },
    { key: 'name', label: 'Product', grow: true, sort: true },
    { key: 'category', label: 'Category', width: 132, sort: true },
    { key: 'price', label: 'Price', width: 116, sort: true, right: true },
    ...(S.ctx.app.can.view_profit ? [{ key: 'cost', label: 'Cost', width: 116, sort: true, right: true }] : []),
    ...(stockOn ? [{ key: 'stock', label: 'Stock', width: 160, sort: true }] : []),
    ...(stockOn ? [{ key: 'status', label: 'Status', width: 104, center: true }] : []),
    { key: 'unit', label: 'Unit', width: 64, center: true },
    { key: 'pack', label: 'Pack size', width: 110 },
    { key: 'acts', label: '', width: 88 },
  ];
};

function renderThead() {
  const html = COLS().map(c => {
    const justify = c.right ? 'justify-content:flex-end' : c.center ? 'justify-content:center' : '';
    const style = c.grow ? '' : `style="width:${c.width}px;${justify}"`;
    const cls = c.grow ? 'grow' : '';
    if (!c.sort) return `<div class="${cls}" ${style}>${esc(c.label)}</div>`;
    const on_ = S.sort.key === c.key;
    const arrow = on_ ? icon(S.sort.dir === 'asc' ? 'arrowUp' : 'arrowDown', 11) : '';
    return `<div class="${cls}" ${style}><span class="sortable" data-sort="${c.key}">${esc(c.label)}${arrow}</span></div>`;
  }).join('');
  q('#thead', S.root).innerHTML = html;
}

function renderTbody() {
  const host = q('#tbody', S.root);
  if (S.loading) {
    host.innerHTML = Array.from({ length: 8 }).map(() =>
      `<div class="tr"><div class="skel" style="height:18px;width:100%;margin:auto 10px"></div></div>`).join('');
    return;
  }
  if (!S.filtered.length) {
    host.innerHTML = S.items.length
      ? emptyState('search', 'No items match', 'Try a different search, or clear your filters.')
      : emptyState('box', 'No items yet', 'Add your first item, or import a spreadsheet to get started.');
    return;
  }
  host.innerHTML = S.filtered.map(rowHtml).join('');
}

function rowHtml(it) {
  const stockOn = S.ctx.app.flags.stock;
  const st = statusOf(it);
  const pillCls = st === 'out' ? 'pill-bad' : st === 'low' ? 'pill-warn' : 'pill-ok';
  const pillLabel = st === 'out' ? 'Out of stock' : st === 'low' ? 'Low' : 'In stock';
  const barColor = st === 'out' ? 'var(--bad)' : st === 'low' ? 'var(--warn)' : 'var(--ok)';
  const th = Number(it.low_stock_threshold) || 0;
  const qv = Number(it.quantity) || 0;
  const pct = th > 0 ? Math.max(0, Math.min(100, (qv / (th * 2)) * 100)) : (qv > 0 ? 100 : 0);
  const pack = (it.pack_size && it.pack_unit_name) ? `${qty(it.pack_size)} / ${esc(it.pack_unit_name)}` : '—';

  return `<div class="tr" data-id="${it.id}" tabindex="0" role="button" title="Open ${esc(it.name)}">
    <div class="mono ellipsis" style="width:90px">${esc(it.item_code || '—')}</div>
    <div class="grow ellipsis strong">${esc(it.name)}</div>
    <div class="ellipsis" style="width:132px">${esc(it.category || '—')}</div>
    <div class="num-cell mono" style="width:116px">${inr(it.price)}</div>
    ${S.ctx.app.can.view_profit ? `<div class="num-cell mono" style="width:116px">${inr(it.cost_price)}</div>` : ''}
    ${stockOn ? `<div style="width:160px">
      <div class="stock-bar">
        <div class="bar"><i style="width:${pct}%;background:${barColor}"></i></div>
        <span class="mono small" style="min-width:36px;text-align:right">${qty(it.quantity)}</span>
      </div>
    </div>` : ''}
    ${stockOn ? `<div style="width:104px;text-align:center"><span class="pill ${pillCls}">${pillLabel}</span></div>` : ''}
    <div class="ellipsis" style="width:64px;text-align:center">${esc(it.unit || '—')}</div>
    <div class="ellipsis" style="width:110px">${pack}</div>
    <div class="acts" style="width:88px">
      <button class="btn btn-ghost btn-icon btn-sm" data-act="edit" title="Edit item">${icon('pencil', 14)}</button>
      <button class="btn btn-ghost btn-icon btn-sm" data-act="adjust" title="Adjust stock">${icon('refresh', 14)}</button>
      <button class="btn btn-ghost btn-icon btn-sm" data-act="delete" title="Delete item">${icon('trash', 14)}</button>
    </div>
  </div>`;
}

function renderCount() {
  const el_ = q('#count', S.root);
  if (!el_) return;
  const total = S.items.length, shown = S.filtered.length;
  const active = !!(S.search || S.filters.category || S.filters.status !== 'all' || S.filters.priceMin || S.filters.priceMax);
  if (!active) {
    el_.textContent = `${total} item${total !== 1 ? 's' : ''}`;
    el_.style.color = '';
  } else if (shown === 0) {
    el_.textContent = `No matches in ${total} item${total !== 1 ? 's' : ''}`;
    el_.style.color = 'var(--warn-ink)';
  } else {
    el_.textContent = `${shown} of ${total} items`;
    el_.style.color = '';
  }
}

/* ============================ interaction ============================ */
function wire() {
  const root = S.root;

  const doSearch = debounce(() => { S.search = q('#q', root).value; refreshTable(); }, 180);
  on(root, 'input', '#q', doSearch);

  const doPrice = debounce(() => {
    S.filters.priceMin = q('#priceMin', root)?.value.trim() || '';
    S.filters.priceMax = q('#priceMax', root)?.value.trim() || '';
    refreshTable();
  }, 220);
  on(root, 'input', '#priceMin', doPrice);
  on(root, 'input', '#priceMax', doPrice);

  on(root, 'click', '[data-cat]', (e, b) => { S.filters.category = b.dataset.cat; refreshFiltersAndTable(); });
  on(root, 'click', '[data-status]', (e, b) => { S.filters.status = b.dataset.status; refreshFiltersAndTable(); });
  on(root, 'click', '#clearFilters', () => {
    S.filters = { category: '', status: 'all', priceMin: '', priceMax: '' };
    refreshFiltersAndTable();
  });
  on(root, 'click', '#restockBanner', () => { S.filters.status = 'restock'; refreshFiltersAndTable(); });
  on(root, 'click', '.sortable', (e, b) => setSort(b.dataset.sort));

  on(root, 'click', '.tr[data-id]', (e, row) => {
    const it = S.byId.get(+row.dataset.id);
    if (!it) return;
    const actBtn = e.target.closest('[data-act]');
    if (actBtn) {
      const act = actBtn.dataset.act;
      if (act === 'edit') openItemModal(it);
      else if (act === 'adjust') openAdjustModal(it);
      else if (act === 'delete') deleteItem(it);
      return;
    }
    openItemModal(it);
  });
  on(root, 'keydown', '.tr[data-id]', (e, row) => {
    if (e.key === 'Enter') { e.preventDefault(); row.click(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); row.nextElementSibling?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); row.previousElementSibling?.focus(); }
  });
}

function moreMenu(anchor) {
  menu(anchor, [
    { label: 'Reset all stock', icon: 'refresh', danger: true, onClick: doResetStock },
  ]);
}

/* ============================ item modal ============================ */
function fieldRow(label, id, opts = {}) {
  return `<div class="field grow" style="${opts.style || ''}">
    <label class="label">${esc(label)}${opts.req ? '<span class="req">*</span>' : ''}</label>
    <input class="input" id="${id}" autocomplete="off" inputmode="${opts.decimal ? 'decimal' : 'text'}"
      placeholder="${esc(opts.ph || '')}" value="${esc(opts.val ?? '')}">
    <div class="tiny" style="color:var(--bad-ink);min-height:14px" data-err="${id}"></div>
  </div>`;
}

function setErr(body, id, msg) {
  const input = q('#' + id, body), err = q(`[data-err="${id}"]`, body);
  if (input) input.classList.toggle('is-bad', !!msg);
  if (err) err.textContent = msg || '';
}

function readItemForm(body, isEdit) {
  const val = (id) => (q('#' + id, body)?.value ?? '').trim();
  ['f-code', 'f-name', 'f-cat', 'f-unit', 'f-psize', 'f-punit', 'f-price', 'f-cost', 'f-qty', 'f-thresh']
    .forEach(id => setErr(body, id, ''));

  let ok = true;
  const name = val('f-name');
  if (!name) { setErr(body, 'f-name', 'Product name is required.'); ok = false; }
  else if (name.length > 120) { setErr(body, 'f-name', 'Keep it under 120 characters.'); ok = false; }

  const code = val('f-code');
  if (code && (!/^[A-Za-z0-9 ._/-]+$/.test(code) || code.length > 40)) {
    setErr(body, 'f-code', 'Only letters, numbers, spaces and . _ - / are allowed (max 40 characters).');
    ok = false;
  }

  const price = num(val('f-price'), NaN);
  if (!isFinite(price) || price < 0) { setErr(body, 'f-price', 'Enter a valid price of 0 or more.'); ok = false; }
  else if (price > 1e8) { setErr(body, 'f-price', 'That looks too large — check for an extra digit.'); ok = false; }

  // Cost price only exists in the form for an owner (see openItemModal) -
  // a staff account never sees or sends this field at all.
  const hasCost = !!q('#f-cost', body);
  let costPrice = null;
  if (hasCost) {
    costPrice = num(val('f-cost'), NaN);
    if (!isFinite(costPrice) || costPrice < 0) { setErr(body, 'f-cost', 'Enter a valid cost of 0 or more.'); ok = false; }
    else if (costPrice > 1e8) { setErr(body, 'f-cost', 'That looks too large — check for an extra digit.'); ok = false; }
  }

  const thresh = num(val('f-thresh'), NaN);
  if (!isFinite(thresh) || thresh < 0) { setErr(body, 'f-thresh', 'Enter a valid number of 0 or more.'); ok = false; }

  let openQty = null;
  if (!isEdit) {
    openQty = num(val('f-qty'), NaN);
    if (!isFinite(openQty) || openQty < 0) { setErr(body, 'f-qty', 'Enter a valid quantity of 0 or more.'); ok = false; }
  }

  const psizeStr = val('f-psize');
  let packSize = null, packUnit = val('f-punit');
  if (psizeStr) {
    packSize = num(psizeStr, NaN);
    if (!isFinite(packSize) || packSize <= 0) {
      setErr(body, 'f-psize', 'Must be a positive number, or leave it blank.'); ok = false;
    } else if (!packUnit) {
      setErr(body, 'f-punit', 'Name the larger unit (e.g. Carton) since a pack size was set.'); ok = false;
    }
  } else {
    packSize = null; packUnit = '';
  }

  if (!ok) return null;

  return {
    item_code: code, name, category: val('f-cat'),
    unit: val('f-unit') || 'pcs',
    price: +price.toFixed(2),
    low_stock_threshold: +thresh.toFixed(3),
    pack_size: packSize != null ? +packSize.toFixed(3) : null,
    pack_unit_name: packSize != null ? packUnit : '',
    ...(openQty != null ? { quantity: +openQty.toFixed(3) } : {}),
    ...(hasCost ? { cost_price: +costPrice.toFixed(2) } : {}),
  };
}

async function openItemModal(item) {
  const isEdit = !!item;
  const body = node(`<div class="col gap4">
    <div class="row gap3">
      ${fieldRow('Item code', 'f-code', { val: item?.item_code || '' })}
      ${fieldRow('Product name', 'f-name', { req: true, val: item?.name || '' })}
    </div>
    <div class="row gap3">
      ${fieldRow('Category', 'f-cat', { val: item?.category || '' })}
      ${fieldRow('Unit', 'f-unit', { val: item?.unit || (isEdit ? '' : 'pcs'), ph: 'pcs' })}
    </div>
    <div class="row gap3">
      ${fieldRow('Pack size', 'f-psize', { val: item?.pack_size != null ? qty(item.pack_size) : '', ph: 'e.g. 16', decimal: true })}
      ${fieldRow('Pack unit name', 'f-punit', { val: item?.pack_unit_name || '', ph: 'e.g. Carton' })}
    </div>
    <div class="tiny muted" style="margin-top:-10px">
      Pack size is how many of the base unit make up one larger unit (e.g. 16 jars per Carton).
      Leave both blank if this item isn't sold by carton, box or packet.
    </div>
    <div class="divider"></div>
    <div class="row gap3">
      ${fieldRow('Price (Rs.)', 'f-price', { req: true, val: item ? String(item.price) : '0', decimal: true })}
      ${S.ctx.app.can.view_profit ? fieldRow('Cost price (Rs.)', 'f-cost', { val: item ? String(item.cost_price ?? 0) : '0', decimal: true }) : ''}
      ${!isEdit ? fieldRow('Opening stock', 'f-qty', { val: '0', decimal: true }) : ''}
      ${fieldRow('Low stock alert at', 'f-thresh', { val: item ? String(item.low_stock_threshold ?? 5) : '10', decimal: true })}
    </div>
    ${S.ctx.app.can.view_profit ? `<div class="tiny muted" style="margin-top:-10px">Cost price is only visible to the owner - it never prints on a bill and staff accounts never see it.</div>` : ''}
    ${isEdit ? `<div class="row between" style="padding:10px 12px;background:var(--surface-2);border-radius:var(--r-md)">
      <span class="small">Current stock: <b class="mono">${qty(item.quantity)} ${esc(item.unit || '')}</b></span>
      <button class="btn btn-ghost btn-sm" id="goAdjust">${icon('refresh', 14)}Adjust stock</button>
    </div>` : ''}
  </div>`);

  const res = await modal({
    title: isEdit ? `Edit item: ${item.name}` : 'Add new item',
    icon: isEdit ? 'pencil' : 'plus',
    wide: 'modal-wide',
    body,
    actions: [
      { label: 'Cancel', value: false },
      {
        label: isEdit ? 'Save changes' : 'Add item', cls: 'btn-primary', default: true,
        onClick: async () => {
          const data = readItemForm(body, isEdit);
          if (!data) return false;
          try {
            if (isEdit) await api.update_item(item.id, data);
            else await api.add_item(data);
            toast(isEdit ? 'Item updated' : 'Item added', `${data.name} was saved.`, 'ok');
          } catch (e) {
            toast(isEdit ? 'Could not save item' : 'Could not add item', e.message, 'bad');
            return false;
          }
          return true;
        },
      },
    ],
    onOpen: (bd, close) => {
      q('#goAdjust', bd)?.addEventListener('click', (e) => {
        e.preventDefault();
        close(null);
        openAdjustModal(item);
      });
    },
  });
  if (res) await reload();
}

/* ============================ adjust stock modal ============================ */
async function openAdjustModal(item) {
  const body = node(`<div class="col gap4">
    <div class="row between" style="padding:10px 12px;background:var(--surface-2);border-radius:var(--r-md)">
      <span class="small">Current stock</span>
      <b class="mono">${qty(item.quantity)} ${esc(item.unit || '')}</b>
    </div>
    <div class="field">
      <label class="label">Type</label>
      <div class="seg" id="adjType" style="width:100%">
        <button class="on" data-t="Restock" style="flex:1">Restock</button>
        <button data-t="Damaged" style="flex:1">Damaged</button>
        <button data-t="Manual Adjustment" style="flex:1">Manual</button>
      </div>
    </div>
    <div class="row gap3" style="align-items:flex-end">
      <div class="field grow">
        <label class="label">Quantity<span class="req">*</span></label>
        <input class="input mono" id="adjQty" placeholder="0" inputmode="decimal" autocomplete="off">
      </div>
      <div class="seg" id="adjSign" style="display:none">
        <button class="on" data-s="+">+</button>
        <button data-s="-">−</button>
      </div>
    </div>
    <div class="tiny" style="color:var(--bad-ink);min-height:14px" data-err="adjQty"></div>
    <div class="field">
      <label class="label">Reference / reason</label>
      <input class="input" id="adjNote" placeholder="Optional — e.g. Delivery from supplier" autocomplete="off">
    </div>
  </div>`);

  let type = 'Restock', sign = '+';

  const res = await modal({
    title: `Adjust stock — ${item.name}`,
    icon: 'refresh', tone: 'info',
    body,
    actions: [
      { label: 'Cancel', value: false },
      {
        label: 'Apply adjustment', cls: 'btn-primary', default: true,
        onClick: async () => {
          const raw = q('#adjQty', body).value.trim();
          const n = num(raw, NaN);
          if (!isFinite(n) || n <= 0) {
            q('#adjQty', body).classList.add('is-bad');
            q('[data-err=adjQty]', body).textContent = 'Enter a quantity greater than 0.';
            return false;
          }
          q('#adjQty', body).classList.remove('is-bad');
          q('[data-err=adjQty]', body).textContent = '';
          const delta = type === 'Damaged' ? -n : type === 'Manual Adjustment' ? (sign === '+' ? n : -n) : n;
          try {
            await api.adjust_stock(item.id, +delta.toFixed(3), type, q('#adjNote', body).value.trim());
            toast('Stock adjusted', `${item.name}: ${delta > 0 ? '+' : ''}${qty(delta)} (${type}).`, 'ok');
          } catch (e) {
            toast('Could not adjust stock', e.message, 'bad');
            return false;
          }
          return true;
        },
      },
    ],
    onOpen: (bd) => {
      on(q('#adjType', bd), 'click', 'button', (e, b) => {
        qa('button', q('#adjType', bd)).forEach(x => x.classList.toggle('on', x === b));
        type = b.dataset.t;
        q('#adjSign', bd).style.display = type === 'Manual Adjustment' ? 'inline-flex' : 'none';
      });
      on(q('#adjSign', bd), 'click', 'button', (e, b) => {
        qa('button', q('#adjSign', bd)).forEach(x => x.classList.toggle('on', x === b));
        sign = b.dataset.s;
      });
    },
  });
  if (res) await reload();
}

/* ============================ delete / import / export / reset ============================ */
async function deleteItem(item) {
  const yes = await confirm('Delete this item?',
    `Delete "${item.name}"? This can't be undone, and it will disappear from bills and history that reference it.`,
    { danger: true, ok: 'Delete' });
  if (!yes) return;
  try {
    await api.delete_item(item.id);
    toast('Item deleted', `${item.name} was removed.`, 'ok');
    await reload();
  } catch (e) { toast('Could not delete item', e.message, 'bad'); }
}

async function doImport() {
  try {
    const res = await api.import_items();
    const { added = 0, updated = 0, skipped = 0 } = res || {};
    toast('Import complete',
      `${added} added, ${updated} updated, ${skipped} skipped. Live stock quantities are never changed by an import.`,
      'ok', 6000);
    await reload();
  } catch (e) { toast('Import failed', e.message, 'bad'); }
}

async function doExport() {
  try {
    const path = await api.export_items();
    toast('Exported', `Inventory saved to ${path}`, 'ok');
  } catch (e) { toast('Export failed', e.message, 'bad'); }
}

async function doResetStock() {
  const yes = await confirm('Reset all stock?',
    'This will set the quantity of every item in inventory to 0.\n\nDo you want to continue?',
    { danger: true, ok: 'Reset to 0' });
  if (!yes) return;
  try {
    await api.reset_all_stock();
    toast('Stock reset', 'All item quantities are now zero.', 'ok');
    await reload();
  } catch (e) { toast('Could not reset inventory', e.message, 'bad'); }
}
