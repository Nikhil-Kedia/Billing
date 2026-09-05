/* ============================================================
   views/pdfs.js — Bill PDFs: a fast, read-only way to find and
   open a bill's generated PDF file. Distinct from Bill History,
   which is for editing — no edit/delete actions live here.
   ============================================================ */

import { api } from '../api.js';
import {
  q, on, esc, icon, toast, emptyState, debounce, dmy, todayISO,
} from '../core.js';

const DATE_PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'week',  label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'all',   label: 'All' },
];

let S = null;

export default {
  title: 'Bill PDFs',

  async mount(root, ctx) {
    S = {
      ctx, root,
      pdfs: [], filtered: [],
      search: '', dateMode: 'all', dateFrom: '', dateTo: '',
      loading: true,
    };

    paint(root);
    renderThead();
    renderDateFilter();
    wire();

    ctx.setActions([
      { label: 'Open PDF folder', icon: 'folder', cls: 'btn-ghost', onClick: openFolder },
      { label: 'Refresh', icon: 'refresh', cls: 'btn-ghost', onClick: reload },
    ]);

    await reload();
  },

  destroy() { S = null; },
};

/* ============================ layout ============================ */
function paint(root) {
  root.innerHTML = `
  <div class="split split-v grow" data-split="pdfs.summary" style="padding:var(--s4) var(--s5) var(--s5)">
    <div class="pane pane-sized" data-size="112" data-min="0" data-max="220">
      <div class="panel grow">
        <div class="panel-head">
          ${icon('file', 16)}<div class="h2 grow">PDF files</div>
          <span class="small muted">Current view</span>
        </div>
        <div style="padding:14px 16px" id="summaryBody"></div>
      </div>
    </div>

    <div class="pane pane-fill" style="padding-top:6px">
      <div class="panel grow">
        <div class="panel-head col" style="align-items:stretch;gap:10px;padding-bottom:10px;height:auto">
          <div class="row gap3 wrap">
            <div class="search" style="width:280px;flex:none">
              ${icon('search', 15)}<input id="q" placeholder="Search by bill number or customer…" autocomplete="off">
            </div>
            <span class="small muted grow" id="count" style="text-align:right"></span>
          </div>
          <div class="row gap3 wrap" id="dateRange"></div>
        </div>
        <div class="tbl-head" id="thead"></div>
        <div class="tbl-body" id="tbody"></div>
      </div>
    </div>
  </div>`;
}

