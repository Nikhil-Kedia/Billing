/* ============================================================
   views/newbill.js — the counter screen.

   Every keyboard rule from the original app is preserved:
     *        from the customer row → jump to the first item's code
              anywhere else        → save & print, immediately
     Enter    flows forward; on the last row's price it adds a row
     ↑↓←→     move around the form like a grid (← / → only when the
              caret is already at the edge of the text)
     focus    selects what's there, so you type over it
   New here: Ctrl+Enter saves, Ctrl+D removes the focused row, and
   the panels either side of the items list can be resized/collapsed.
   ============================================================ */

import { api } from '../api.js';
import * as AC from '../ac.js';
import {
  q, qa, el, node, on, esc, icon, inr, qty as fmtQty, num, toast, modal, confirm,
  todayISO, nowHM, initials, emptyState, prefs,
} from '../core.js';

const MAX_SUGGEST = 40;
const MAX_ITEMS = 200;

let S = null;   // screen state

export default {
  title: 'New Bill',

  async mount(root, ctx) {
    S = {
      ctx, root,
      items: [], byCodeLc: new Map(), byNameLc: new Map(), byId: new Map(), byNameExact: new Map(),
      customers: [], custId: null,
      rows: [], billType: 'sale', editing: ctx.params?.bill || null,
      lastAutoTotal: 0, lastPdf: null, savedBill: null, seq: 0,
    };

    paint(root);
    wire();

    ctx.setActions([
      { label: 'Reset', icon: 'refresh', cls: 'btn-ghost', onClick: resetForm },
      { label: '', icon: 'dots', cls: 'btn-ghost', iconOnly: true, title: 'More actions', onClick: (e, b) => moreMenu(b) },
      { label: 'Save & Print', icon: 'print', cls: 'btn-grad', onClick: () => save() },
    ]);

    await loadCaches();
    if (S.editing) { preload(S.editing); ctx.setTitle('Edit Bill'); }
    else { addRow(); }
    recalc();
    setTimeout(() => { if (S) S.f.name.focus(); }, 80);

    try { const n = await api.next_bill_number(); if (S) q('#billNo', root).textContent = n; } catch {}
  },

  destroy() { AC.closeAC(); S = null; },
};

