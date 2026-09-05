/* ============================================================
   views/stock.js — Stock History: a read-only, chronological audit
   trail of every stock change (sales, restocks, damage, manual
   adjustments). A collapsible summary panel sits above the table;
   drag or double-click its edge to resize or tuck it away.
   ============================================================ */

import { api } from '../api.js';
import {
  q, on, esc, icon, qty, toast, confirm, emptyState, debounce, dmy, hm12,
} from '../core.js';

const TYPES = [
  { key: 'all', label: 'All' },
  { key: 'Sale', label: 'Sale' },
  { key: 'Restock', label: 'Restock' },
  { key: 'Damaged', label: 'Damaged' },
  { key: 'Manual Adjustment', label: 'Manual Adjustment' },
];

let S = null;

export default {
  title: 'Stock History',

  async mount(root, ctx) {
    S = { ctx, root, txns: [], search: '', type: 'all', loading: true };

    if (!ctx.app.flags.stock) { paintDisabled(root); return; }

    paint(root);
    renderThead();
    renderTypeChips();
    wire();

    ctx.setActions(isOwner()
      ? [{ label: 'Clear history', icon: 'trash', cls: 'btn-danger', onClick: doClearHistory }]
      : [{ label: 'Clear history', icon: 'trash', cls: 'btn-danger is-disabled', title: 'Only the store owner can clear stock history' }]);

    await reload();
  },

  destroy() { S = null; },
};

/* ============================ layout ============================ */
function paintDisabled(root) {
  root.innerHTML = `<div class="col grow" style="padding:var(--s5)">
    <div class="panel grow">
      ${emptyState('box', 'Stock tracking is off',
        'Turn on stock tracking in Settings to start recording sales, restocks and manual adjustments here.')}
    </div>
  </div>`;
}

function paint(root) {
  root.innerHTML = `
  <div class="split split-v grow" data-split="stock.summary" style="padding:var(--s4) var(--s5) var(--s5)">
    <div class="pane pane-sized" data-size="132" data-min="0" data-max="240">
      <div class="panel grow">
        <div class="panel-head">
          ${icon('chart', 16)}<div class="h2 grow">Movement summary</div>
          <span class="small muted">Current view</span>
        </div>
        <div style="padding:14px 16px" id="summaryBody"></div>
      </div>
    </div>

    <div class="pane pane-fill" style="padding-top:6px">
      <div class="panel grow">
        <div class="panel-head col" style="align-items:stretch;gap:10px;padding-bottom:10px;height:auto">
          <div class="row gap3">
            <div class="search" style="width:300px;flex:none">
              ${icon('search', 15)}<input id="q" placeholder="Search by item, reference or type…" autocomplete="off">
            </div>
            <span class="small muted grow" id="count"></span>
          </div>
          <div class="row gap2 wrap" id="typeChips"></div>
        </div>
        <div class="tbl-head" id="thead"></div>
        <div class="tbl-body" id="tbody"></div>
        <div class="panel-foot small muted" id="capNote" style="display:none">
          Showing the most recent 500 records. Search to look further back.
        </div>
      </div>
    </div>
  </div>`;
}

// Ask the backend what is allowed rather than guessing from a role:
// with sign-in off there is no user, and every permission is granted.
function isOwner() { return S.ctx.app.can?.clear_stock_history !== false; }

/* ============================ data ============================ */
async function reload() {
  S.loading = true;
  renderTbody();
  try {
    S.txns = await api.inventory_transactions(S.search || '') || [];
  if (!S) return;   // the screen was left while this was in flight
  } catch (e) {
    S.txns = [];
    toast('Could not load stock history', e.message, 'bad');
  }
  S.loading = false;
  renderAll();
}

function filteredTxns() {
  if (S.type === 'all') return S.txns;
  return S.txns.filter(t => t.change_type === S.type);
}

function renderAll() {
  renderSummary();
  renderTbody();
  renderCount();
  const cap = q('#capNote', S.root);
  if (cap) cap.style.display = (!S.search && S.txns.length >= 500) ? '' : 'none';
}

/* ============================ render ============================ */
function renderTypeChips() {
  q('#typeChips', S.root).innerHTML = TYPES.map(t =>
    `<button class="chip ${S.type === t.key ? 'on' : ''}" data-type="${esc(t.key)}">${esc(t.label)}</button>`).join('');
}

function renderThead() {
  q('#thead', S.root).innerHTML = `
    <div style="width:200px">Date &amp; time</div>
    <div class="grow">Product</div>
    <div style="width:150px;text-align:center">Type</div>
    <div class="num-cell" style="width:100px">Qty change</div>
    <div class="num-cell" style="width:126px">Resulting stock</div>
    <div style="width:170px">Reference</div>`;
}

function typePill(t) {
  const map = { Sale: 'pill-info', Restock: 'pill-ok', Damaged: 'pill-bad', 'Manual Adjustment': 'pill-warn' };
  return map[t] || 'pill';
}

