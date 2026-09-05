/* ============================================================
   views/settings.js — Settings: a left rail of sections in a
   split panel, each section a plain scrolling column of fields,
   toggles and buttons. Every write goes through api.set_setting
   and shows a quiet confirmation toast.
   ============================================================ */

import { api } from '../api.js';
import * as Panels from '../panels.js';
import {
  q, qa, node, on, esc, icon, num, toast, modal, confirm, emptyState,
  debounce, dmy, hm12, prefs,
  setTheme, getTheme,
} from '../core.js';

const SECTIONS = [
  { id: 'profile', label: 'Business profile',     icon: 'box' },
  { id: 'appearance', label: 'Appearance',         icon: 'sparkles' },
  { id: 'billing', label: 'Billing preferences',   icon: 'rupee' },
  { id: 'stock',   label: 'Stock & Khata',         icon: 'history' },
  { id: 'backup',  label: 'Backup & data',         icon: 'save' },
  { id: 'users',   label: 'Users & security',      icon: 'shield' },
  { id: 'about',   label: 'About',                 icon: 'info' },
];

let S = null;

export default {
  title: 'Settings',

  async mount(root, ctx) {
    S = {
      ctx, root,
      active: prefs.get('settingsTab', 'profile'),
      settings: {}, users: [], appInfo: null, dataDir: '',
      loading: true,
    };
    if (!SECTIONS.some(s => s.id === S.active)) S.active = 'profile';

    paint(root);
    wire();
    await reload();
  },

  destroy() { S = null; },
};

/* ============================ layout ============================ */
function paint(root) {
  root.innerHTML = `
  <div class="split split-h grow" data-split="settings.rail" style="padding:var(--s4) var(--s5) var(--s5)">
    <div class="pane pane-sized" data-size="232" data-min="190" data-max="320">
      <div class="panel grow">
        <div class="panel-head"><div class="h2 grow">Settings</div></div>
        <div class="grow scroll-y" style="padding:10px">
          <div class="set-tabs" id="tabs">
            ${SECTIONS.map(s => `<button class="set-tab ${s.id === S.active ? 'on' : ''}" data-sec="${s.id}">
              ${icon(s.icon, 16)}<span class="grow ellipsis">${esc(s.label)}</span></button>`).join('')}
          </div>
        </div>
      </div>
    </div>

    <div class="pane pane-fill" style="padding-left:6px">
      <div class="panel grow scroll-y" id="secBody"></div>
    </div>
  </div>`;
}

function isOwner() {
  const authOn = S.settings.auth_enabled === '1' || S.settings.auth_enabled === 1;
  if (!authOn) return true;
  return (S.ctx.app.user?.role || '').toLowerCase() === 'owner';
}

/* ============================ data ============================ */
async function reload() {
  S.loading = true;
  renderSection();
  try {
    const [settings, users, boot] = await Promise.all([
      api.get_settings(),
      api.list_users().catch(() => []),
      api.bootstrap().catch(() => null),
    ]);
    S.settings = settings || {};
    S.users = users || [];
    S.appInfo = boot?.app || S.appInfo;
  } catch (e) {
    toast('Could not load settings', e.message, 'bad');
  }
  try { S.dataDir = await api.data_dir(); } catch { S.dataDir = S.dataDir || ''; }
  S.loading = false;
  renderSection();
}

async function writeSetting(key, value, opts = {}) {
  try {
    await api.set_setting(key, value);
    S.settings[key] = value;
    if (!opts.quiet) toast('Saved', opts.message || 'Your change has been saved.', 'ok');
    return true;
  } catch (e) {
    toast('Could not save this setting', e.message, 'bad');
    return false;
  }
}

/* ============================ section switch ============================ */
function renderSection() {
  const host = q('#secBody', S.root);
  if (!host) return;
  if (S.loading) {
    host.innerHTML = `<div class="col gap3" style="padding:20px">
      <div class="skel" style="height:22px;width:220px"></div>
      <div class="skel" style="height:120px"></div>
      <div class="skel" style="height:80px"></div>
    </div>`;
    return;
  }
  const fn = {
    profile: sectionProfile, billing: sectionBilling, stock: sectionStock,
    appearance: sectionAppearance,
    backup: sectionBackup, users: sectionUsers, about: sectionAbout,
  }[S.active];
  host.innerHTML = fn ? fn() : '';
  wireSection();
}

