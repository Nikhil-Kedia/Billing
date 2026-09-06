/* ============================================================
   app.js — the shell: sidebar, topbar, router, global keys.
   ============================================================ */

import { api, ready, usingMock } from './api.js';
import * as Panels from './panels.js';
import { notifyIfPending } from './updates.js';
import {
  q, qa, el, node, on, esc, icon, toast, modal, confirm, prefs,
  initials, debounce, mark, sleep,
} from './core.js';

/* ---------- navigation model (mirrors the old app's grouping) ---------- */
const NAV = [
  { group: '', items: [
    { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  ]},
  { group: 'Billing', items: [
    { id: 'newbill', label: 'New Bill', icon: 'plusCircle' },
    { id: 'history', label: 'Bill History', icon: 'book' },
    { id: 'pdfs', label: 'Bill PDFs', icon: 'file' },
  ]},
  { group: 'Money', items: [
    { id: 'khata', label: 'Khata / Ledger', icon: 'rupee', needs: 'khata' },
  ]},
  { group: 'Catalogue', items: [
    { id: 'inventory', label: 'Inventory', icon: 'box' },
    { id: 'stock', label: 'Stock History', icon: 'history', needs: 'stock' },
  ]},
  { group: 'People', items: [
    { id: 'customers', label: 'Customers', icon: 'users' },
    { id: 'insights', label: 'Customer Insights', icon: 'chart' },
    { id: 'attendance', label: 'Attendance', icon: 'calendar', needsPerm: 'manage_attendance' },
  ]},
];

const VIEWS = {
  dashboard: () => import('./views/dashboard.js'),
  newbill:   () => import('./views/newbill.js'),
  history:   () => import('./views/history.js'),
  pdfs:      () => import('./views/pdfs.js'),
  khata:     () => import('./views/khata.js'),
  inventory: () => import('./views/inventory.js'),
  stock:     () => import('./views/stock.js'),
  customers: () => import('./views/customers.js'),
  insights:  () => import('./views/insights.js'),
  attendance: () => import('./views/attendance.js'),
  settings:  () => import('./views/settings.js'),
};

/* ---------- app state ---------- */
export const app = {
  settings: {},
  user: null,
  can: {},
  view: null,
  viewId: null,
  params: null,
  go, refresh, setBusy, flags: { stock: false, khata: false },
};

/* ---------- boot ---------- */
async function boot() {
  await ready;
  let info = null;
  try {
    info = await api.bootstrap();
  } catch (e) {
    info = null;
  }

  if (info?.needs_auth) {
    // The database says sign-in is required and nobody is authenticated
    // yet - clear the splash screen and gate on a real sign-in form
    // rather than falling through to the dashboard (which is exactly
    // what used to happen here, silently, before this existed).
    q('#splash')?.classList.add('gone');
    setTimeout(() => q('#splash')?.remove(), 500);
    await signInGate(info);
    try { info = await api.bootstrap(); } catch (e) { /* keep prior info */ }
  }

  app.settings = info?.settings || { store_name: 'Balaji Store' };
  app.user = info?.user || null;
  app.flags = { stock: !!info?.track_stock, khata: !!info?.track_khata };
  app.can = info?.can || {};       // what security.py says this user may do

  window.__novaBooted = true;      // tells index.html's watchdog we're alive
  render();
  await go(prefs.get('lastView', 'dashboard'));
  q('#splash')?.classList.add('gone');
  setTimeout(() => q('#splash')?.remove(), 500);

  // Phase 3: a quiet startup update check. This makes no network call of
  // its own - it only asks what the background check already found (see
  // bridge.check_for_updates_background(), which nova.py runs on a
  // background thread throttled to once every 24h). The delay just lets
  // the splash screen clear first.
  setTimeout(() => notifyIfPending(app), 2500);
}

/** Fills #app with a full-screen sign-in form and resolves once
 * api.sign_in() succeeds. Nothing else in the app is reachable while
 * this is showing - there is no "skip" path, matching what "Require
 * sign-in" is supposed to mean. */
function signInGate(info) {
  const shop = info?.settings?.store_name || 'Balaji Store';
  return new Promise((resolve) => {
    document.getElementById('app').innerHTML = `
      <div class="signin">
        <div class="signin-brand">
          <div class="glow1"></div><div class="glow2"></div>
          <div class="row gap2" style="align-items:center;position:relative;color:#fff">
            <div class="brand-mark">${icon('box', 18)}</div>
            <div style="font-weight:650;font-size:15px">Vikray</div>
          </div>
          <div style="position:relative">
            <div style="color:#fff;font-size:26px;font-weight:650;margin-bottom:8px">${esc(shop)}</div>
            <div class="small" style="color:rgba(255,255,255,.65)">
              Sign-in is required for this shop. Ask the owner if you don't have an account yet.
            </div>
          </div>
        </div>
        <div class="signin-form">
          <form id="signinForm" class="col gap3" style="width:100%;max-width:320px">
            <div class="h2">Sign in</div>
            <div class="field">
              <label class="label">Username</label>
              <input class="input" id="si-user" name="username" autocomplete="username" autofocus required>
            </div>
            <div class="field">
              <label class="label">Password</label>
              <input class="input" id="si-pass" name="password" type="password" autocomplete="current-password" required>
            </div>
            <div class="small" style="color:var(--bad)" id="si-err" hidden></div>
            <button class="btn btn-primary" type="submit" style="justify-content:center">Sign in</button>
          </form>
        </div>
      </div>`;

    const form = q('#signinForm');
    const err = q('#si-err');
    const btn = form.querySelector('button[type=submit]');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      btn.disabled = true;
      try {
        await api.sign_in(q('#si-user').value.trim(), q('#si-pass').value);
        resolve();
      } catch (ex) {
        err.textContent = ex.message || 'That username or password is not right.';
        err.hidden = false;
        btn.disabled = false;
        q('#si-pass').value = '';
        q('#si-pass').focus();
      }
    });
  });
}