/* ============================ layout ============================ */
function paint(root) {
  root.innerHTML = `
  <div class="split split-h grow" data-split="newbill.summary" style="padding:var(--s4) var(--s5) var(--s5)">
    <div class="pane pane-fill" style="padding-right:6px">

      <div class="split split-v grow" data-split="newbill.customer">
        <!-- customer -->
        <div class="pane pane-sized" data-size="104" data-min="72" data-max="230" style="padding-bottom:6px">
          <div class="panel grow">
            <div class="row gap3" style="padding:12px 14px;align-items:flex-end">
              <div class="field grow" style="max-width:280px">
                <label class="label" id="lblCustomer">Customer<span class="req">*</span></label>
                <input class="input" id="f-name" autocomplete="off" placeholder="Start typing a name…">
              </div>
              <div class="field" style="width:150px">
                <label class="label">Phone</label>
                <input class="input mono" id="f-phone" autocomplete="off" placeholder="98530 21456">
              </div>
              <div class="field grow" style="min-width:160px">
                <label class="label">Address</label>
                <input class="input" id="f-addr" autocomplete="off" placeholder="Town, district">
              </div>
              <div class="field" style="width:132px">
                <label class="label">Date</label>
                <input class="input mono" id="f-date" autocomplete="off">
              </div>
              <div class="field" style="width:92px">
                <label class="label">Time</label>
                <input class="input mono" id="f-time" autocomplete="off">
              </div>
            </div>
          </div>
        </div>

        <!-- items -->
        <div class="pane pane-fill" style="padding-top:6px">
          <div class="panel grow">
            <div class="panel-head">
              <div class="h2 grow">Items</div>
              <span class="pill" id="itemCount">0 lines</span>
              <button class="btn btn-sm" id="addRow">${icon('plus', 14)}Add row <kbd style="margin-left:2px">Enter</kbd></button>
            </div>
            <div class="bill-grid col grow" style="min-height:0">
              <div class="bill-head">
                <div style="text-align:center">#</div>
                <div>Item code</div>
                <div>Product</div>
                <div style="text-align:center">Pack</div>
                <div style="text-align:right">Qty</div>
                <div style="text-align:center">Unit</div>
                <div style="text-align:right">Price</div>
                <div style="text-align:right">Amount</div>
                <div></div>
              </div>
              <div class="grow scroll-y" id="rows"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- summary -->
    <div class="pane pane-sized" data-size="336" data-min="280" data-max="520" style="padding-left:6px">
      <div class="panel grow scroll-y">
        <div style="padding:14px 16px" class="col gap4">

          <div class="row between">
            <div>
              <div class="overline">Bill</div>
              <div class="mono" style="font-size:var(--t-15);font-weight:650" id="billNo">—</div>
            </div>
            <div class="seg" id="billType">
              <button class="on" data-t="sale">Sale</button>
              <button data-t="purchase">Purchase</button>
            </div>
          </div>

          <div class="divider"></div>

          <div>
            <div class="sum-line"><span class="k">Subtotal</span><span class="v" id="s-sub">Rs. 0.00</span></div>
            <div class="sum-line">
              <span class="k">Addition</span>
              <input class="input input-sm mono" id="f-add" style="width:112px;text-align:right" placeholder="0.00">
            </div>
            <div class="sum-line">
              <span class="k">Less</span>
              <input class="input input-sm mono" id="f-less" style="width:112px;text-align:right" placeholder="0.00">
            </div>
          </div>

          <div class="grand">
            <span style="font-size:var(--t-13);font-weight:600">Grand total</span>
            <span class="v" id="s-total">Rs. 0.00</span>
          </div>

          <div class="field">
            <label class="label">Notes</label>
            <input class="input" id="f-notes" placeholder="Anything to remember about this bill">
          </div>

          <div class="divider"></div>

          <div class="row between">
            <span class="small muted">Previous balance</span>
            <span class="mono small" id="s-prev" style="color:var(--ok-ink);font-weight:650">Rs. 0.00</span>
          </div>

          <div class="field">
            <label class="label">Amount paid now</label>
            <input class="input mono" id="f-paid" style="text-align:right" placeholder="0.00">
          </div>

          <div>
            <div class="overline" style="margin-bottom:7px">Payment</div>
            <div class="paytype" id="payType">
              <button class="on" data-p="cash">${icon('card', 16)}Cash</button>
              <button data-p="upi">${icon('sparkles', 16)}UPI</button>
              <button data-p="credit">${icon('rupee', 16)}Credit</button>
            </div>
          </div>

          <button class="btn btn-grad btn-lg" id="saveBtn" style="width:100%;margin-top:2px">
            ${icon('print', 16)}Save &amp; Print<kbd style="margin-left:4px;background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.3);color:#fff">*</kbd>
          </button>
          <div class="tiny muted center" id="status" style="min-height:16px;text-align:center"></div>
        </div>
      </div>
    </div>
  </div>`;

  S.f = {
    name: q('#f-name', root), phone: q('#f-phone', root), addr: q('#f-addr', root),
    date: q('#f-date', root), time: q('#f-time', root),
    add: q('#f-add', root), less: q('#f-less', root),
    notes: q('#f-notes', root), paid: q('#f-paid', root),
  };
  S.rowsHost = q('#rows', root);
  S.saveBtn = q('#saveBtn', root);
  S.f.date.value = todayISO();
  S.f.time.value = nowHM();
}

/* ============================ caches ============================ */
async function loadCaches() {
  try {
    const [items, custs] = await Promise.all([api.items_snapshot(), api.customers_snapshot()]);
    S.items = items || [];
    S.customers = custs || [];
    S.byCodeLc.clear(); S.byNameLc.clear(); S.byId.clear(); S.byNameExact.clear();
    S.items.forEach(it => {
      S.byId.set(it.id, it);
      if (it.item_code) S.byCodeLc.set(String(it.item_code).toLowerCase(), it);
      S.byNameLc.set(String(it.name).toLowerCase(), it);
      S.byNameExact.set(String(it.name), it);      // case-sensitive, as the old app resolved item_id
    });
  } catch (e) {
    toast('Could not load the catalogue', e.message, 'bad');
  }
}