function toggleRow(key, label, desc, isOn) {
  return `<div class="set-row">
    <div class="txt"><div class="t">${esc(label)}</div><div class="d">${desc}</div></div>
    <button class="switch ${isOn ? 'on' : ''}" data-toggle="${key}" type="button" role="switch" aria-checked="${isOn}"
      ${isOwner() ? '' : 'disabled title="Only the store owner can change settings"'}></button>
  </div>`;
}

/* ============================ Business profile ============================ */
function sectionProfile() {
  const s = S.settings, owner = isOwner();
  return `
    <div class="panel-head"><div class="h2 grow">Business profile</div></div>
    <div class="col gap4" style="padding:18px 20px;max-width:560px">
      <div class="small muted">These details print on every bill — the shop name, address and logo shown at the top of the PDF.</div>
      <div class="field">
        <label class="label">Shop name<span class="req">*</span></label>
        <input class="input" id="p-name" value="${esc(s.store_name || '')}" ${owner ? '' : 'disabled'} placeholder="Balaji Store">
      </div>
      <div class="field">
        <label class="label">Phone</label>
        <input class="input mono" id="p-phone" value="${esc(s.store_contact || '')}" ${owner ? '' : 'disabled'} placeholder="+91 94370 12345">
      </div>
      <div class="field">
        <label class="label">Address</label>
        <textarea class="input" id="p-addr" rows="2" ${owner ? '' : 'disabled'} placeholder="Shop address, town, district">${esc(s.store_address || '')}</textarea>
      </div>
      <div class="field">
        <label class="label">Logo path</label>
        <input class="input mono" id="p-logo" value="${esc(s.logo_path || '')}" ${owner ? '' : 'disabled'} placeholder="C:\\path\\to\\logo.png">
        <div class="tiny muted">Path to a PNG or JPG on this computer. Leave blank to print bills without a logo.</div>
      </div>
      <div class="row gap3" style="margin-top:4px">
        <button class="btn btn-primary ${owner ? '' : 'is-disabled'}" id="saveProfile" ${owner ? '' : 'title="Only the store owner can change settings"'}>${icon('save', 15)}Save changes</button>
      </div>
    </div>`;
}

async function saveProfile() {
  if (!isOwner()) return;
  const host = q('#secBody', S.root);
  const btn = q('#saveProfile', host);
  const name = q('#p-name', host).value.trim() || 'Balaji Store';
  const phone = q('#p-phone', host).value.trim();
  const addr = q('#p-addr', host).value.trim();
  const logo = q('#p-logo', host).value.trim();
  const orig = btn.innerHTML;
  btn.classList.add('is-disabled');
  btn.innerHTML = `<span class="spinner" style="border-color:rgba(255,255,255,.35);border-top-color:#fff"></span>Saving…`;
  try {
    await Promise.all([
      api.set_setting('store_name', name),
      api.set_setting('store_contact', phone),
      api.set_setting('store_address', addr),
      api.set_setting('logo_path', logo),
    ]);
    Object.assign(S.settings, { store_name: name, store_contact: phone, store_address: addr, logo_path: logo });
    toast('Saved', 'Business profile updated.', 'ok');
  } catch (e) {
    toast('Could not save', e.message, 'bad');
  } finally {
    btn.classList.remove('is-disabled');
    btn.innerHTML = orig;
  }
}

/* ============================ Billing preferences ============================ */
function sectionBilling() {
  const s = S.settings, owner = isOwner();
  const roundOn = s.round_off === '1' || s.round_off === 1;
  return `
    <div class="panel-head"><div class="h2 grow">Billing preferences</div></div>
    <div class="col gap4" style="padding:18px 20px;max-width:560px">
      <div class="row gap3">
        <div class="field" style="width:150px">
          <label class="label">Bill prefix</label>
          <input class="input mono" id="b-prefix" maxlength="6" value="${esc(s.bill_prefix || '')}" ${owner ? '' : 'disabled'} placeholder="BS">
        </div>
        <div class="field grow">
          <label class="label">Next bill number</label>
          <input class="input mono" id="b-seq" value="${esc(s.next_bill_seq ?? '')}" ${owner ? '' : 'disabled'} placeholder="1">
        </div>
      </div>
      <div class="row gap2" style="padding:10px 12px;background:var(--warn-soft);border-radius:var(--r-md);color:var(--warn-ink);align-items:flex-start">
        ${icon('warn', 15)}<span class="small">Lowering this can produce a bill number that already exists. Only change it if you know why — raising it is always safe.</span>
      </div>
      <div class="row gap3">
        <button class="btn btn-primary ${owner ? '' : 'is-disabled'}" id="saveBilling" ${owner ? '' : 'title="Only the store owner can change settings"'}>${icon('save', 15)}Save changes</button>
      </div>
      <div class="divider"></div>
      ${toggleRow('round_off', 'Round off the grand total', 'Rounds the grand total on new bills to the nearest whole rupee.', roundOn)}
    </div>`;
}