/* ---------- shell ---------- */
function render() {
  const shop = app.settings.store_name || 'Balaji Store';
  const who = app.user?.display_name || app.user?.username || 'Owner';
  const role = app.user?.role ? app.user.role[0].toUpperCase() + app.user.role.slice(1) : 'Owner';

  document.getElementById('app').innerHTML = `
    <aside class="sidebar${prefs.get('mini', false) ? ' mini' : ''}" id="sidebar">
      <div class="brand">
        <div class="brand-mark">${icon('box', 17)}</div>
        <div class="brand-text grow ellipsis">
          <div class="brand-shop ellipsis">${esc(shop)}</div>
          <div class="brand-app">Vikray</div>
        </div>
      </div>

      <button class="cmdk tap" id="cmdk">
        ${icon('search', 14)}
        <span class="grow" style="text-align:left">Search or jump to…</span>
        <kbd class="cmdk-hint">Ctrl K</kbd>
      </button>

      <nav class="nav" id="nav"></nav>

      <div class="side-foot">
        <button class="nav-item" data-nav="settings" style="position:relative">
          ${icon('gear', 18)}<span class="nav-label grow" style="text-align:left">Settings</span>
          <span id="updDot" hidden style="position:absolute;left:20px;top:8px;width:8px;height:8px;
            border-radius:50%;background:var(--accent,#4a7dfc);box-shadow:0 0 0 2px var(--bg,#fff)"></span>
        </button>
        <div class="divider" style="margin:8px 0"></div>
        <button class="who" id="who">
          <div class="avatar">${esc(initials(who))}</div>
          <div class="who-text grow">
            <div class="ellipsis" style="font-size:var(--t-12);font-weight:600">${esc(who)}</div>
            <div class="row gap1" style="font-size:10.5px;color:var(--ink-3)">
              <span class="dot dot-ok"></span><span class="ellipsis">${esc(role)} · Saved</span>
            </div>
          </div>
          ${icon('chevDown', 14)}
        </button>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <button class="btn btn-ghost btn-icon btn-sm" id="railToggle" title="Collapse sidebar (Ctrl+B)">
          ${icon('grip', 16)}
        </button>
        <div class="grow" style="min-width:0">
          <h1 id="viewTitle" class="ellipsis">…</h1>
          <div class="sub ellipsis" id="viewSub"></div>
        </div>
        <div class="row gap2" id="viewActions"></div>
      </header>
      <section class="stage" id="stage"></section>
    </main>`;

  paintNav();

  q('#railToggle').onclick = toggleRail;
  q('#cmdk').onclick = palette;
  q('#who').onclick = (e) => userMenu(e.currentTarget);
  on(q('#app'), 'click', '[data-nav]', (e, b) => go(b.dataset.nav));
}

function paintNav() {
  const nav = q('#nav');
  nav.innerHTML = NAV.map(sec => {
    const items = sec.items.filter(it =>
      (!it.needs || app.flags[it.needs] !== false) &&
      (!it.needsPerm || app.can[it.needsPerm] === true));
    if (!items.length) return '';
    return (sec.group ? `<div class="nav-group">${esc(sec.group)}</div>` : '<div style="height:6px"></div>')
      + items.map(it => `
        <button class="nav-item" data-nav="${it.id}" title="${esc(it.label)}">
          ${icon(it.icon, 18)}<span class="nav-label grow" style="text-align:left">${esc(it.label)}</span>
        </button>`).join('');
  }).join('');
  markActive();
}

function markActive() {
  qa('[data-nav]').forEach(b => b.classList.toggle('on', b.dataset.nav === app.viewId));
}