/* ============================ rows ============================ */
function addRow(data = null, focusIt = false) {
  const r = { id: ++S.seq, itemId: null, packSize: null, packUnit: '' };
  r.el = node(`
    <div class="bill-row" data-row="${r.id}">
      <div class="sn"></div>
      <div><input data-f="code" autocomplete="off" placeholder="code"></div>
      <div><input data-f="name" autocomplete="off" placeholder="Product name"></div>
      <div class="pack-cell"><input data-f="pack" autocomplete="off" placeholder="—" disabled><span class="pack-star"></span></div>
      <div class="cell-num"><input data-f="qty" autocomplete="off" placeholder="0"></div>
      <div><input data-f="unit" disabled placeholder="—" style="text-align:center"></div>
      <div class="cell-num"><input data-f="price" autocomplete="off" placeholder="0.00"></div>
      <div class="line-total">Rs. 0.00</div>
      <button class="kill" title="Remove this line (Ctrl+D)">${icon('x', 14)}</button>
    </div>`);

  r.code = q('[data-f=code]', r.el); r.name = q('[data-f=name]', r.el);
  r.pack = q('[data-f=pack]', r.el); r.qtyEl = q('[data-f=qty]', r.el);
  r.unit = q('[data-f=unit]', r.el); r.price = q('[data-f=price]', r.el);
  r.total = q('.line-total', r.el); r.star = q('.pack-star', r.el);

  q('.kill', r.el).onclick = () => removeRow(r);

  r.code.addEventListener('input', () => onCodeTyped(r));
  r.name.addEventListener('input', () => onNameTyped(r));
  r.qtyEl.addEventListener('input', () => { syncPackFromQty(r); recalc(); });
  r.price.addEventListener('input', recalc);
  r.pack.addEventListener('input', () => onPackTyped(r));

  S.rowsHost.appendChild(r.el);
  S.rows.push(r);

  if (data) {
    r.code.value = data.item_code || '';
    r.name.value = data.item_name || '';
    r.qtyEl.value = data.quantity ?? '';
    r.price.value = data.price_per_unit ?? '';
    r.unit.value = data.unit || '';
    r.itemId = data.item_id ?? null;
    // an edited bill keeps the pack information it was saved with
    setPack(r, data.pack_size, data.pack_unit_name);
    if (data.pack_qty) r.pack.value = data.pack_qty;
  }

  renumber();
  if (focusIt) { r.code.focus(); r.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  return r;
}

function removeRow(r) {
  const i = S.rows.indexOf(r);
  if (i < 0) return;
  r.el.style.transition = 'opacity .16s, transform .16s';
  r.el.style.opacity = '0';
  r.el.style.transform = 'translateX(-8px)';
  setTimeout(() => r.el.remove(), 160);
  S.rows.splice(i, 1);
  if (!S.rows.length) addRow();
  renumber(); recalc();
  S.f.add.focus();               // matches the original: focus lands on Addition
}

function renumber() {
  if (!S) return;
  S.rows.forEach((r, i) => { q('.sn', r.el).textContent = i + 1; });
  const live = S.rows.filter(validRow).length;
  const c = q('#itemCount', S.root);
  if (c) c.textContent = live === 1 ? '1 line' : `${live} lines`;
}

const validRow = (r) => {
  const qv = num(r.qtyEl.value, NaN), pv = num(r.price.value, NaN);
  return r.name.value.trim() && isFinite(qv) && qv > 0 && isFinite(pv);
};

/* ---------- pack ↔ quantity, and the red remainder star ----------
   Most items in a real inventory never get a "Pack size" configured in
   Inventory (of 413 real items here, exactly one has it set) - but a
   wholesaler still buys everything by the carton or box, configured or
   not. So a real, configured pack (packSize + packUnit both set) works
   exactly as before everywhere; on a PURCHASE bill specifically, an item
   with no configured pack still gets a *usable* Pack column, standing in
   at 1 pack = 1 base unit until someone sets the item's real pack size.
   Sale bills are unaffected - Pack stays disabled there without a real
   configured pack, exactly like before. */
function effPackSize(r) {
  return r.packSize || (S.billType === 'purchase' ? 1 : null);
}

function refreshPackUsable(r) {
  const hasRealPack = !!(r.packSize && r.packUnit);
  const usable = hasRealPack || S.billType === 'purchase';
  r.pack.disabled = !usable;
  r.pack.placeholder = hasRealPack ? r.packUnit : (usable ? 'packs' : '—');
  if (!usable) { r.pack.value = ''; r.star.textContent = ''; }
  else syncPackFromQty(r);
}

function setPack(r, size, unitName) {
  r.packSize = size ? Number(size) : null;
  r.packUnit = unitName || '';
  refreshPackUsable(r);
}

function syncPackFromQty(r) {
  const size = effPackSize(r);
  if (r._sync || !size) return;
  const v = num(r.qtyEl.value, NaN);
  if (!isFinite(v) || v < 0) { r.star.textContent = ''; return; }
  r._sync = true;
  const whole = Math.floor(v / size);
  const rem = v - whole * size;
  r.pack.value = whole ? String(whole) : '';
  r.star.textContent = Math.abs(rem) > 1e-9 ? '*' : '';
  r.star.title = r.star.textContent ? `${fmtQty(rem)} loose beyond ${whole} × ${r.packUnit || 'pack'}` : '';
  r._sync = false;
}

function onPackTyped(r) {
  const size = effPackSize(r);
  if (r._sync || !size) return;
  const p = num(r.pack.value, NaN);
  if (!isFinite(p) || p < 0) return;
  r._sync = true;
  r.qtyEl.value = String(+(p * size).toFixed(3));
  r.star.textContent = '';
  r._sync = false;
  recalc();
}

/* ---------- product autocomplete ---------- */
function applyItem(r, it, { setQtyOne = false } = {}) {
  r.itemId = it.id;
  r.code.value = it.item_code || '';
  r.name.value = it.name;
  r.unit.value = it.unit || '';
  r.price.value = it.price ?? '';          // price is always refreshed from the catalogue
  if (setQtyOne && !num(r.qtyEl.value, 0)) r.qtyEl.value = '1';
  setPack(r, it.pack_size, it.pack_unit_name);
  recalc();
}

/** Where focus lands right after an item code resolves (typed exact
    match, or picked from the code suggestions) - Quantity on a sale,
    Pack on a purchase (see refreshPackUsable() above: Pack is always
    usable on a purchase, configured pack size or not). Kept in one
    place so the Enter-key flow (enterKey(), below) and picking a
    suggestion by click never disagree with each other. */
function focusAfterCode(r) {
  if (S.billType === 'purchase' && !r.pack.disabled) focusCell(r.pack);
  else focusCell(r.qtyEl);
}

function onCodeTyped(r) {
  const t = r.code.value.trim().toLowerCase();
  if (!t) { AC.closeAC(); return; }
  const exact = S.byCodeLc.get(t);
  if (exact) { AC.closeAC(); applyItem(r, exact, { setQtyOne: true }); return; }
  const hits = S.items.filter(i => String(i.item_code || '').toLowerCase().includes(t)).slice(0, MAX_SUGGEST);
  AC.show(r.code, hits.map(i => ({ label: i.item_code, sub: i.name, value: i })),
    (it) => { applyItem(r, it, { setQtyOne: true }); focusAfterCode(r); }, t);
}

function onNameTyped(r) {
  const t = r.name.value.trim().toLowerCase();
  if (!t) { AC.closeAC(); return; }
  const exact = S.byNameLc.get(t);
  if (exact) { AC.closeAC(); applyItem(r, exact); return; }
  const hits = S.items.filter(i => String(i.name).toLowerCase().includes(t)).slice(0, MAX_SUGGEST);
  AC.show(r.name, hits.map(i => ({
    label: i.name,
    sub: `${inr(i.price)}${i.quantity != null ? ' · ' + fmtQty(i.quantity) + ' left' : ''}`,
    value: i,
  })), (it) => { applyItem(r, it); r.qtyEl.focus(); }, t);
}

/* ---------- customer autocomplete ---------- */
function fillCustomer(c) {
  S.custId = c.id;
  S.f.name.value = c.name; S.f.phone.value = c.phone || ''; S.f.addr.value = c.address || '';
  showBalance(c.id);
}

function custRow(c, main) {
  const bits = [c.phone, c.address].filter(Boolean).join(', ');
  return { label: main, sub: bits, value: c };
}

function onCustTyped() {
  const t = S.f.name.value.trim().toLowerCase();
  if (!t) { AC.closeAC(); S.custId = null; showBalance(null); return; }
  const subs = S.customers.filter(c => c.name.toLowerCase().includes(t));
  const exact = subs.filter(c => c.name.toLowerCase() === t);
  if (subs.length === 1 && exact.length === 1) { AC.closeAC(); fillCustomer(subs[0]); return; }
  AC.show(S.f.name, subs.slice(0, MAX_SUGGEST).map(c => custRow(c, c.name)),
    (c) => { fillCustomer(c); S.f.phone.focus(); }, t);
}

function onPhoneTyped() {
  const t = S.f.phone.value.trim();
  if (!t) { AC.closeAC(); return; }
  const subs = S.customers.filter(c => String(c.phone || '').includes(t));
  const exact = subs.filter(c => String(c.phone) === t);
  if (subs.length === 1 && exact.length === 1) { AC.closeAC(); fillCustomer(subs[0]); return; }
  AC.show(S.f.phone, subs.slice(0, MAX_SUGGEST).map(c => custRow(c, c.phone || '')),
    (c) => { fillCustomer(c); S.f.addr.focus(); }, t);
}

function onAddrTyped() {
  const t = S.f.addr.value.trim().toLowerCase();
  if (!t) { AC.closeAC(); return; }
  const subs = S.customers.filter(c => String(c.address || '').toLowerCase().includes(t));
  AC.show(S.f.addr, subs.slice(0, MAX_SUGGEST).map(c => custRow(c, c.address || '')),
    (c) => fillCustomer(c), t);
}

/** Strict match, exactly as the old app resolved which customer this is. */
function bestCustomer() {
  const name = S.f.name.value.trim();
  if (!name) return null;
  if (S.custId) {
    const cur = S.customers.find(c => c.id === S.custId);
    if (cur && cur.name.toLowerCase() === name.toLowerCase()) return cur;
  }
  const exact = S.customers.filter(c => c.name.toLowerCase() === name.toLowerCase());
  if (!exact.length) return null;
  if (exact.length === 1) return exact[0];
  const ph = S.f.phone.value.trim(), ad = S.f.addr.value.trim().toLowerCase();
  return exact.find(c => String(c.phone || '') === ph)
      || exact.find(c => String(c.address || '').toLowerCase() === ad)
      || null;
}

async function showBalance(id) {
  if (!S) return;
  const node_ = q('#s-prev', S.root);
  if (!node_) return;
  if (!id) { node_.textContent = inr(0); node_.style.color = 'var(--ok-ink)'; return; }
  try {
    const b = await api.customer_balance(id);
    if (!S) return;
    node_.textContent = inr(b);
    node_.style.color = b > 0 ? 'var(--bad-ink)' : 'var(--ok-ink)';
  } catch {}
}

/* ============================ totals ============================ */
function recalc() {
  if (!S) return { sub: 0, add: 0, less: 0, total: 0 };
  let sub = 0;
  S.rows.forEach(r => {
    const qv = num(r.qtyEl.value, 0), pv = num(r.price.value, 0);
    const line = validRow(r) ? +(qv * pv).toFixed(2) : 0;
    r.total.textContent = inr(line);
    r.total.style.color = line ? 'var(--ink)' : 'var(--ink-4)';
    r.el.classList.toggle('is-live', !!line);
    sub += line;
  });
  const add = num(S.f.add.value, 0), less = num(S.f.less.value, 0);
  const total = +(sub + add - less).toFixed(2);

  q('#s-sub', S.root).textContent = inr(sub);
  q('#s-total', S.root).textContent = inr(total);

  // "pay in full" stays the default until the user types their own figure
  if (!S.editing) {
    const cur = S.f.paid.value.trim();
    if (cur === '' || cur === '0' || cur === '0.0' || cur === String(+S.lastAutoTotal.toFixed(2))) {
      S.f.paid.value = String(+total.toFixed(2));
    }
  }
  S.lastAutoTotal = total;
  renumber();
  return { sub, add, less, total };
}

/* ============================ the keyboard grid ============================ */
function grid() {
  const g = [[S.f.name, S.f.phone, S.f.addr, S.f.date, S.f.time]];
  S.rows.forEach(r => g.push([r.code, r.name, r.qtyEl, r.price]));
  g.push([S.f.add], [S.f.less], [S.f.notes], [S.f.paid], [S.saveBtn]);
  return g;
}

function findCell(g, node_) {
  for (let r = 0; r < g.length; r++) {
    const c = g[r].indexOf(node_);
    if (c >= 0) return [r, c];
  }
  return null;
}

function focusCell(node_) {
  if (!node_) return;
  node_.focus();
  if (node_.select) setTimeout(() => { try { node_.select(); } catch {} }, 10);
  node_.closest?.('.bill-row')?.scrollIntoView({ block: 'nearest' });
}

function arrow(node_, dr, dc) {
  const g = grid(), pos = findCell(g, node_);
  if (!pos) return false;
  let [r, c] = pos;
  if (dr) {
    const nr = r + dr;
    if (nr < 0 || nr >= g.length) return true;
    focusCell(g[nr][Math.min(c, g[nr].length - 1)]);
    return true;
  }
  const nc = c + dc;
  if (nc < 0) { document.querySelector('.nav-item.on')?.focus(); return true; }
  if (nc >= g[r].length) return true;
  focusCell(g[r][nc]);
  return true;
}

function atEdge(input, dir) {
  if (!input.setSelectionRange) return true;
  const s = input.selectionStart, e = input.selectionEnd;
  if (s !== e) return false;
  return dir < 0 ? s === 0 : s === (input.value || '').length;
}

function enterKey(node_) {
  const g = grid(), pos = findCell(g, node_);
  if (!pos) return false;
  const [r, c] = pos;

  if (node_ === S.saveBtn) { save(); return true; }

  // Item code jumps straight to quantity — the fast counter flow.
  // In Purchase mode it jumps to Pack instead, when the item has one
  // configured: purchases are bought by the carton/box, not the piece.
  const row = S.rows.find(x => x.code === node_);
  if (row) { focusAfterCode(row); return true; }

  // Adjustment fields behave like Down.
  if ([S.f.add, S.f.less, S.f.notes, S.f.paid].includes(node_)) return arrow(node_, 1, 0);

  if (c < g[r].length - 1) { focusCell(g[r][c + 1]); return true; }

  // End of the last item row → grow the bill.
  const isLastRowPrice = S.rows.length && S.rows[S.rows.length - 1].price === node_;
  if (isLastRowPrice) { const nr = addRow(null, true); return true; }

  if (r + 1 < g.length) focusCell(g[r + 1][0]);
  return true;
}

/** The `*` key: section jump from the customer row, save from anywhere else. */
function starKey(node_) {
  const g = grid(), pos = findCell(g, node_);
  if (!pos) return false;
  if (pos[0] === 0) {                       // customer row → first item
    if (S.rows.length) focusCell(S.rows[0].code);
    return true;
  }
  save();                                    // everywhere else → save & print
  return true;
}

function wire() {
  const root = S.root;

  // customer + adjustment fields
  S.f.name.addEventListener('input', onCustTyped);
  S.f.phone.addEventListener('input', onPhoneTyped);
  S.f.addr.addEventListener('input', onAddrTyped);
  [S.f.name, S.f.phone, S.f.addr].forEach(i =>
    i.addEventListener('blur', () => setTimeout(() => { if (!S) return; const c = bestCustomer(); S.custId = c?.id || null; showBalance(c?.id); }, 120)));
  S.f.add.addEventListener('input', recalc);
  S.f.less.addEventListener('input', recalc);

  q('#addRow', root).onclick = () => addRow(null, true);

  on(q('#billType', root), 'click', 'button', (e, b) => {
    qa('#billType button', root).forEach(x => x.classList.toggle('on', x === b));
    S.billType = b.dataset.t;
    const purchase = S.billType === 'purchase';
    q('#saveBtn', root).innerHTML = `${icon('print', 16)}Save ${purchase ? 'purchase' : '&amp; Print'}`;
    q('#lblCustomer', root).innerHTML = purchase ? 'Party Name<span class="req">*</span>' : 'Customer<span class="req">*</span>';
    q('#f-name', root).placeholder = purchase ? 'Start typing a supplier…' : 'Start typing a name…';
    S.rows.forEach(refreshPackUsable);
  });
  on(q('#payType', root), 'click', 'button', (e, b) => {
    qa('#payType button', root).forEach(x => x.classList.toggle('on', x === b));
    if (b.dataset.p === 'credit') S.f.paid.value = '0';
    else S.f.paid.value = String(+(num(q('#s-total', root).textContent.replace(/[^\d.-]/g, ''), 0)).toFixed(2));
  });
  S.saveBtn.onclick = () => save();

  // select-on-focus everywhere
  root.addEventListener('focusin', (e) => {
    if (e.target.matches('input:not([disabled])')) setTimeout(() => { try { e.target.select(); } catch {} }, 12);
  });

  // the one keyboard brain for the whole screen
  root.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!(t.matches('input') || t === S.saveBtn)) return;

    if (AC.handleKey(e, t)) return;                     // the open suggestion list gets first refusal

    if (e.key === '*') { e.preventDefault(); starKey(t); return; }

    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); save(); return; }
    if (e.ctrlKey && (e.key === 'd' || e.key === 'D')) {
      const row = S.rows.find(r => r.el.contains(t));
      if (row) { e.preventDefault(); removeRow(row); }
      return;
    }

    switch (e.key) {
      case 'Enter':      if (enterKey(t)) e.preventDefault(); break;
      case 'ArrowUp':    if (arrow(t, -1, 0)) e.preventDefault(); break;
      case 'ArrowDown':  if (arrow(t, 1, 0)) e.preventDefault(); break;
      case 'ArrowLeft':  if (atEdge(t, -1) && arrow(t, 0, -1)) e.preventDefault(); break;
      case 'ArrowRight': if (atEdge(t, 1) && arrow(t, 0, 1)) e.preventDefault(); break;
      case 'Escape':     AC.closeAC(); break;
    }
  });
}