async function saveBilling() {
  if (!isOwner()) return;
  const host = q('#secBody', S.root);
  const prefix = q('#b-prefix', host).value.trim();
  const seqRaw = q('#b-seq', host).value.trim();
  const n = num(seqRaw, NaN);
  if (!isFinite(n) || n < 1 || Math.round(n) !== n) {
    return toast('Check the bill number', 'Next bill number must be a whole number of 1 or more.', 'bad');
  }
  const current = num(S.settings.next_bill_seq, 0);
  if (n < current) {
    const yes = await confirm('Lower the next bill number?',
      `The next bill number is currently ${current}. Lowering it to ${n} can produce a bill number that already exists.\n\nContinue anyway?`,
      { danger: true, ok: 'Lower it' });
    if (!yes) return;
  }
  const btn = q('#saveBilling', host);
  btn.classList.add('is-disabled');
  try {
    await Promise.all([
      api.set_setting('bill_prefix', prefix),
      api.set_setting('next_bill_seq', String(n)),
    ]);
    Object.assign(S.settings, { bill_prefix: prefix, next_bill_seq: String(n) });
    toast('Saved', 'Billing preferences updated.', 'ok');
  } catch (e) {
    toast('Could not save', e.message, 'bad');
  } finally {
    btn.classList.remove('is-disabled');
  }
}

/* ============================ Stock & Khata ============================ */
function sectionStock() {
  const s = S.settings;
  const stockOn = s.track_stock === '1' || s.track_stock === 1;
  const khataOn = s.track_khata === '1' || s.track_khata === 1;
  return `
    <div class="panel-head"><div class="h2 grow">Stock & Khata</div></div>
    <div class="col" style="padding:6px 20px;max-width:620px">
      ${toggleRow('track_stock', 'Track stock levels',
        'Turn this on only once you are actually counting stock. While it is off there are no low-stock warnings when billing, the stock columns are hidden and Stock History is put away — but quantities keep being recorded underneath, so switching it on later shows real numbers rather than starting from zero.',
        stockOn)}
      ${toggleRow('track_khata', 'Use the credit ledger (Khata)',
        "Turn this on only once you are actually letting customers buy on credit. While it is off, the Khata / Ledger screen is put away and a customer's balance is not shown elsewhere — but every bill still records how much was paid, so switching it on later shows the real ledger rather than starting from zero.",
        khataOn)}
    </div>`;
}