function rowHtml(t) {
  const [d, tm] = String(t.created_at || '').split(' ');
  const change = Number(t.quantity_change) || 0;
  const changeColor = change > 0 ? 'var(--ok-ink)' : change < 0 ? 'var(--bad-ink)' : 'var(--ink-3)';
  const changeText = change > 0 ? `+${qty(change)}` : qty(change);
  const resulting = (t.resulting_quantity === null || t.resulting_quantity === undefined) ? '—' : qty(t.resulting_quantity);

  return `<div class="tr">
    <div class="mono ellipsis" style="width:200px">${d ? dmy(d) : '—'}${tm ? ' · ' + hm12(tm.slice(0, 5)) : ''}</div>
    <div class="grow ellipsis">${esc(t.item_name || '—')}</div>
    <div style="width:150px;text-align:center"><span class="pill ${typePill(t.change_type)}">${esc(t.change_type || '—')}</span></div>
    <div class="num-cell mono" style="width:100px;color:${changeColor}">${changeText}</div>
    <div class="num-cell mono" style="width:126px">${resulting}</div>
    <div class="ellipsis" style="width:170px">${esc(t.reference || '—')}</div>
  </div>`;
}

function renderTbody() {
  const host = q('#tbody', S.root);
  if (S.loading) {
    host.innerHTML = Array.from({ length: 8 }).map(() =>
      `<div class="tr"><div class="skel" style="height:18px;width:100%;margin:auto 10px"></div></div>`).join('');
    return;
  }
  const list = filteredTxns();
  if (!list.length) {
    host.innerHTML = S.txns.length
      ? emptyState('filter', 'No matching movements', 'Try a different search or type filter.')
      : emptyState('history', 'No stock movements yet', 'Sales, restocks and adjustments will show up here as they happen.');
    return;
  }
  host.innerHTML = list.map(rowHtml).join('');
}

function renderCount() {
  const el_ = q('#count', S.root);
  if (!el_) return;
  const shown = filteredTxns().length, total = S.txns.length;
  el_.textContent = S.type === 'all'
    ? `${total} record${total !== 1 ? 's' : ''}`
    : `${shown} of ${total} record${total !== 1 ? 's' : ''}`;
}

function renderSummary() {
  const list = filteredTxns();
  const totalIn = list.reduce((s, t) => s + Math.max(0, Number(t.quantity_change) || 0), 0);
  const totalOut = list.reduce((s, t) => s + Math.max(0, -(Number(t.quantity_change) || 0)), 0);
  const net = totalIn - totalOut;
  const max = Math.max(totalIn, totalOut, 1);

  q('#summaryBody', S.root).innerHTML = `
    <div class="row gap6" style="align-items:flex-start;flex-wrap:wrap">
      <div class="col gap1">
        <span class="overline">In</span>
        <span class="h1 mono" style="color:var(--ok-ink)">+${qty(totalIn)}</span>
      </div>
      <div class="col gap1">
        <span class="overline">Out</span>
        <span class="h1 mono" style="color:var(--bad-ink)">-${qty(totalOut)}</span>
      </div>
      <div class="col gap1">
        <span class="overline">Net</span>
        <span class="h1 mono" style="color:${net >= 0 ? 'var(--ok-ink)' : 'var(--bad-ink)'}">${net >= 0 ? '+' : ''}${qty(net)}</span>
      </div>
      <div class="grow col gap2" style="min-width:180px;padding-top:2px">
        <div class="row between"><span class="tiny muted">In</span><span class="tiny mono">${qty(totalIn)}</span></div>
        <div class="bar"><i style="width:${(totalIn / max) * 100}%;background:var(--ok)"></i></div>
        <div class="row between" style="margin-top:6px"><span class="tiny muted">Out</span><span class="tiny mono">${qty(totalOut)}</span></div>
        <div class="bar"><i style="width:${(totalOut / max) * 100}%;background:var(--bad)"></i></div>
      </div>
    </div>`;
}

/* ============================ interaction ============================ */
function wire() {
  const root = S.root;

  const doSearch = debounce(async () => {
    S.search = q('#q', root).value.trim();
    await reload();
  }, 220);
  on(root, 'input', '#q', doSearch);

  on(root, 'click', '[data-type]', (e, b) => {
    S.type = b.dataset.type;
    renderTypeChips();
    renderAll();
  });
}

async function doClearHistory() {
  if (!isOwner()) return;
  const count = filteredTxns().length;
  const yes = await confirm('Clear stock history?',
    `Delete all ${count} stock history record${count !== 1 ? 's' : ''}?\n\n` +
    'This is the record of every stock change ever made. It cannot be undone, and it does not change any current stock figure.',
    { danger: true, ok: 'Delete all' });
  if (!yes) return;
  try {
    await api.clear_inventory_transactions();
    toast('Stock history cleared', 'Every stock movement record has been deleted.', 'ok');
    S.search = '';
    const qEl = q('#q', S.root); if (qEl) qEl.value = '';
    S.type = 'all';
    renderTypeChips();
    await reload();
  } catch (e) { toast('Could not clear history', e.message, 'bad'); }
}
