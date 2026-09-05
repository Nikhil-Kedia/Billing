/* ============================================================
   updates.js — Phase 3: the user-facing side of auto-update.

   Shared between the silent startup check (app.js) and the manual
   "Check for updates" button (views/settings.js), so there is exactly
   one modal / download / install flow to get right, not two that can
   drift apart.

   The actual checking, downloading and hash verification all happen in
   Python (app/updater.py via app/bridge.py) - this module only talks to
   that through api.* and renders what it's told.
   ============================================================ */

import { api } from './api.js';
import { modal, toast, esc } from './core.js';

function formatSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatLastChecked(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/** Shows or hides the quiet dot on the Settings nav item. */
export function setBadge(show) {
  document.getElementById('updDot')?.toggleAttribute('hidden', !show);
}

/** Runs once, a few seconds after the app window opens. Makes no network
 * call itself - it only asks the backend what its own background check
 * (throttled to once every 24h) already found. */
export async function notifyIfPending(app) {
  try {
    const status = await api.get_update_status();
    setBadge(!!status?.info);
    if (status?.info) maybeShow(status.info, app);
  } catch (e) {
    // Offline, or a first run before anything has been checked yet - quiet.
  }
}

/** The "Check for updates" button in Settings - always bypasses the
 * throttle and tells the user either way, unlike the silent startup check. */
export async function manualCheck(app) {
  try {
    const info = await api.check_for_updates(true);
    setBadge(!!info);
    if (info) {
      await openUpdateModal(info, app);
      return true;
    }
    toast('You are up to date', 'Vikray is already on the latest version.', 'ok');
    return false;
  } catch (e) {
    toast('Could not check for updates', e.message, 'bad');
    return false;
  }
}

function maybeShow(info, app) {
  // Never interrupt a bill in progress - the till is mid-sale far more
  // often than a shop wants a dialog stealing focus. Re-check shortly
  // instead of dropping the notice entirely.
  if (app.viewId === 'newbill') {
    setTimeout(() => { if (app.viewId !== 'newbill') maybeShow(info, app); }, 15000);
    return;
  }
  openUpdateModal(info, app);
}

export async function openUpdateModal(info, app) {
  const body = document.createElement('div');
  body.className = 'col gap3';
  body.innerHTML = `
    <div class="row gap3" style="align-items:baseline">
      <div class="h2">Vikray ${esc(info.version)}</div>
      <div class="small muted">${esc(formatSize(info.size))}</div>
    </div>
    <div class="small muted">A new version is available.</div>
    ${info.notes ? `<div class="small" style="white-space:pre-line">${esc(info.notes)}</div>` : ''}
    <div id="updProgWrap" hidden>
      <div style="height:8px;border-radius:5px;background:var(--line,#e5e5e5);overflow:hidden">
        <div id="updProgBar" style="height:100%;width:0%;background:var(--accent,#4a7dfc);transition:width .2s"></div>
      </div>
      <div id="updProgTxt" class="small muted" style="margin-top:6px"></div>
    </div>
  `;

  let started = false;
  const res = await modal({
    title: 'Update available',
    icon: 'sparkles',
    body,
    actions: [
      { label: 'Later', value: false },
      {
        label: 'Install and restart', cls: 'btn-primary', default: true,
        onClick: async () => {
          if (started) return false;   // ignore a double-click mid-download
          started = true;
          const ok = await runDownloadAndInstall(info, body);
          started = ok;                // on failure, allow retrying the same click
          return ok;
        },
      },
    ],
  });

  if (res !== true) {
    // "Later", Escape, or the X - quiet until the next scheduled check.
    try { await api.dismiss_update_notice(); } catch { /* best-effort */ }
    setBadge(true);   // it's still pending - keep the Settings dot visible
  }
}

async function runDownloadAndInstall(info, body) {
  const wrap = body.querySelector('#updProgWrap');
  const bar = body.querySelector('#updProgBar');
  const txt = body.querySelector('#updProgTxt');
  wrap.hidden = false;
  txt.textContent = 'Starting download…';

  try {
    await api.start_update_download();
  } catch (e) {
    toast('Could not start the download', e.message, 'bad');
    return false;
  }

  try {
    await new Promise((resolve, reject) => {
      const iv = setInterval(async () => {
        let p;
        try {
          p = await api.get_update_progress();
        } catch (e) {
          clearInterval(iv);
          reject(e);
          return;
        }
        const pct = p.total ? Math.min(100, Math.round((p.downloaded / p.total) * 100)) : 0;
        bar.style.width = pct + '%';
        if (p.error) {
          clearInterval(iv);
          reject(new Error(p.error));
        } else if (p.ready && !p.downloading) {
          txt.textContent = 'Verified. Installing…';
          clearInterval(iv);
          resolve();
        } else {
          txt.textContent = `Downloading… ${pct}%`;
        }
      }, 400);
    });
  } catch (e) {
    toast('The update could not be downloaded', e.message, 'bad');
    return false;
  }

  try {
    await api.install_update();
  } catch (e) {
    toast('Could not start the installer', e.message, 'bad');
    return false;
  }
  txt.textContent = 'Vikray will close and restart in a moment…';
  return true;
}
