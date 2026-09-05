/* ============================================================
   views/khata.js — Khata / Ledger: who owes the shop money, their
   full passbook, and a one-click way to record what they pay back.

   Three panes, every boundary a live split:
     left    — customers with an outstanding balance, worst first
     right/top    — the selected customer's header + Receive Payment
     right/middle — a small running-balance sparkline
     right/bottom — the ledger table (Invoice / Payment rows)

   Rules preserved from the old counter app (spec §4):
     · left list = every customer with balance > 0, sorted balance ⭣
     · a payment is always dated "now", filed with reference
       "Manual Payment" and whatever the user typed goes into notes
     · the ledger's own running balance (not recomputed) is shown
       against each row, newest transaction on top
   ============================================================ */

import { api } from '../api.js';
import {
  q, qa, node, on, esc, icon, inr, dmy, initials, num,
  toast, modal, emptyState, debounce,
} from '../core.js';

const MAX_PAYMENT = 100000000; // Rs. 10,00,00,000 — a sanity ceiling, not a real business limit

let S = null;

export default {
  title: 'Khata / Ledger',

  async mount(root, ctx) {
    S = {
      ctx, root,
      dues: [], byId: new Map(), filtered: [], search: '',
      selectedId: null, selectedCust: null,
      ledgerAsc: null, balance: 0,
      loadingList: true, loadingLedger: false,
      ro: null, onResize: null,
    };

    paint(root);
    wire();
    wireResize();
    renderWorkspacePlaceholder();

    await reload();

    // Land on someone rather than an empty right-hand side: the customer
    // asked for, else whoever owes the most.
    const wantId = ctx.params?.customerId;
    if (wantId && S.byId.has(wantId)) selectCustomer(wantId);
    else if (S.dues?.length) selectCustomer(S.dues[0].id);
  },

  destroy() {
    if (S?.onResize) window.removeEventListener('nova:resize', S.onResize);
    S?.ro?.disconnect();
    S = null;
  },
};