/* ============================ save ============================ */
function status(msg, tone = '') {
  if (!S) return;
  const s = q('#status', S.root);
  if (!s) return;
  s.textContent = msg || '';
  s.style.color = tone === 'ok' ? 'var(--ok-ink)' : tone === 'bad' ? 'var(--bad-ink)' : 'var(--ink-3)';
}

function collect() {
  return S.rows.filter(validRow).map(r => {
    const qv = num(r.qtyEl.value, 0), pv = num(r.price.value, 0);
    const name = r.name.value.trim();
    const it = S.byNameExact.get(name);
    const pq = (r.packSize && r.packUnit) ? num(r.pack.value, 0) : 0;
    return {
      item_id: r.itemId ?? (it ? it.id : null),
      item_name: name,
      quantity: qv,
      price_per_unit: pv,
      final_price: +(qv * pv).toFixed(2),
      pack_qty: pq > 0 ? pq : null,
      pack_unit_name: pq > 0 ? r.packUnit : '',
      pack_size: pq > 0 ? r.packSize : null,
    };
  });
}

async function save() {
  if (S.saving) return;
  const { sub, add, less, total } = recalc();
  const name = S.f.name.value.trim();

  if (!name) {
    S.f.name.classList.add('is-bad');
    setTimeout(() => S.f.name.classList.remove('is-bad'), 1600);
    S.f.name.focus();
    return toast('Customer name is required', 'Every bill needs a name against it.', 'warn');
  }
  const items = collect();
  if (!items.length) {
    return toast('No items yet', 'Add at least one line with a product, quantity and price.', 'warn');
  }
  if (items.length > MAX_ITEMS) {
    return toast('Too many items', `A single bill can hold up to ${MAX_ITEMS} items (this one has ${items.length}). Please split it into two bills.`, 'bad');
  }
  if (less > sub + add) {
    return toast('Check the amounts', `The 'Less' amount (${inr(less)}) is more than the bill itself (${inr(sub + add)}).`, 'bad');
  }
  if (total < 0) return toast('Check the amounts', 'This bill works out to a negative total.', 'bad');
  const paid = num(S.f.paid.value, 0);
  if (paid - total > 0.001) {
    return toast('Amount paid is more than the total',
      'If the customer is clearing an older balance, record that as a payment in Khata / Ledger instead.', 'bad');
  }

  // Stock warning — a question, never a block.
  if (S.billType === 'sale' && S.ctx.app.flags.stock) {
    const need = {};
    items.forEach(i => { if (i.item_id) need[i.item_id] = (need[i.item_id] || 0) + i.quantity; });
    const ids = Object.keys(need).map(Number);
    if (ids.length) {
      try {
        const have = await api.stock_levels(ids);
        const short = ids.filter(id => need[id] > (have[id] ?? 0) + 1e-9)
          .map(id => `  •  ${S.byId.get(id)?.name || 'Item'}: selling ${fmtQty(need[id])}, only ${fmtQty(have[id] ?? 0)} in stock`);
        if (short.length) {
          const goOn = await confirm('Not enough stock',
            'This bill sells more than the recorded stock for:\n\n' +
            short.slice(0, 8).join('\n') + (short.length > 8 ? `\n  … and ${short.length - 8} more` : '') +
            '\n\nStock for these items will go negative. Save the bill anyway?',
            { danger: true, ok: 'Save anyway' });
          if (!goOn) return;
        }
      } catch {}
    }
  }

  S.saving = true;
  S.saveBtn.classList.add('is-disabled');
  S.saveBtn.innerHTML = `<span class="spinner" style="border-color:rgba(255,255,255,.35);border-top-color:#fff"></span>Saving…`;
  status('Saving…');

  const payload = {
    bill_id: S.editing?.id || null,
    customer_id: bestCustomer()?.id || null,
    customer_name: name,
    customer_phone: S.f.phone.value.trim(),
    customer_address: S.f.addr.value.trim(),
    bill_date: S.f.date.value.trim(),
    bill_time: S.f.time.value.trim(),
    items, subtotal: +sub.toFixed(2),
    freight_charges: add, discount: less, total,
    amount_paid: paid,
    notes: S.f.notes.value.trim(),
    bill_type: S.billType,
  };

  try {
    const res = S.editing ? await api.update_bill(payload) : await api.create_bill(payload);
    S.savedBill = res;
    S.lastPdf = res.pdf_path || null;
    q('#billNo', S.root).textContent = res.bill_number;

    if (res.pdf_error) {
      status(`Saved ${res.bill_number} — PDF could not be created`, 'bad');
      toast('Bill saved, PDF failed',
        `Bill ${res.bill_number} was saved successfully, but its PDF could not be created. The bill is safe — you can open it again from Bill History and print from there.`, 'warn', 8000);
    } else {
      status(`Saved ${res.bill_number}`, 'ok');
      toast('Saved', `Bill ${res.bill_number} saved and PDF created.`, 'ok');
    }
    await loadCaches();                       // stock and customers have moved on
    celebrate();
  } catch (e) {
    status(e.message || 'Could not save', 'bad');
    toast(e.title || 'Could not save the bill', e.message || String(e), 'bad', 7000);
  } finally {
    S.saving = false;
    S.saveBtn.classList.remove('is-disabled');
    S.saveBtn.innerHTML = `${icon('print', 16)}Save &amp; Print`;
  }
}