/* ============================ Backup & data ============================ */
function sectionBackup() {
  const s = S.settings, owner = isOwner();
  const autoOn = s.auto_backup_enabled === '1' || s.auto_backup_enabled === 1;
  const keep = s.auto_backup_keep ?? '14';
  const last = s.auto_backup_last;
  let lastText = 'No automatic snapshot has been taken yet.';
  if (last) {
    const [d, t] = String(last).split(' ');
    lastText = `Latest snapshot: ${dmy(d)}${t ? ' at ' + hm12(t.slice(0, 5)) : ''}.`;
  }
  return `
    <div class="panel-head"><div class="h2 grow">Backup & data</div></div>
    <div class="col gap4" style="padding:18px 20px;max-width:620px">

      <div class="set-row">
        <div class="txt">
          <div class="t">Back up now</div>
          <div class="d">Saves a full snapshot of your data. ${esc(lastText)}</div>
        </div>
        <button class="btn btn-primary ${owner ? '' : 'is-disabled'}" id="backupNow" ${owner ? '' : 'title="Only the store owner can back up data"'}>${icon('save', 15)}Backup now</button>
      </div>

      <div class="divider"></div>

      ${toggleRow('auto_backup_enabled', 'Automatic daily backup',
        'Saves a snapshot of your data once a day. This protects you from a bad import or an accidental bulk delete — but not from the drive itself failing, so keep making your own backups too.',
        autoOn)}
      <div class="set-row">
        <div class="txt">
          <div class="t">Keep snapshots for</div>
          <div class="d">How many automatic snapshots to keep (1–90 days).</div>
        </div>
        <div class="row gap1">
          <input class="input input-sm mono" id="keepDays" style="width:64px;text-align:right" value="${esc(String(keep))}" ${owner ? '' : 'disabled'}>
          <span class="small muted">days</span>
        </div>
      </div>

      <div class="divider"></div>

      <div class="set-row">
        <div class="txt"><div class="t">Restore from a backup file</div><div class="d">Replaces your current data with a backup file's contents. This cannot be undone.</div></div>
        <button class="btn btn-danger ${owner ? '' : 'is-disabled'}" id="restoreBackup" ${owner ? '' : 'title="Only the store owner can restore data"'}>${icon('upload', 15)}Restore…</button>
      </div>

      <div class="row gap2">
        <button class="btn ${owner ? '' : 'is-disabled'}" id="exportInv" ${owner ? '' : 'title="Only the store owner can export data"'}>${icon('download', 14)}Export inventory</button>
        <button class="btn ${owner ? '' : 'is-disabled'}" id="importInv" ${owner ? '' : 'title="Only the store owner can import data"'}>${icon('upload', 14)}Import inventory</button>
      </div>

      <div class="divider"></div>

      <div class="set-row">
        <div class="txt"><div class="t">Data folder</div><div class="d mono ellipsis">${esc(S.dataDir || '—')}</div></div>
        <button class="btn btn-ghost" id="openDataFolder">${icon('folder', 15)}Open folder</button>
      </div>
    </div>`;
}

async function saveKeepDays(input) {
  if (!isOwner()) return;
  let n = Math.round(num(input.value, 14));
  if (!isFinite(n) || n < 1) n = 1;
  if (n > 90) n = 90;
  input.value = String(n);
  await writeSetting('auto_backup_keep', String(n));
}

async function doBackupNow() {
  if (!isOwner()) return;
  const host = q('#secBody', S.root);
  const btn = q('#backupNow', host);
  const orig = btn.innerHTML;
  btn.classList.add('is-disabled');
  btn.innerHTML = `<span class="spinner" style="border-color:rgba(255,255,255,.35);border-top-color:#fff"></span>Backing up…`;
  try {
    const res = await api.backup_now();
  if (!S) return;   // the screen was left while this was in flight
    S.settings.auto_backup_last = res?.last || S.settings.auto_backup_last;
    toast('Backup complete', `A snapshot was saved to: ${res?.path || 'the backups folder'}`, 'ok', 6000);
    renderSection();
  } catch (e) {
    toast('Backup failed', e.message, 'bad');
    btn.classList.remove('is-disabled');
    btn.innerHTML = orig;
  }
}

async function doRestore() {
  if (!isOwner()) return;
  const yes = await confirm('Restore from a backup file?',
    'This replaces everything currently in the app with the contents of the backup file you pick next.\n\nThis cannot be undone — consider taking a fresh backup first.',
    { danger: true, ok: 'Choose file…' });
  if (!yes) return;
  try {
    await api.restore_backup();
    toast('Restore complete', 'Your data has been replaced with the backup.', 'ok');
    S.ctx.refresh();
  } catch (e) {
    toast('Restore failed', e.message, 'bad');
  }
}

async function doExportInv() {
  if (!isOwner()) return;
  try { const path = await api.export_items(); toast('Exported', `Inventory saved to ${path}`, 'ok'); }
  catch (e) { toast('Export failed', e.message, 'bad'); }
}

async function doImportInv() {
  if (!isOwner()) return;
  try {
    const res = await api.import_items();
    const { added = 0, updated = 0, skipped = 0 } = res || {};
    toast('Import complete', `${added} added, ${updated} updated, ${skipped} skipped.`, 'ok', 6000);
  } catch (e) { toast('Import failed', e.message, 'bad'); }
}

async function doOpenDataFolder() {
  try { await api.open_folder('data'); }
  catch (e) { toast('Could not open the folder', e.message, 'bad'); }
}