/* ============================ layout ============================ */
function paint(root) {
  root.innerHTML = `
  <div class="split split-h grow" data-split="khata.main" style="padding:var(--s4) var(--s5) var(--s5)">
    <div class="pane pane-sized" data-size="320" data-min="250" data-max="480" style="padding-right:6px">
      <div class="panel grow">
        <div class="panel-head col" style="align-items:stretch;gap:10px;padding:12px 14px;height:auto">
          <div class="row between" style="align-items:flex-start">
            <div class="h2">Outstanding Dues</div>
            <div class="col" style="align-items:flex-end;gap:0">
              <span class="tiny muted">Total outstanding</span>
              <span class="mono strong" id="totalOut" style="font-size:var(--t-15);color:var(--bad-ink)">Rs. 0.00</span>
            </div>
          </div>
          <div class="search">${icon('search', 15)}<input id="q" placeholder="Search by name, phone or address…" autocomplete="off"></div>
        </div>
        <div class="scroll-y grow" id="list" style="padding:6px"></div>
      </div>
    </div>

    <div class="pane pane-fill" style="padding-left:6px">
      <div class="split split-v grow" data-split="khata.workspace">
        <div class="pane pane-sized" data-size="116" data-min="96" data-max="190">
          <div class="panel grow" id="headerPanel"></div>
        </div>
        <div class="pane pane-fill" style="padding-top:6px">
          <div class="split split-v grow" data-split="khata.chart">
            <div class="pane pane-sized" data-size="150" data-min="110" data-max="260">
              <div class="panel grow">
                <div class="panel-head"><div class="h2 grow">Balance trend</div></div>
                <div class="chart-wrap" id="sparkHost" style="padding:6px 14px 12px"></div>
              </div>
            </div>
            <div class="pane pane-fill" style="padding-top:6px">
              <div class="panel grow">
                <div class="panel-head">
                  <div class="h2 grow">Ledger</div>
                  <span class="tiny muted" id="ledgerCount"></span>
                </div>
                <div class="tbl-head" id="ledgerHead">
                  <div style="width:100px">Date</div>
                  <div style="width:104px">Type</div>
                  <div class="grow">Reference / Notes</div>
                  <div class="num-cell" style="width:118px">Debit</div>
                  <div class="num-cell" style="width:118px">Credit</div>
                  <div class="num-cell" style="width:128px">Balance</div>
                </div>
                <div class="tbl-body" id="ledgerBody"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function renderWorkspacePlaceholder() {
  q('#headerPanel', S.root).innerHTML = `
    <div class="col center grow" style="gap:4px;padding:20px;text-align:center">
      <div class="small muted">Select a customer from the list to see their passbook.</div>
    </div>`;
  q('#sparkHost', S.root).innerHTML = '';
  q('#ledgerBody', S.root).innerHTML = emptyState('users', 'Select a customer', 'Their invoices and payments will appear here.');
  q('#ledgerCount', S.root).textContent = '';
}

/* ============================ data: left list ============================ */
async function reload() {
  S.loadingList = true;
  renderList();
  try {
    S.dues = (await api.customers_with_dues()) || [];
  if (!S) return;   // the screen was left while this was in flight
  } catch (e) {
    S.dues = [];
    toast('Could not load outstanding dues', e.message, 'bad');
  }
  S.dues.sort((a, b) => (b.balance || 0) - (a.balance || 0));
  S.byId = new Map(S.dues.map(c => [c.id, c]));
  S.loadingList = false;
  applyFilter();
  renderTotal();
}

function applyFilter() {
  const t = S.search.trim().toLowerCase();
  S.filtered = !t ? S.dues : S.dues.filter(c =>
    String(c.name || '').toLowerCase().includes(t) ||
    String(c.phone || '').includes(t) ||
    String(c.address || '').toLowerCase().includes(t));
  renderList();
}

function renderTotal() {
  const total = S.dues.reduce((s, c) => s + (c.balance || 0), 0);
  q('#totalOut', S.root).textContent = inr(total);
}

function rowHtml(c) {
  const sub = [c.phone, c.address].filter(Boolean).join(' · ') || 'No contact details';
  return `<button class="list-row tap ${S.selectedId === c.id ? 'on' : ''}" data-id="${c.id}">
    <div class="avatar">${esc(initials(c.name))}</div>
    <div class="col grow" style="gap:1px;min-width:0">
      <span class="small strong ellipsis nm">${esc(c.name)}</span>
      <span class="tiny muted ellipsis">${esc(sub)}</span>
    </div>
    <span class="mono small strong" style="flex:none;color:var(--bad-ink)">${inr(c.balance || 0)}</span>
  </button>`;
}

function renderList() {
  const host = q('#list', S.root);
  if (!host) return;
  if (S.loadingList) {
    host.innerHTML = Array.from({ length: 7 }).map(() =>
      `<div style="padding:7px 10px"><div class="skel" style="height:36px;border-radius:var(--r-md)"></div></div>`).join('');
    return;
  }
  if (!S.dues.length) {
    host.innerHTML = emptyState('check', 'Every account is settled', 'Nobody owes you anything right now — nice work.');
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
  S.selectedCust = S.byId.get(id) || S.selectedCust;
  qa('.list-row[data-id]', S.root).forEach(r => r.classList.toggle('on', +r.dataset.id === id));
  loadCustomer(id);
}

async function loadCustomer(id) {
  S.loadingLedger = true;
  q('#headerPanel', S.root).innerHTML = `<div class="row gap4" style="padding:16px 18px;align-items:center">
    <div class="skel" style="width:40px;height:40px;border-radius:var(--r-lg)"></div>
    <div class="col grow gap2"><div class="skel" style="height:16px;width:40%"></div><div class="skel" style="height:12px;width:60%"></div></div>
    <div class="skel" style="width:120px;height:34px;border-radius:var(--r-md)"></div>
  </div>`;
  q('#sparkHost', S.root).innerHTML = `<div class="skel" style="width:100%;height:100%"></div>`;
  q('#ledgerBody', S.root).innerHTML = `<div class="tr"><div class="skel" style="height:18px;width:100%;margin:auto 10px"></div></div>`;

  let ledger = [], balance = 0;
  try {
    [ledger, balance] = await Promise.all([api.customer_ledger(id), api.customer_balance(id)]);
  } catch (e) {
    toast('Could not load this ledger', e.message, 'bad');
    ledger = []; balance = 0;
  }
  if (!S || S.selectedId !== id) return;   // selection moved on while we awaited

  ledger = (ledger || []).slice().sort((a, b) =>
    String(a.transaction_date).localeCompare(String(b.transaction_date)));
  S.ledgerAsc = ledger;
  S.balance = balance || 0;
  S.loadingLedger = false;

  renderHeader();
  drawSpark();
  renderLedgerTable();
}

/* ============================ right/top: header ============================ */
function renderHeader() {
  const cust = S.selectedCust;
  if (!cust) return;
  const owed = S.balance > 0.009;
  const sub = [cust.phone, cust.address].filter(Boolean).join(' · ') || 'No contact details on file';
  q('#headerPanel', S.root).innerHTML = `
    <div class="row gap4" style="padding:16px 18px;align-items:center;height:100%">
      <div class="avatar avatar-lg">${esc(initials(cust.name))}</div>
      <div class="col grow" style="gap:2px;min-width:0">
        <div class="h2 ellipsis">${esc(cust.name)}</div>
        <div class="small muted ellipsis">${esc(sub)}</div>
      </div>
      <div class="col" style="align-items:flex-end;gap:1px;flex:none">
        <span class="overline">${owed ? 'Total due' : 'All clear'}</span>
        <span class="mono" style="font-size:var(--t-24);font-weight:700;letter-spacing:-.02em;color:${owed ? 'var(--bad-ink)' : 'var(--ok-ink)'}">${inr(S.balance)}</span>
      </div>
      <button class="btn btn-primary btn-lg" id="btnReceive">${icon('rupee', 16)}Receive payment</button>
    </div>`;
  q('#btnReceive', S.root).onclick = openReceivePayment;
}

/* ============================ right/middle: sparkline ============================ */
function drawSpark() {
  const host = q('#sparkHost', S.root);
  if (!host) return;
  const rows = S.ledgerAsc || [];
  if (!rows.length) {
    host.innerHTML = emptyState('chart', 'No history yet', 'A trend appears here once this customer has invoices or payments.');
    return;
  }
  const rect = host.getBoundingClientRect();
  const W = Math.max(160, Math.round(rect.width)), H = Math.max(50, Math.round(rect.height));
  const padX = 4, padY = 8;
  const vals = rows.map(r => r.balance || 0);
  let minV = Math.min(0, ...vals), maxV = Math.max(0, ...vals);
  if (maxV === minV) { maxV += 1; minV -= 1; }
  const n = vals.length;
  const xs = (i) => n > 1 ? padX + i * (W - padX * 2) / (n - 1) : W / 2;
  const ys = (v) => padY + (1 - (v - minV) / (maxV - minV)) * (H - padY * 2);
  const pts = vals.map((v, i) => [xs(i), ys(v)]);
  const linePath = 'M' + pts.map(p => p.join(',')).join(' L');
  const zeroY = ys(0).toFixed(1);
  const areaPath = `${linePath} L${pts[pts.length - 1][0].toFixed(1)},${zeroY} L${pts[0][0].toFixed(1)},${zeroY} Z`;
  const last = vals[vals.length - 1];
  const color = last > 0.009 ? 'var(--bad)' : 'var(--ok)';

  host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="0" y1="${zeroY}" x2="${W}" y2="${zeroY}" class="grid-line"></line>
    <path d="${areaPath}" fill="${color}" opacity=".14"></path>
    <path d="${linePath}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
    <circle cx="${pts[pts.length - 1][0].toFixed(1)}" cy="${pts[pts.length - 1][1].toFixed(1)}" r="3" fill="${color}"></circle>
  </svg>`;
}