/* ============================ data ============================ */
async function reload() {
  S.loading = true;
  renderTbody();
  try {
    S.pdfs = await api.pdf_list() || [];
  if (!S) return;   // the screen was left while this was in flight
  } catch (e) {
    S.pdfs = [];
    toast('Could not load PDF list', e.message, 'bad');
  }
  S.loading = false;
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

function applyFilter() {
  const term = S.search.trim().toLowerCase();
  const { from, to } = computeRange();
  S.filtered = S.pdfs.filter(p => {
    if (term) {
      const hit = String(p.bill_number || '').toLowerCase().includes(term)
        || String(p.customer_name || '').toLowerCase().includes(term);
      if (!hit) return false;
    }
    if (from && p.date < from) return false;
    if (to && p.date > to) return false;
    return true;
  });
}

function formatSize(kb) {
  const n = Number(kb);
  if (!isFinite(n)) return '—';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' MB';
  return Math.round(n) + ' KB';
}

/* ============================ render ============================ */
function renderAll() {
  applyFilter();
  renderSummary();
  renderTbody();
  renderCount();
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

function renderSummary() {
  const list = S.filtered;
  const missing = list.filter(p => !p.exists).length;
  const ready = list.length - missing;
  const totalSize = list.reduce((s, p) => s + (Number(p.size_kb) || 0), 0);
  const max = Math.max(ready, missing, 1);

  q('#summaryBody', S.root).innerHTML = `
    <div class="row gap6" style="align-items:flex-start;flex-wrap:wrap">
      <div class="col gap1">
        <span class="overline">Ready</span>
        <span class="h1 mono" style="color:var(--ok-ink)">${ready}</span>
      </div>
      <div class="col gap1">
        <span class="overline">Missing</span>
        <span class="h1 mono" style="color:${missing ? 'var(--bad-ink)' : 'var(--ink-3)'}">${missing}</span>
      </div>
      <div class="col gap1">
        <span class="overline">Total size</span>
        <span class="h1 mono">${formatSize(totalSize)}</span>
      </div>
      <div class="grow col gap2" style="min-width:180px;padding-top:2px">
        <div class="row between"><span class="tiny muted">Ready</span><span class="tiny mono">${ready}</span></div>
        <div class="bar"><i style="width:${(ready / max) * 100}%;background:var(--ok)"></i></div>
        <div class="row between" style="margin-top:6px"><span class="tiny muted">Missing</span><span class="tiny mono">${missing}</span></div>
        <div class="bar"><i style="width:${(missing / max) * 100}%;background:var(--bad)"></i></div>
      </div>
    </div>`;
}

function renderThead() {
  q('#thead', S.root).innerHTML = `
    <div style="width:104px">Bill No</div>
    <div class="grow">Customer</div>
    <div style="width:104px">Generated</div>
    <div class="num-cell" style="width:88px">Size</div>
    <div style="width:120px;text-align:center">PDF</div>
    <div style="width:150px"></div>`;
}

function rowHtml(p) {
  const missing = !p.exists;
  return `<div class="tr ${missing ? 'tr-warn' : ''}" data-id="${p.bill_id}" title="${esc(p.filename || '')}">
    <div class="mono ellipsis" style="width:104px">${esc(p.bill_number)}</div>
    <div class="grow ellipsis strong">${esc(p.customer_name || 'Walk-in')}</div>
    <div class="mono ellipsis" style="width:104px">${dmy(p.date)}</div>
    <div class="num-cell mono" style="width:88px">${missing ? '—' : formatSize(p.size_kb)}</div>
    <div style="width:120px;text-align:center">
      <span class="pill ${missing ? 'pill-warn' : 'pill-ok'}">${missing ? 'File missing' : 'Ready'}</span>
    </div>
    <div class="acts" style="width:150px">
      <button class="btn btn-ghost btn-icon btn-sm" data-act="open" title="${missing ? 'Generate and open' : 'Open PDF'}">${icon('file', 14)}</button>
      <button class="btn btn-ghost btn-icon btn-sm" data-act="print" title="Print">${icon('print', 14)}</button>
      <button class="btn btn-ghost btn-icon btn-sm" data-act="reveal" title="Reveal in folder">${icon('folder', 14)}</button>
      <button class="btn btn-ghost btn-icon btn-sm" data-act="whatsapp" title="Send on WhatsApp">${icon('whatsapp', 14)}</button>
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
    host.innerHTML = S.pdfs.length
      ? emptyState('filter', 'No PDFs match', 'Try a different search or date range.')
      : emptyState('file', 'No bill PDFs yet', 'PDFs are created automatically whenever a bill is saved.');
    return;
  }
  host.innerHTML = S.filtered.map(rowHtml).join('');
}

function renderCount() {
  const el_ = q('#count', S.root);
  if (!el_) return;
  const total = S.pdfs.length, shown = S.filtered.length;
  const active = !!S.search || S.dateMode !== 'all';
  el_.textContent = active ? `${shown} of ${total} files` : `${total} file${total !== 1 ? 's' : ''}`;
}

/* ============================ actions ============================ */
async function openFolder() {
  try { await api.open_folder('pdfs'); }
  catch (e) { toast('Could not open the folder', e.message, 'bad'); }
}

async function openPdfRow(p) {
  try { await api.open_pdf(p.bill_id); if (!p.exists) await reload(); }
  catch (e) { toast('Could not open the PDF', e.message, 'bad'); }
}

async function printRow(p) {
  try { await api.print_bill(p.bill_id); toast('Sent to print', `Bill ${p.bill_number} was opened for printing.`, 'ok'); }
  catch (e) { toast('Could not print this bill', e.message, 'bad'); }
}

async function revealRow(p) {
  try { await api.reveal(p.bill_id); }
  catch (e) { toast('Could not open the folder', e.message, 'bad'); }
}

async function whatsappRow(p) {
  try {
    const bill = await api.get_bill(p.bill_id);
    const phone = bill?.customer_phone;
    if (!phone) return toast('Missing phone', 'This bill has no customer phone number on file.', 'warn');
    toast('Opening WhatsApp Web…', 'Leave the browser window open until the message is sent.', 'info');
    const m = await api.send_whatsapp(p.bill_id, phone);
    toast('WhatsApp', m, 'ok');
  } catch (e) { toast('WhatsApp send failed', e.message, 'bad'); }
}

/* ============================ interaction ============================ */
function wire() {
  const root = S.root;

  const doSearch = debounce(() => { S.search = q('#q', root).value; renderAll(); }, 180);
  on(root, 'input', '#q', doSearch);

  on(root, 'click', '[data-preset]', (e, b) => {
    S.dateMode = b.dataset.preset;
    renderDateFilter();
    renderAll();
  });
  on(root, 'click', '#customChip', () => {
    S.dateMode = 'custom';
    renderDateFilter();
    renderAll();
  });
  on(root, 'change', '#dFrom', (e) => { S.dateFrom = e.target.value; renderAll(); });
  on(root, 'change', '#dTo', (e) => { S.dateTo = e.target.value; renderAll(); });

  on(root, 'click', '.tr[data-id]', (e, row) => {
    const p = S.filtered.find(x => x.bill_id === +row.dataset.id);
    if (!p) return;
    const actBtn = e.target.closest('[data-act]');
    if (!actBtn) { openPdfRow(p); return; }
    const act = actBtn.dataset.act;
    if (act === 'open') openPdfRow(p);
    else if (act === 'print') printRow(p);
    else if (act === 'reveal') revealRow(p);
    else if (act === 'whatsapp') whatsappRow(p);
  });
}