/* ============================ Users & security ============================ */
function sectionUsers() {
  const s = S.settings, owner = isOwner();
  const authOn = s.auth_enabled === '1' || s.auth_enabled === 1;
  return `
    <div class="panel-head"><div class="h2 grow">Users & security</div></div>
    <div class="col gap4" style="padding:18px 20px">
      ${toggleRow('auth_enabled', 'Require sign-in', authOn
        ? 'Sign-in is on. Everyone who uses this app needs their own account.'
        : 'Sign-in is off. Anyone who opens this computer can use the app, including deleting bills and resetting stock. Turning it on lets you add staff accounts that can bill and manage inventory, but cannot delete bills, reset stock, import data or change settings.',
        authOn)}
      <div class="divider"></div>
      <div class="row between">
        <div class="h3">Accounts</div>
        <div class="row gap2">
          <button class="btn btn-ghost" id="viewAudit">${icon('history', 14)}Activity log</button>
          <button class="btn btn-primary ${owner ? '' : 'is-disabled'}" id="addUser" ${owner ? '' : 'title="Only the store owner can add users"'}>${icon('plus', 14)}Add user</button>
        </div>
      </div>
      <div class="col gap2" id="userList" style="max-width:640px">
        ${S.users.length ? S.users.map(u => userRowHtml(u, owner)).join('')
          : emptyState('users', 'No user accounts yet', 'Add an account to get started.')}
      </div>
    </div>`;
}

function userRowHtml(u, owner) {
  const roleLabel = u.role === 'owner' ? 'Owner' : 'Staff';
  const active = u.is_active !== 0 && u.is_active !== false;
  const initials = String(u.display_name || u.username || '?').trim().slice(0, 2).toUpperCase();
  return `<div class="list-row" data-uid="${u.id}">
    <div class="avatar">${esc(initials)}</div>
    <div class="grow ellipsis">
      <div class="row gap2">
        <span class="strong ellipsis">${esc(u.display_name || u.username)}</span>
        <span class="pill ${u.role === 'owner' ? 'pill-accent' : 'pill'}">${roleLabel}</span>
        ${active ? '' : '<span class="pill pill-bad">Disabled</span>'}
      </div>
      <div class="tiny muted ellipsis">@${esc(u.username)}</div>
    </div>
    ${owner ? `<div class="row gap1">
      <button class="btn btn-ghost btn-icon btn-sm" data-uact="edit" title="Edit user">${icon('pencil', 14)}</button>
      <button class="btn btn-ghost btn-icon btn-sm" data-uact="delete" title="Remove user">${icon('trash', 14)}</button>
    </div>` : ''}
  </div>`;
}

async function openUserModal(user) {
  const isEdit = !!user;
  let role = user?.role || 'staff';
  let active = isEdit ? (user.is_active !== 0 && user.is_active !== false) : true;

  const body = node(`<div class="col gap4">
    <div class="row gap3">
      <div class="field grow">
        <label class="label">Username${isEdit ? '' : '<span class="req">*</span>'}</label>
        <input class="input" id="u-username" autocomplete="off" value="${esc(user?.username || '')}" ${isEdit ? 'disabled' : ''}>
      </div>
      <div class="field grow">
        <label class="label">Display name</label>
        <input class="input" id="u-display" autocomplete="off" value="${esc(user?.display_name || '')}">
      </div>
    </div>
    <div class="field">
      <label class="label">Role</label>
      <div class="seg" id="u-role" style="width:100%">
        <button class="${role === 'staff' ? 'on' : ''}" data-r="staff" style="flex:1">Staff (billing &amp; lookup only)</button>
        <button class="${role === 'owner' ? 'on' : ''}" data-r="owner" style="flex:1">Owner (full access)</button>
      </div>
    </div>
    ${!isEdit ? `<div class="field">
        <label class="label">Password<span class="req">*</span></label>
        <input class="input" type="password" id="u-pass" autocomplete="new-password">
      </div>
      <div class="tiny muted" style="margin-top:-10px">At least 8 characters for an owner account, 6 for staff.</div>` : ''}
    ${isEdit ? `<div class="set-row">
        <div class="txt"><div class="t">Account active</div><div class="d">Turn off to stop this person signing in without deleting their account.</div></div>
        <button class="switch ${active ? 'on' : ''}" id="u-active" type="button" role="switch" aria-checked="${active}"></button>
      </div>` : ''}
    <div class="tiny" style="color:var(--bad-ink);min-height:14px" data-err="u-form"></div>
  </div>`);

  const res = await modal({
    title: isEdit ? `Edit user: ${user.display_name || user.username}` : 'Add user',
    icon: isEdit ? 'pencil' : 'plus',
    body,
    actions: [
      { label: 'Cancel', value: false },
      {
        label: isEdit ? 'Save changes' : 'Add user', cls: 'btn-primary', default: true,
        onClick: async () => {
          const username = q('#u-username', body).value.trim();
          const display = q('#u-display', body).value.trim();
          const pass = q('#u-pass', body)?.value || '';
          const err = q('[data-err="u-form"]', body);
          err.textContent = '';
          if (!isEdit) {
            if (!username) { err.textContent = 'Username is required.'; return false; }
            const minLen = role === 'owner' ? 8 : 6;
            if (pass.length < minLen) { err.textContent = `Password must be at least ${minLen} characters.`; return false; }
          }
          try {
            if (isEdit) {
              await api.update_user(user.id, { display_name: display, role, is_active: active ? 1 : 0 });
              toast('User updated', `${display || username} was saved.`, 'ok');
            } else {
              await api.create_user({ username, display_name: display || username, role, password: pass });
              toast('User added', `${username} can now sign in.`, 'ok');
            }
          } catch (e) { err.textContent = e.message; return false; }
          return true;
        },
      },
    ],
    onOpen: (bd) => {
      on(q('#u-role', bd), 'click', 'button', (e, b) => {
        qa('button', q('#u-role', bd)).forEach(x => x.classList.toggle('on', x === b));
        role = b.dataset.r;
      });
      const t = q('#u-active', bd);
      if (t) t.onclick = () => { active = !active; t.classList.toggle('on', active); t.setAttribute('aria-checked', String(active)); };
    },
  });
  if (res) await reload();
}