/* ============================ right/bottom: ledger table ============================ */
function ledgerRowHtml(tx) {
  const isInvoice = tx.transaction_type === 'Invoice';
  const ref = esc(tx.reference || '') + (tx.notes ? ' | ' + esc(tx.notes) : '');
  const debit = tx.debit || 0, credit = tx.credit || 0;
  return `<div class="tr">
    <div style="width:100px">${esc(dmy(String(tx.transaction_date).slice(0, 10)))}</div>
    <div style="width:104px"><span class="pill ${isInvoice ? 'pill-bad' : 'pill-ok'}">${esc(tx.transaction_type)}</span></div>
    <div class="grow ellipsis" title="${ref}">${ref}</div>
    <div class="num-cell mono" style="width:118px;${debit > 0.009 ? 'color:var(--bad-ink)' : ''}">${debit > 0.009 ? inr(debit) : '—'}</div>
    <div class="num-cell mono" style="width:118px;${credit > 0.009 ? 'color:var(--ok-ink)' : ''}">${credit > 0.009 ? inr(credit) : '—'}</div>
    <div class="num-cell mono strong" style="width:128px">${inr(tx.balance || 0)}</div>
  </div>`;
}

function renderLedgerTable() {
  const host = q('#ledgerBody', S.root), count = q('#ledgerCount', S.root);
  const rows = (S.ledgerAsc || []).slice().reverse();   // newest first
  count.textContent = rows.length ? `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}` : '';
  if (!rows.length) {
    host.innerHTML = emptyState('book', 'No transactions yet', 'Invoices and payments for this customer will show up here.');
    return;
  }
  host.innerHTML = rows.map(ledgerRowHtml).join('');
}