/** A short, quiet confirmation the eye can catch from across the counter. */
function celebrate() {
  const b = S.saveBtn;
  b.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(1.03)' }, { transform: 'scale(1)' }],
    { duration: 320, easing: 'cubic-bezier(.34,1.56,.64,1)' });
}

/* ============================ misc actions ============================ */
function moreMenu(anchor) {
  import('../core.js').then(({ menu }) => menu(anchor, [
    { label: 'Open PDF', icon: 'file', disabled: !S.lastPdf,
      onClick: () => api.open_pdf(S.savedBill?.bill_id).catch(e => toast('Could not open the PDF', e.message, 'bad')) },
    { label: 'Print again', icon: 'print', disabled: !S.savedBill,
      onClick: () => api.print_bill(S.savedBill?.bill_id).catch(e => toast('Could not print', e.message, 'bad')) },
    { label: 'Send on WhatsApp', icon: 'whatsapp', disabled: !S.savedBill,
      onClick: async () => {
        if (!S.f.phone.value.trim()) return toast('Missing phone', "Please enter the customer's phone number first.", 'warn');
        toast('Opening WhatsApp Web…', 'Leave the browser window open until the message is sent.', 'info');
        try { const m = await api.send_whatsapp(S.savedBill.bill_id, S.f.phone.value.trim()); toast('WhatsApp', m, 'ok'); }
        catch (e) { toast('WhatsApp send failed', e.message, 'bad'); }
      } },
    '-',
    { label: 'Reset form', icon: 'refresh', onClick: resetForm },
  ]));
}