async function deleteUser(u) {
  if (!isOwner()) return;
  const yes = await confirm('Remove this account?',
    `Delete the account '${u.username}'? Bills and other records they created are kept — only the sign-in account is removed.`,
    { danger: true, ok: 'Delete' });
  if (!yes) return;
  try {
    await api.delete_user(u.id);
    toast('Account removed', `${u.username} can no longer sign in.`, 'ok');
    await reload();
  } catch (e) { toast('Could not remove this account', e.message, 'bad'); }
}

function auditRowHtml(r) {
  const denied = r.outcome === 'denied';
  return `<div class="tr" style="${denied ? 'color:var(--bad-ink)' : ''}">
    <div class="ellipsis" style="width:150px">${esc(r.created_at || '—')}</div>
    <div class="ellipsis" style="width:120px">${esc(r.username || '—')}</div>
    <div class="ellipsis" style="width:80px">${esc(r.role || '—')}</div>
    <div class="ellipsis" style="width:170px">${denied ? 'BLOCKED: ' : ''}${esc(r.action || '—')}</div>
    <div class="grow ellipsis">${esc(r.detail || '')}</div>
  </div>`;
}

async function openAuditLog() {
  const body = node(`<div class="col gap3" style="width:100%">
    <div class="search"><input id="al-q" placeholder="Search by person, action or detail…" autocomplete="off"></div>
    <div class="tbl-head" style="border-radius:var(--r-md)">
      <div style="width:150px">When</div><div style="width:120px">Who</div><div style="width:80px">Role</div>
      <div style="width:170px">Action</div><div class="grow">Details</div>
    </div>
    <div class="scroll-y" id="al-body" style="max-height:360px"></div>
  </div>`);

  const load = async (term) => {
    const host = q('#al-body', body);
    host.innerHTML = `<div class="tr"><div class="skel" style="height:16px;width:100%;margin:auto 10px"></div></div>`;
    try {
      const rows = await api.audit_log(term || '') || [];
      host.innerHTML = rows.length ? rows.map(auditRowHtml).join('')
        : emptyState('history', 'Nothing logged yet', 'Sign-ins, deletions, imports and other sensitive actions will show up here.');
    } catch (e) { host.innerHTML = emptyState('warn', 'Could not load the activity log', e.message); }
  };

  await modal({
    title: 'Activity log', icon: 'history', wide: 'modal-wide',
    body,
    actions: [{ label: 'Close', cls: 'btn-primary', default: true }],
    onOpen: (bd) => {
      const doSearch = debounce(() => load(q('#al-q', bd).value.trim()), 220);
      q('#al-q', bd).addEventListener('input', doSearch);
      load('');
    },
  });
}