/* ============================ Receive Payment ============================ */
function setErr(body, id, msg) {
  const input = q('#' + id, body), err = q(`[data-err="${id}"]`, body);
  if (input) input.classList.toggle('is-bad', !!msg);
  if (err) err.textContent = msg || '';
}

async function openReceivePayment() {
  if (!S.selectedId || !S.selectedCust) return;
  const cust = S.selectedCust;
  const startBal = S.balance;

  const body = node(`<div class="col gap4">
    <div class="field">
      <label class="label">Amount received (Rs.)<span class="req">*</span></label>
      <input class="input mono" id="f-amt" autocomplete="off" placeholder="0.00">
      <div class="tiny" style="color:var(--bad-ink);min-height:14px" data-err="f-amt"></div>
    </div>
    <div class="field">
      <label class="label">Reference / notes</label>
      <input class="input" id="f-note" autocomplete="off" placeholder="e.g. Cash">
    </div>
    <div class="row between" style="padding:10px 12px;background:var(--surface-2);border-radius:var(--r-md)">
      <span class="small">Balance after this payment</span>
      <b class="mono" id="newBal">${inr(startBal)}</b>
    </div>
  </div>`);

  const amtEl = q('#f-amt', body), balEl = q('#newBal', body);
  const updatePreview = () => {
    const amt = num(amtEl.value, 0);
    const nb = startBal - amt;
    balEl.textContent = inr(nb);
    balEl.style.color = nb > 0.009 ? 'var(--bad-ink)' : 'var(--ok-ink)';
  };
  amtEl.addEventListener('input', updatePreview);
  updatePreview();

  const res = await modal({
    title: `Receive payment from ${cust.name}`,
    icon: 'rupee', tone: 'ok',
    body,
    actions: [
      { label: 'Cancel', value: false },
      {
        label: 'Record payment', cls: 'btn-primary', default: true,
        onClick: async () => {
          setErr(body, 'f-amt', '');
          const amt = num(q('#f-amt', body).value, NaN);
          if (!isFinite(amt) || amt <= 0) { setErr(body, 'f-amt', 'Enter a valid positive amount.'); return false; }
          if (amt > MAX_PAYMENT) { setErr(body, 'f-amt', 'That amount looks far too large — please check it.'); return false; }
          const note = q('#f-note', body).value.trim();
          try {
            await api.add_ledger_payment(cust.id, amt, note);
            toast('Payment received', `${inr(amt)} recorded for ${cust.name}.`, 'ok');
          } catch (e) {
            toast('Could not record this payment', e.message, 'bad');
            return false;
          }
          return true;
        },
      },
    ],
  });

  if (res) {
    await reload();
    if (S.selectedId) loadCustomer(S.selectedId);
  }
}

/* ============================ resize ============================ */
function wireResize() {
  const redraw = debounce(() => { if (S?.ledgerAsc) drawSpark(); }, 100);
  S.onResize = redraw;
  window.addEventListener('nova:resize', redraw);
  if (window.ResizeObserver) {
    S.ro = new ResizeObserver(redraw);
    S.ro.observe(q('#sparkHost', S.root));
  }
}

/* ============================ interaction ============================ */
function wire() {
  const root = S.root;
  const doSearch = debounce(() => { S.search = q('#q', root).value; applyFilter(); }, 180);
  on(root, 'input', '#q', doSearch);

  on(root, 'click', '.list-row[data-id]', (e, row) => selectCustomer(+row.dataset.id));
  on(root, 'keydown', '.list-row[data-id]', (e, row) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); row.nextElementSibling?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); row.previousElementSibling?.focus(); }
  });
}