function toggleRail() {
  const sb = q('#sidebar');
  sb.classList.toggle('mini');
  prefs.set('mini', sb.classList.contains('mini'));
  setTimeout(() => window.dispatchEvent(new Event('nova:resize')), 340);
}

/* ---------- routing ---------- */
async function go(id, params = null) {
  if (!VIEWS[id]) id = 'dashboard';
  const stage = q('#stage');

  // leave the old view
  // Force-end any splitter drag still in progress BEFORE the DOM under it
  // is wiped out below (stage.innerHTML =) - a keyboard shortcut like
  // Ctrl+N can fire go() while the mouse button is still held down over a
  // splitter. Left alone, the splitter (and its pointerup/pointercancel
  // listeners) disappears with the button never having been released,
  // which would otherwise strand document.body in 'is-dragging' forever
  // (wrong cursor app-wide, text selection dead) with nothing left able
  // to clear it. See panels.js's cancelAllDrags() for the full story.
  Panels.cancelAllDrags();
  try { app.view?.destroy?.(); } catch (e) { console.error(e); }
  app.viewId = id; app.params = params;
  prefs.set('lastView', id);
  markActive();

  stage.innerHTML = `<div class="pad grow col gap4">
      <div class="skel" style="height:64px;border-radius:var(--r-xl)"></div>
      <div class="skel grow" style="border-radius:var(--r-xl)"></div>
    </div>`;

  let mod;
  try { mod = (await VIEWS[id]()).default; }
  catch (e) {
    console.error(e);
    stage.innerHTML = `<div class="empty">${icon('warn', 22)}<div class="h3">This screen could not be opened</div>
      <div class="small muted">${esc(e.message || e)}</div></div>`;
    return;
  }

  app.view = mod;
  q('#viewTitle').textContent = typeof mod.title === 'function' ? mod.title(app) : (mod.title || '');
  q('#viewSub').textContent = '';
  q('#viewActions').innerHTML = '';

  const host = el('div', 'view grow col');
  host.style.minHeight = '0';
  stage.innerHTML = '';
  stage.appendChild(host);

  const ctx = {
    app, api, params,
    go,
    setSub: (t) => { q('#viewSub').textContent = t || ''; },
    setTitle: (t) => { q('#viewTitle').textContent = t || ''; },
    setActions: (list) => paintActions(list),
    refresh: () => refresh(),
  };

  try {
    await mod.mount(host, ctx);
    Panels.init(host);
  } catch (e) {
    console.error(e);
    host.innerHTML = `<div class="empty">${icon('warn', 22)}<div class="h3">Something went wrong on this screen</div>
      <div class="small muted">${esc(e.message || e)}</div></div>`;
  }
}

function paintActions(list = []) {
  const bar = q('#viewActions');
  bar.innerHTML = '';
  list.forEach(a => {
    if (a.el) { bar.appendChild(a.el); return; }
    const b = el('button', `btn ${a.cls || ''} ${a.iconOnly ? 'btn-icon' : ''}`);
    b.innerHTML = (a.icon ? icon(a.icon, 15) : '') + (a.iconOnly ? '' : esc(a.label || ''));
    if (a.title) b.title = a.title;
    b.onclick = (e) => a.onClick?.(e, b);
    bar.appendChild(b);
  });
}

function refresh() { return go(app.viewId, app.params); }

function setBusy(on) {
  document.body.style.cursor = on ? 'progress' : '';
}

/* ---------- user menu ---------- */
function userMenu(anchor) {
  import('./core.js').then(({ menu }) => menu(anchor, [
    { label: 'Settings', icon: 'gear', onClick: () => go('settings') },
    { label: 'Keyboard shortcuts', icon: 'sparkles', hint: 'F1', onClick: shortcutsHelp },
    { label: 'Reset panel layout', icon: 'refresh', onClick: async () => {
        Panels.resetAll(); toast('Layout reset', 'Every panel is back to its default size.', 'ok'); refresh();
      } },
    '-',
    { label: 'Sign out', icon: 'logout', danger: true, onClick: async () => {
        if (await confirm('Sign out?', 'You will need to sign in again to use the app.')) {
          try { await api.sign_out(); } catch {}
          location.reload();
        }
      } },
  ], { align: 'left' }));
}