/* ============================ Appearance ============================ */
const THEME_CHOICES = [
  { key: 'light',  label: 'Light',          hint: 'Bright, best in a well-lit shop',
    ink: '#0F1729', bg: '#F6F7F9', card: '#FFFFFF', line: '#E5E8EE', dot: '#5B4BE8' },
  { key: 'dark',   label: 'Dark',           hint: 'Easier at night and on long shifts',
    ink: '#F2F4F7', bg: '#0E1014', card: '#16181D', line: '#262A32', dot: '#7B6BFF' },
  { key: 'system', label: 'Follow Windows', hint: 'Switches with your Windows setting',
    ink: '#0F1729', bg: 'linear-gradient(135deg,#F6F7F9 50%,#0E1014 50%)', card: '#FFFFFF', line: '#D3D8E0', dot: '#5B4BE8' },
];

function themeCard(c, current) {
  const on = c.key === current;
  return `
    <button class="card tap" data-theme="${c.key}" style="
        padding:0;overflow:hidden;text-align:left;flex:1;min-width:0;
        border:1.5px solid ${on ? 'var(--accent)' : 'var(--line)'};
        box-shadow:${on ? 'var(--ring)' : 'var(--sh-1)'}">
      <div style="height:78px;background:${c.bg};padding:10px;display:flex;gap:7px">
        <div style="width:26px;border-radius:5px;background:${c.card};border:1px solid ${c.line}"></div>
        <div class="col gap1 grow" style="min-width:0">
          <div style="height:9px;border-radius:3px;background:${c.card};border:1px solid ${c.line}"></div>
          <div style="height:26px;border-radius:5px;background:${c.card};border:1px solid ${c.line};
                      display:flex;align-items:center;padding:0 6px;gap:5px">
            <span style="width:5px;height:5px;border-radius:50%;background:${c.dot}"></span>
            <span style="height:5px;border-radius:3px;background:${c.line};flex:1"></span>
          </div>
        </div>
      </div>
      <div class="col gap1" style="padding:10px 12px 12px">
        <span class="strong ellipsis" style="font-size:var(--t-13)">${esc(c.label)}</span>
        <div class="row gap2" style="min-width:0">
          <span class="tiny muted grow ellipsis" title="${esc(c.hint)}">${esc(c.hint)}</span>
          ${on ? `<span class="pill pill-accent none">${icon('check', 11)}In use</span>` : ''}
        </div>
      </div>
    </button>`;
}

function sectionAppearance() {
  const current = getTheme();
  return `
    <div class="panel-head"><div class="h2 grow">Appearance</div></div>
    <div class="col gap4" style="padding:18px 20px;max-width:640px">
      <div class="small muted">How the app looks on this computer. It is remembered per
        machine, so the counter PC and the back office can each have their own.</div>
      <div class="row gap3" style="align-items:stretch">
        ${THEME_CHOICES.map(c => themeCard(c, current)).join('')}
      </div>
      <div class="divider"></div>
      <div class="set-row">
        <div class="txt">
          <div class="t">Reset panel layout</div>
          <div class="d">Puts every resizable panel back to its default size and open state.</div>
        </div>
        <button class="btn btn-ghost" id="resetLayoutA">${icon('refresh', 15)}Reset layout</button>
      </div>
    </div>`;
}

/* ============================ About ============================ */
function sectionAbout() {
  const info = S.appInfo || {};
  return `
    <div class="panel-head"><div class="h2 grow">About</div></div>
    <div class="col gap4" style="padding:18px 20px;max-width:560px">
      <div class="row gap3" style="align-items:center">
        <div class="brand-mark" style="width:44px;height:44px">${icon('box', 20)}</div>
        <div>
          <div class="h2">${esc(info.name || 'Vikray')}</div>
          <div class="small muted">Version ${esc(info.version || '—')}</div>
        </div>
      </div>
      <div class="divider"></div>
      <div class="set-row">
        <div class="txt"><div class="t">Data folder</div><div class="d mono ellipsis">${esc(S.dataDir || '—')}</div></div>
        <button class="btn btn-ghost" id="openDataFolder2">${icon('folder', 15)}Open folder</button>
      </div>
      <div class="set-row">
        <div class="txt"><div class="t">Reset panel layout</div><div class="d">Puts every resizable panel in the app back to its default size and open state.</div></div>
        <button class="btn btn-ghost" id="resetLayout">${icon('refresh', 15)}Reset layout</button>
      </div>
    </div>`;
}

