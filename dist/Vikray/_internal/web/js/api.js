/* ============================================================
   api.js — the one door between the UI and Python.

   Every backend call is `api.something(...)` and returns a promise.
   Python raises -> we reject with a friendly Error, so views can
   just try/catch. In a plain browser (no pywebview) it falls back to
   mock.js, which is how the UI is developed and screenshot-tested.
   ============================================================ */

let backend = null;      // window.pywebview.api, or the mock
let isMock = false;

export const ready = new Promise((resolve) => {
  const done = () => {
    backend = window.pywebview.api;
    resolve({ mock: false });
  };
  if (window.pywebview?.api) return done();
  window.addEventListener('pywebviewready', done, { once: true });
  // No host after a moment => we're in a browser: use the mock.
  setTimeout(async () => {
    if (backend) return;
    const m = await import('./mock.js');
    backend = m.mockApi;
    isMock = true;
    document.documentElement.dataset.mock = '1';
    resolve({ mock: true });
  }, 350);
});

export const usingMock = () => isMock;

async function call(name, args) {
  if (!backend) await ready;
  const fn = backend[name];
  if (typeof fn !== 'function') throw new Error(`Backend has no method "${name}"`);
  let res;
  try {
    res = await fn(...args);
  } catch (e) {
    throw new Error(String(e?.message || e || 'The application could not complete that action.'));
  }
  // Python side wraps every reply as {ok, data} | {ok:false, error, kind}
  if (res && typeof res === 'object' && 'ok' in res && ('data' in res || 'error' in res)) {
    if (res.ok) return res.data;
    const err = new Error(res.error || 'Something went wrong.');
    err.kind = res.kind || 'error';
    err.title = res.title || null;
    throw err;
  }
  return res;
}

/** api.get_all_items('bisc')  ->  Python `get_all_items(search='bisc')` */
export const api = new Proxy({}, {
  get: (_t, name) => (...args) => call(name, args),
});

/* Python can push to the UI (toasts, refresh hints) via window.nova.push */
const listeners = new Map();
export function onPush(channel, fn) {
  if (!listeners.has(channel)) listeners.set(channel, new Set());
  listeners.get(channel).add(fn);
  return () => listeners.get(channel)?.delete(fn);
}
window.nova = window.nova || {};
window.nova.push = (channel, payload) => {
  listeners.get(channel)?.forEach(fn => { try { fn(payload); } catch (e) { console.error(e); } });
};