/* ---------- command palette ---------- */
async function palette() {
  const body = node(`<div>
    <div class="search" style="height:40px">
      ${icon('search', 16)}
      <input id="pq" placeholder="Search screens, customers, items, bills…" autocomplete="off">
    </div>
    <div id="pres" class="col" style="margin-top:10px;max-height:min(52vh,420px);overflow:auto"></div>
  </div>`);

  const close = { fn: null };
  const p = modal({ title: 'Go to', icon: 'search', wide: 'modal-wide', body, actions: [],
    onOpen: (_bd, cl) => { close.fn = cl; } });

  const input = q('#pq', body), res = q('#pres', body);
  const navItems = NAV.flatMap(s => s.items).concat([{ id: 'settings', label: 'Settings', icon: 'gear' }]);
  let rows = [], sel = 0;

  const paint = () => {
    res.innerHTML = rows.length ? rows.map((r, i) => `
      <button class="ac-item ${i === sel ? 'on' : ''}" data-i="${i}">
        <span style="color:var(--ink-3)">${icon(r.icon || 'chevRight', 15)}</span>
        <span class="grow ellipsis">${r.html || esc(r.label)}</span>
        <span class="small muted">${esc(r.hint || '')}</span>
      </button>`).join('')
      : `<div class="small muted" style="padding:14px 6px">No matches.</div>`;
  };

  const search = debounce(async () => {
    const term = input.value.trim();
    rows = navItems
      .filter(n => !term || n.label.toLowerCase().includes(term.toLowerCase()))
      .map(n => ({ ...n, hint: 'Screen', run: () => go(n.id) }));
    if (term.length >= 2) {
      try {
        const hits = await api.quick_search(term);
        rows = rows.concat((hits || []).map(h => ({
          label: h.label, icon: h.kind === 'customer' ? 'users' : h.kind === 'item' ? 'box' : 'book',
          html: mark(h.label, term) + (h.sub ? ` <span class="small muted">· ${esc(h.sub)}</span>` : ''),
          hint: h.kind === 'customer' ? 'Customer' : h.kind === 'item' ? 'Item' : 'Bill',
          run: () => {
            if (h.kind === 'customer') go('insights', { customerId: h.id });
            else if (h.kind === 'item') go('inventory', { itemId: h.id });
            else go('history', { billId: h.id });
          },
        })));
      } catch {}
    }
    sel = 0; paint();
  }, 120);

  input.oninput = search;
  search.now();

  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, rows.length - 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[sel]; if (r) { close.fn?.(null); r.run(); }
    }
  };
  on(res, 'click', '.ac-item', (e, b) => { const r = rows[+b.dataset.i]; close.fn?.(null); r?.run(); });
  return p;
}

/* ---------- shortcuts help ---------- */
function shortcutsHelp() {
  const rows = [
    ['Global', [
      ['Ctrl + K', 'Search / jump to anything'],
      ['Ctrl + N', 'Start a new bill'],
      ['Ctrl + B', 'Collapse or expand the sidebar'],
      ['Ctrl + 1…9', 'Jump to the nth screen'],
      ['F1', 'This list'],
      ['Esc', 'Close a dialog or dropdown'],
    ]],
    ['New Bill', [
      ['*', 'From the customer row: jump to the first item.\nAnywhere else: save & print the bill.'],
      ['Enter', 'Move forward through the form; on the last row it adds a new one'],
      ['↑ ↓ ← →', 'Move between fields like a grid'],
      ['Ctrl + Enter', 'Save & print'],
      ['Ctrl + D', 'Delete the current item row'],
    ]],
    ['Panels', [
      ['Drag an edge', 'Resize the two panels either side of it'],
      ['Click the handle', 'Collapse or bring back a panel'],
      ['Double-click an edge', 'Same as clicking the handle'],
      ['Focus edge + ← → ↑ ↓', 'Resize with the keyboard'],
    ]],
  ];
  modal({
    title: 'Keyboard shortcuts', icon: 'sparkles', wide: 'modal-wide',
    body: rows.map(([sec, list]) => `
      <div class="overline" style="margin:14px 0 8px">${esc(sec)}</div>
      ${list.map(([k, d]) => `<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line-soft);align-items:flex-start">
          <div style="font-size:var(--t-13);color:var(--ink-2);white-space:pre-line">${esc(d)}</div>
          <kbd style="margin-left:16px">${esc(k)}</kbd>
        </div>`).join('')}`).join(''),
    actions: [{ label: 'Close', cls: 'btn-primary', default: true }],
  });
}

/* ---------- global keys ---------- */
document.addEventListener('keydown', (e) => {
  const typing = e.target.matches('input,textarea,select,[contenteditable]');
  if (e.key === 'F1') { e.preventDefault(); shortcutsHelp(); return; }
  if (e.ctrlKey && !e.shiftKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'k') { e.preventDefault(); palette(); return; }
    if (k === 'b') { e.preventDefault(); toggleRail(); return; }
    if (k === 'n' && !typing) { e.preventDefault(); go('newbill'); return; }
    if (/^[1-9]$/.test(e.key)) {
      const all = NAV.flatMap(s => s.items);
      const t = all[+e.key - 1];
      if (t) { e.preventDefault(); go(t.id); }
      return;
    }
  }
}, false);

window.addEventListener('DOMContentLoaded', boot);
export { go, palette, shortcutsHelp };