function doResetLayout() {
  Panels.resetAll();
  toast('Layout reset', 'Every panel is back to its default size.', 'ok');
  S.ctx.refresh();
}

/* ============================ toggle handler ============================ */
async function onToggle(key, btn) {
  if (!isOwner()) { toast('Not allowed', 'Only the store owner can change settings.', 'bad'); return; }
  const next = !btn.classList.contains('on');
  btn.classList.toggle('on', next);
  btn.setAttribute('aria-checked', String(next));
  const value = next ? '1' : '0';
  const ok = await writeSetting(key, value, { quiet: true });
  if (!ok) { btn.classList.toggle('on', !next); btn.setAttribute('aria-checked', String(!next)); return; }

  if (key === 'track_stock') {
    S.ctx.app.flags.stock = next;
    toast(next ? 'Stock tracking is on' : 'Stock tracking is off',
      next ? 'Stock levels, low-stock warnings and Stock History are back.' : 'Stock is still counted underneath, so you can switch this back on any time.',
      next ? 'ok' : 'info');
    S.ctx.refresh();
    return;
  }
  if (key === 'track_khata') {
    S.ctx.app.flags.khata = next;
    toast(next ? 'Credit ledger is on' : 'Credit ledger is off',
      next ? 'The Khata / Ledger screen and related dashboard cards are back.' : 'Every bill still records what was paid, so you can switch this back on any time.',
      next ? 'ok' : 'info');
    S.ctx.refresh();
    return;
  }
  if (key === 'auth_enabled') {
    toast(next ? 'Sign-in is on' : 'Sign-in is off',
      next ? 'Everyone who uses this app will now need their own account.' : 'Anyone who opens this computer can use the app.',
      next ? 'ok' : 'warn');
    renderSection();
    return;
  }
  toast('Saved', 'Your change has been saved.', 'ok');
}

/* ============================ wiring ============================ */
function wire() {
  const root = S.root;
  on(root, 'click', '[data-sec]', (e, b) => {
    S.active = b.dataset.sec;
    prefs.set('settingsTab', S.active);
    qa('[data-sec]', root).forEach(x => x.classList.toggle('on', x === b));
    renderSection();
  });
}

function wireSection() {
  const host = q('#secBody', S.root);
  if (!host) return;

  qa('[data-toggle]', host).forEach(btn => {
    btn.onclick = () => onToggle(btn.dataset.toggle, btn);
  });

  if (S.active === 'profile') {
    q('#saveProfile', host)?.addEventListener('click', saveProfile);
  } else if (S.active === 'billing') {
    q('#saveBilling', host)?.addEventListener('click', saveBilling);
  } else if (S.active === 'backup') {
    q('#backupNow', host)?.addEventListener('click', doBackupNow);
    q('#restoreBackup', host)?.addEventListener('click', doRestore);
    q('#exportInv', host)?.addEventListener('click', doExportInv);
    q('#importInv', host)?.addEventListener('click', doImportInv);
    q('#openDataFolder', host)?.addEventListener('click', doOpenDataFolder);
    const keepEl = q('#keepDays', host);
    if (keepEl) keepEl.addEventListener('change', () => saveKeepDays(keepEl));
  } else if (S.active === 'users') {
    q('#addUser', host)?.addEventListener('click', () => openUserModal(null));
    q('#viewAudit', host)?.addEventListener('click', openAuditLog);
    on(host, 'click', '[data-uact]', (e, b) => {
      const row = b.closest('[data-uid]');
      const u = S.users.find(x => x.id === +row.dataset.uid);
      if (!u) return;
      if (b.dataset.uact === 'edit') openUserModal(u);
      else if (b.dataset.uact === 'delete') deleteUser(u);
    });
  } else if (S.active === 'appearance') {
    host.querySelectorAll('[data-theme]').forEach(b => b.addEventListener('click', () => {
      setTheme(b.dataset.theme);
      renderSection();                            // repaint the cards' selected state
      toast('Appearance updated', b.dataset.theme === 'system'
        ? 'Vikray now follows your Windows light/dark setting.'
        : `Switched to the ${b.dataset.theme} theme.`, 'ok');
    }));
    q('#resetLayoutA', host)?.addEventListener('click', doResetLayout);
  } else if (S.active === 'about') {
    q('#openDataFolder2', host)?.addEventListener('click', doOpenDataFolder);
    q('#resetLayout', host)?.addEventListener('click', doResetLayout);
  }
}
