/* ============================================================
   core.js — the small toolkit every view is built from.
   DOM, formatting, icons, toasts, modals, menus.
   ============================================================ */

/* ---------- DOM ---------- */
export const q  = (sel, root = document) => root.querySelector(sel);
export const qa = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

/** Build a node tree from an HTML string. Returns the first element. */
export function node(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function on(target, evt, sel, fn) {
  // on(el, 'click', fn)  |  on(el, 'click', '.sel', fn)  — delegated
  if (typeof sel === 'function') { target.addEventListener(evt, sel); return; }
  target.addEventListener(evt, (e) => {
    const hit = e.target.closest(sel);
    if (hit && target.contains(hit)) fn(e, hit);
  });
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function debounce(fn, ms = 160) {
  let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.now = (...a) => { clearTimeout(t); fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const raf = () => new Promise(r => requestAnimationFrame(() => r()));
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- NUMBERS & DATES ----------
   Indian digit grouping (lakh/crore): 12,34,567.89 — matches the
   PDF and the old app exactly, so printed and on-screen figures agree. */
export function inr(v, symbol = true) {
  let n = Number(v);
  if (!isFinite(n)) n = 0;
  const neg = n < 0;
  n = Math.abs(n);
  const [i, d] = n.toFixed(2).split('.');
  let last3 = i.slice(-3);
  let rest = i.slice(0, -3);
  if (rest) { rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ','); last3 = ',' + last3; }
  return (neg ? '-' : '') + (symbol ? 'Rs. ' : '') + rest + last3 + '.' + d;
}

/** Compact money for tight spaces: 1.2L, 4.4Cr, 8,400 */
export function inrShort(v) {
  const n = Number(v) || 0, a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e7) return s + 'Rs. ' + (a / 1e7).toFixed(a >= 1e8 ? 0 : 1) + 'Cr';
  if (a >= 1e5) return s + 'Rs. ' + (a / 1e5).toFixed(a >= 1e6 ? 0 : 1) + 'L';
  if (a >= 1e3) return s + 'Rs. ' + (a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
  return inr(n);
}

/** Quantity: drops trailing zeros (3, 3.5, 3.25) */
export const qty = (v) => {
  const n = Number(v);
  return isFinite(n) ? String(+n.toFixed(3)) : '0';
};

export const num = (v, fallback = 0) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, '').trim());
  return isFinite(n) ? n : fallback;
};

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** '2026-09-04' -> '04 Sep 2026'  (short: '04 Sep') */
export function dmy(iso, short = false) {
  if (!iso) return '';
  const p = String(iso).slice(0, 10).split('-');
  if (p.length !== 3) return iso;
  const d = p[2], m = MON[+p[1] - 1] || p[1];
  return short ? `${d} ${m}` : `${d} ${m} ${p[0]}`;
}

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const nowHM = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
/** '14:30' -> '2:30 PM' */
export function hm12(t) {
  if (!t) return '';
  const [H, M] = String(t).split(':');
  const h = +H, ap = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${M} ${ap}`;
}
export const initials = (name) => String(name || '?').trim().split(/\s+/)
  .map(w => w[0]).slice(0, 2).join('').toUpperCase();

/* ---------- ICONS ----------
   One stroke weight, one corner style, one size — a single visual voice.  */
const P = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/>',
  plus:      '<path d="M12 5v14M5 12h14"/>',
  plusCircle:'<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  book:      '<path d="M4 5h13a3 3 0 0 1 3 3v10a2 2 0 0 1-2 2H7a3 3 0 0 1-3-3V5Z"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  file:      '<path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v4h4"/><path d="M9 14h6M9 17h4"/>',
  rupee:     '<path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  box:       '<path d="M3 7l9-4 9 4-9 4-9-4Z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>',
  clock:     '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  history:   '<path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 3v9l6 3"/><path d="M17 3v4h4"/>',
  users:     '<circle cx="9" cy="8" r="3"/><path d="M2 20c0-3.5 3-6 7-6s7 2.5 7 6"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14.2c2.6.4 4.5 2.3 5 5.8"/>',
  chart:     '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 16l4-5 3 3 6-7"/>',
  gear:      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.5 1Z"/>',
  search:    '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  bell:      '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  print:     '<path d="M6 9V2h12v7"/><rect x="6" y="14" width="12" height="8" rx="1"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>',
  eye:       '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/>',
  trash:     '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/>',
  pencil:    '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  x:         '<path d="M18 6 6 18M6 6l12 12"/>',
  check:     '<path d="M20 6 9 17l-5-5"/>',
  chevDown:  '<path d="M6 9l6 6 6-6"/>',
  chevRight: '<path d="M9 18l6-6-6-6"/>',
  chevLeft:  '<path d="M15 18l-6-6 6-6"/>',
  arrowUp:   '<path d="M12 19V5M5 12l7-7 7 7"/>',
  arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  arrowRight:'<path d="M5 12h14M13 6l6 6-6 6"/>',
  arrowLeft: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  dots:      '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
  filter:    '<path d="M3 5h18l-7 8v6l-4 2v-8Z"/>',
  download:  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  upload:    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
  refresh:   '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  warn:      '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  info:      '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  shield:    '<path d="M12 2 4 6v6c0 5 3.4 8.7 8 10 4.6-1.3 8-5 8-10V6Z"/>',
  db:        '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  user:      '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>',
  logout:    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
  card:      '<rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  whatsapp:  '<path d="M3 21l1.7-5A8.6 8.6 0 1 1 8 19.4Z"/><path d="M8.6 9.2c.3 2.6 3.6 5.9 6.2 6.2l1-1.4 2 .9-.4 1.6c-3.6.7-8.9-4.6-8.2-8.2l1.6-.4.9 2Z"/>',
  sparkles:  '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6Z"/><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8Z"/>',
  grip:      '<path d="M9 6 4.5 12 9 18"/><path d="M15 6l4.5 6L15 18"/><path d="M12 3v18"/>',
  tag:       '<path d="M3 3h8l10 10-8 8L3 11Z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  calendar:  '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  save:      '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  folder:    '<path d="M3 7a2 2 0 0 1 2-2h4.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
};

/** icon('search', 16) -> <svg …> */
export function icon(name, size = 16, cls = '') {
  const d = P[name] || '';
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}
export const hasIcon = (n) => !!P[n];

/* ---------- TOASTS ---------- */
let toastHost;
export function toast(title, message = '', tone = 'info', ms = 3600) {
  if (!toastHost) { toastHost = el('div', 'toasts'); document.body.appendChild(toastHost); }
  const ico = { ok: 'check', bad: 'warn', warn: 'warn', info: 'info' }[tone] || 'info';
  const colr = { ok: 'var(--ok)', bad: 'var(--bad)', warn: 'var(--warn)', info: 'var(--info)' }[tone];
  const t = node(`<div class="toast toast-${tone}">
      <span style="color:${colr};margin-top:1px">${icon(ico, 16)}</span>
      <div class="grow">
        <div class="toast-t">${esc(title)}</div>
        ${message ? `<div class="toast-m">${esc(message)}</div>` : ''}
      </div>
      <button class="btn-ghost btn-icon btn-sm" style="margin:-4px -6px 0 0">${icon('x', 14)}</button>
    </div>`);
  const kill = () => {
    t.classList.add('is-out');
    t.addEventListener('animationend', () => t.remove(), { once: true });
  };
  q('button', t).onclick = kill;
  toastHost.appendChild(t);
  if (ms) setTimeout(kill, ms);
  return t;
}

/* ---------- MODAL / CONFIRM ---------- */
export function modal({ title, body, icon: ico, tone = 'info', wide = '', actions = [], onOpen }) {
  const scrim = el('div', 'scrim');
  const tint = { ok: 'var(--ok)', bad: 'var(--bad)', warn: 'var(--warn)', info: 'var(--accent)' }[tone];
  const soft = { ok: 'var(--ok-soft)', bad: 'var(--bad-soft)', warn: 'var(--warn-soft)', info: 'var(--accent-soft)' }[tone];
  scrim.innerHTML = `<div class="modal ${wide}" role="dialog" aria-modal="true">
      <div class="modal-hd">
        ${ico ? `<div class="modal-ico" style="background:${soft};color:${tint}">${icon(ico, 19)}</div>` : ''}
        <div class="grow"><div class="h2">${esc(title)}</div></div>
        <button class="btn-ghost btn-icon btn-sm" data-close>${icon('x', 15)}</button>
      </div>
      <div class="modal-bd"></div>
      <div class="modal-ft"></div>
    </div>`;
  const bd = q('.modal-bd', scrim), ft = q('.modal-ft', scrim);
  if (typeof body === 'string') bd.innerHTML = body; else if (body) bd.appendChild(body);

  const close = (val) => {
    if (scrim._closed) return;   // a double close() (e.g. Escape racing an action button) must not double-resolve
    scrim._closed = true;
    scrim.classList.add('is-closing');
    scrim.addEventListener('animationend', () => scrim.remove(), { once: true });
    // scrim is `position:fixed; inset:0` - a full-viewport click-blocker
    // by design while the dialog is open. Removing it is normally driven
    // by the 'is-closing' animation's animationend event above, but that
    // event firing is not guaranteed (a throttled/occluded window, a
    // 0-duration override, or any other case CSS animations can be
    // interrupted or skipped in) - if it never fires, this element is
    // stuck in the DOM forever and silently eats every click in the app,
    // which looks exactly like the whole app having frozen. This timer
    // is a bounded backstop: comfortably longer than the animation, and
    // a no-op (remove() on an already-removed node is a no-op) on the
    // normal path where animationend already did the job.
    setTimeout(() => scrim.remove(), 400);
    document.removeEventListener('keydown', esckey, true);
    scrim._resolve?.(val);
  };
  const esckey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(null); }
    if (e.key === 'Enter' && !e.target.matches('textarea')) {
      const def = q('[data-default]', ft); if (def) { e.preventDefault(); def.click(); }
    }
  };

  actions.forEach(a => {
    const b = el('button', `btn ${a.cls || ''}`);
    b.innerHTML = (a.icon ? icon(a.icon, 15) : '') + esc(a.label);
    if (a.default) b.setAttribute('data-default', '1');
    b.onclick = async () => {
      if (a.onClick) { const r = await a.onClick(bd, close); if (r === false) return; }
      close(a.value ?? true);
    };
    ft.appendChild(b);
  });
  q('[data-close]', scrim).onclick = () => close(null);
  scrim.onmousedown = (e) => { if (e.target === scrim) close(null); };
  document.addEventListener('keydown', esckey, true);
  document.body.appendChild(scrim);
  onOpen?.(bd, close);
  setTimeout(() => (q('input,textarea,select,[data-default]', scrim))?.focus(), 60);

  return new Promise(res => { scrim._resolve = res; });
}

export const confirm = (title, message, { danger = false, ok = 'Confirm', cancel = 'Cancel' } = {}) =>
  modal({
    title, body: `<div style="font-size:var(--t-13);color:var(--ink-2);line-height:1.55;white-space:pre-line">${esc(message)}</div>`,
    icon: danger ? 'warn' : 'info', tone: danger ? 'bad' : 'info',
    actions: [
      { label: cancel, value: false },
      { label: ok, cls: danger ? 'btn-danger' : 'btn-primary', value: true, default: true },
    ],
  }).then(v => v === true);

export const alert = (title, message, tone = 'info') =>
  modal({
    title, body: `<div style="font-size:var(--t-13);color:var(--ink-2);line-height:1.55;white-space:pre-line">${esc(message)}</div>`,
    icon: tone === 'bad' ? 'warn' : tone === 'warn' ? 'warn' : 'info', tone,
    actions: [{ label: 'OK', cls: 'btn-primary', default: true }],
  });

/* ---------- POPUP MENU ---------- */
export function menu(anchor, items, { align = 'right' } = {}) {
  qa('.menu').forEach(m => m.remove());
  const m = el('div', 'menu');
  m.innerHTML = items.map(it => {
    if (it === '-') return '<div class="menu-sep"></div>';
    if (it.label && it.header) return `<div class="menu-label">${esc(it.label)}</div>`;
    return `<button class="menu-item ${it.danger ? 'danger' : ''} ${it.disabled ? 'is-disabled' : ''}">
        ${it.icon ? icon(it.icon, 15) : '<span style="width:15px"></span>'}
        <span class="grow ellipsis">${esc(it.label)}</span>
        ${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ''}
      </button>`;
  }).join('');
  document.body.appendChild(m);

  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  let left = align === 'right' ? r.right - w : r.left;
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
  m.style.left = Math.max(8, Math.min(left, innerWidth - w - 8)) + 'px';
  m.style.top = top + 'px';

  const acts = items.filter(i => i !== '-' && !i.header);
  qa('.menu-item', m).forEach((b, i) => { b.onclick = () => { m.remove(); acts[i].onClick?.(); }; });

  const away = (e) => { if (!m.contains(e.target)) { m.remove(); cleanup(); } };
  const key = (e) => { if (e.key === 'Escape') { m.remove(); cleanup(); } };
  const cleanup = () => {
    document.removeEventListener('mousedown', away);
    document.removeEventListener('keydown', key, true);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key, true);
  });
  return m;
}

/* ---------- LOCAL PREFS ---------- */
export const prefs = {
  get(k, d = null) {
    try { const v = localStorage.getItem('nova.' + k); return v == null ? d : JSON.parse(v); }
    catch { return d; }
  },
  set(k, v) { try { localStorage.setItem('nova.' + k, JSON.stringify(v)); } catch {} },
};

/* ---------- misc ---------- */
export const emptyState = (ico, title, sub = '') => `
  <div class="empty">
    <div class="empty-ico">${icon(ico, 22)}</div>
    <div class="h3" style="color:var(--ink-2)">${esc(title)}</div>
    ${sub ? `<div class="small muted" style="max-width:340px">${esc(sub)}</div>` : ''}
  </div>`;

/** Highlight the matched substring in autocomplete rows. */
export function mark(text, term) {
  const s = String(text ?? '');
  if (!term) return esc(s);
  const i = s.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return esc(s);
  return esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + term.length)) + '</mark>' + esc(s.slice(i + term.length));
}

/* ---------- THEME ----------
   Three states: 'light', 'dark', or 'system' (follow Windows). Stored
   per machine in localStorage rather than in the shop's settings table:
   it is a preference of the person at this screen, not of the business,
   and index.html reads it back before the first paint. */
export const THEMES = ['light', 'dark', 'system'];

export const getTheme = () => prefs.get('theme', 'system');

export function setTheme(mode) {
  if (!THEMES.includes(mode)) mode = 'system';
  prefs.set('theme', mode);
  applyTheme(mode);
  window.dispatchEvent(new CustomEvent('nova:theme', { detail: { mode, dark: isDark() } }));
}

export function applyTheme(mode = getTheme()) {
  const root = document.documentElement;
  if (mode === 'system') delete root.dataset.theme;
  else root.dataset.theme = mode;
}

/** What is actually on screen right now, whichever way it was chosen. */
export function isDark() {
  const t = getTheme();
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

// Following Windows means reacting when Windows changes.
try {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getTheme() === 'system')
      window.dispatchEvent(new CustomEvent('nova:theme', { detail: { mode: 'system', dark: isDark() } }));
  });
} catch {}