async function resetForm() {
  const dirty = S.f.name.value.trim() || S.rows.some(validRow);
  if (dirty && !await confirm('Clear this bill?', 'This will discard everything entered on this bill.\n\nStart a new one?', { danger: true, ok: 'Start new' })) return;
  S.ctx.go('newbill');
}

function preload(bill) {
  S.f.name.value = bill.customer_name || '';
  S.f.phone.value = bill.customer_phone || '';
  S.f.addr.value = bill.customer_address || '';
  S.f.date.value = bill.bill_date || todayISO();
  S.f.time.value = bill.bill_time || nowHM();
  S.f.add.value = bill.freight_charges || '';
  S.f.less.value = bill.discount || '';
  S.f.paid.value = bill.amount_paid ?? '';
  S.f.notes.value = bill.notes || '';
  S.custId = bill.customer_id || null;
  S.billType = bill.bill_type || 'sale';
  qa('#billType button', S.root).forEach(b => b.classList.toggle('on', b.dataset.t === S.billType));
  { const purchase = S.billType === 'purchase';
    q('#lblCustomer', S.root).innerHTML = purchase ? 'Party Name<span class="req">*</span>' : 'Customer<span class="req">*</span>';
    q('#f-name', S.root).placeholder = purchase ? 'Start typing a supplier…' : 'Start typing a name…'; }
  q('#billNo', S.root).textContent = bill.bill_number || '—';
  (bill.items || []).forEach(li => addRow({
    ...li,
    item_code: S.byId.get(li.item_id)?.item_code || '',
    unit: S.byId.get(li.item_id)?.unit || '',
  }));
  if (!S.rows.length) addRow();
  showBalance(S.custId);
}
