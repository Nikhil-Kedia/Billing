/* ============================================================
   panels.js — resizable / collapsible split panels.

   A view only writes two panes; this module inserts the live edge
   between them and handles drag, collapse, keyboard and persistence.

     <div class="split split-h" data-split="khata.list">
       <div class="pane pane-sized" data-size="320" data-min="220" data-max="560">…</div>
       <div class="pane pane-fill">…</div>
     </div>

   .split-h  drag left/right   |   .split-v  drag up/down
   The sized pane may be first or second — the splitter always goes
   between them and the maths follows whichever side is sized.

   Interactions: drag the edge · click the grip · double-click the
   edge · focus it and use arrow keys (Enter toggles).
   ============================================================ */

import { prefs, icon } from './core.js';

const GRIP = `<button class="grip" tabindex="-1" aria-label="Collapse or expand panel">${icon('grip', 11)}</button>`;

// Every splitter currently mid-drag registers its own `endDrag` here for
// the lifetime of that one drag (added on pointerdown, removed as soon as
// the drag ends, from whichever path ends it). Kept as a module-level set
// with a SINGLE set of window listeners below - not one window listener
// per splitter - specifically so that a router that mounts and tears down
// dozens of splits over a session never accumulates dangling listeners of
// its own; see cancelAllDrags() and the wiring in setup() for why this
// needs to survive the splitter element itself being removed from the DOM.
const activeDrags = new Set();

/** Force-ends every drag in progress, if any. app.js's router calls this
    before it wipes out the current view's DOM (go(), on every navigation),
    which is the one gap per-splitter pointerup/pointercancel/
    lostpointercapture listeners cannot close on their own: the mouse
    button can still be down, with no release event having fired yet at
    all, at the exact moment the splitter is removed. Left unhandled, that
    leaves `dragging` stuck true in a now-orphaned closure and, more
    visibly, document.body stuck with 'is-dragging'/'drag-x'/'drag-y'
    (wrong cursor everywhere, text selection dead app-wide) with nothing
    left alive to ever clear them again short of a full reload. */
export function cancelAllDrags() {
  [...activeDrags].forEach(end => end());
}

let windowListenersArmed = false;
function armWindowFallback() {
  if (windowListenersArmed) return;
  windowListenersArmed = true;
  // Fallback net for a real release that DOES happen, but not necessarily
  // over the splitter (or with the splitter still there to hear it) -
  // pointer capture normally redirects these back to the splitter, but a
  // browser/OS edge case (capture lost without a matching pointerup) is
  // exactly what the per-splitter 'lostpointercapture' handler and this
  // are both insurance against, from two different angles.
  window.addEventListener('pointerup', () => cancelAllDrags());
  window.addEventListener('pointercancel', () => cancelAllDrags());
}

function sizeOf(pane, horiz) {
  const r = pane.getBoundingClientRect();
  return horiz ? r.width : r.height;
}

function apply(pane, px) { pane.style.setProperty('--basis', Math.round(px) + 'px'); }

/** Wire every split inside `root` that hasn't been wired yet. */
export function init(root = document) {
  root.querySelectorAll('.split[data-split]').forEach(setup);
}

function setup(split) {
  if (split._wired) return;
  split._wired = true;

  const horiz = split.classList.contains('split-h');
  const panes = [...split.children].filter(c => c.classList.contains('pane'));
  if (panes.length < 2) return;

  const sized = panes.find(p => p.classList.contains('pane-sized')) || panes[0];
  const sizedFirst = panes.indexOf(sized) === 0;

  const id = split.dataset.split;
  const min = +(sized.dataset.min || 160);
  const max = +(sized.dataset.max || 900);
  const base = +(sized.dataset.size || 300);

  // restore
  // data-collapsed="1" means "start out of the way" — for panels that are
  // useful on demand (a detail pane) but shouldn't cost the main table its
  // width before anyone asks for them. A remembered choice always wins.
  const startCollapsed = sized.dataset.collapsed === '1';
  const saved = prefs.get('panel.' + id, null);
  apply(sized, saved?.size ?? base);
  let lastOpen = saved?.size ?? base;
  if (saved ? saved.collapsed : startCollapsed) sized.classList.add('is-collapsed');

  // insert the live edge between the two panes
  const sp = document.createElement('div');
  sp.className = 'splitter';
  sp.tabIndex = 0;
  sp.setAttribute('role', 'separator');
  sp.setAttribute('aria-orientation', horiz ? 'vertical' : 'horizontal');
  sp.title = 'Drag to resize · double-click to collapse';
  sp.innerHTML = GRIP;
  split.insertBefore(sp, sizedFirst ? panes[1] : sized);
  if (saved ? saved.collapsed : startCollapsed) sp.classList.add('is-parked');

  const save = () => prefs.set('panel.' + id, {
    size: lastOpen, collapsed: sized.classList.contains('is-collapsed'),
  });

  const setCollapsed = (yes) => {
    if (yes) {
      lastOpen = Math.max(min, sizeOf(sized, horiz)) || lastOpen;
      sized.classList.add('is-collapsed');
      sp.classList.add('is-parked');
    } else {
      sized.classList.remove('is-collapsed');
      sp.classList.remove('is-parked');
      apply(sized, lastOpen);
    }
    save();
    // let flex settle, then tell charts/tables to remeasure
    setTimeout(() => window.dispatchEvent(new Event('nova:resize')), 340);
  };
  const toggle = () => setCollapsed(!sized.classList.contains('is-collapsed'));

  /* ---- drag ----
     Every way a drag can end funnels through endDrag(): the obvious
     pointerup/pointercancel on the splitter itself, plus
     'lostpointercapture' (the one event the spec guarantees on every
     implicit capture release - element removed, disabled, etc - that
     plain pointerup/pointercancel are not guaranteed to follow) and
     cancelAllDrags() up top (registered in `activeDrags` for exactly the
     duration of this one drag; called by app.js's router before it tears
     the current view down, and by the module-level window fallback).
     Without this, a splitter that stops existing mid-drag - its view
     replaced under it - leaves `dragging` stuck true in an orphaned
     closure and document.body stuck with 'is-dragging'/'drag-x'/
     'drag-y' (wrong cursor everywhere, text selection dead app-wide)
     with nothing left alive to ever clear them. */
  let dragging = false, startPos = 0, startSize = 0, pointerId = null;

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    activeDrags.delete(endDrag);
    try { sp.releasePointerCapture(pointerId); } catch {}
    pointerId = null;
    sp.classList.remove('is-active');
    document.body.classList.remove('is-dragging', 'drag-x', 'drag-y');
    // e is absent when this runs as a forced cleanup (route change,
    // lostpointercapture, the window fallback) rather than a real
    // release at a known position - in that case just keep whatever
    // size was last applied rather than guessing a collapse.
    if (!e) { save(); return; }
    const now = sizeOf(sized, horiz);
    // Dragged (nearly) shut? Treat that as "collapse" so it parks cleanly.
    if (now <= min + 6) { setCollapsed(true); }
    else { lastOpen = now; save(); }
    window.dispatchEvent(new Event('nova:resize'));
  };

  sp.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.grip')) return;         // the grip is a click target, not a drag handle
    dragging = true;
    pointerId = e.pointerId;
    activeDrags.add(endDrag);
    armWindowFallback();
    sp.setPointerCapture(e.pointerId);
    sp.classList.add('is-active');
    document.body.classList.add('is-dragging', horiz ? 'drag-x' : 'drag-y');
    if (sized.classList.contains('is-collapsed')) {
      sized.classList.remove('is-collapsed');
      sp.classList.remove('is-parked');
      apply(sized, min);
    }
    startPos = horiz ? e.clientX : e.clientY;
    startSize = sizeOf(sized, horiz);
    e.preventDefault();
  });

  sp.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const delta = (horiz ? e.clientX : e.clientY) - startPos;
    const want = startSize + (sizedFirst ? delta : -delta);
    apply(sized, Math.max(min, Math.min(max, want)));
  });

  sp.addEventListener('pointerup', endDrag);
  sp.addEventListener('pointercancel', endDrag);
  sp.addEventListener('lostpointercapture', () => endDrag(null));

  /* ---- click grip / double-click edge ---- */
  sp.querySelector('.grip').addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  sp.addEventListener('dblclick', toggle);

  /* ---- keyboard ---- */
  sp.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 48 : 16;
    const grow = horiz ? 'ArrowRight' : 'ArrowDown';
    const shrink = horiz ? 'ArrowLeft' : 'ArrowUp';
    if (e.key === grow || e.key === shrink) {
      e.preventDefault();
      if (sized.classList.contains('is-collapsed')) setCollapsed(false);
      const dir = (e.key === grow ? 1 : -1) * (sizedFirst ? 1 : -1);
      const next = Math.max(min, Math.min(max, sizeOf(sized, horiz) + dir * step));
      apply(sized, next); lastOpen = next; save();
      window.dispatchEvent(new Event('nova:resize'));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); toggle();
    }
  });

  split._panel = { toggle, setCollapsed, isCollapsed: () => sized.classList.contains('is-collapsed') };
}

/** Programmatic access, e.g. a toolbar button that hides a side list. */
export const get = (id) => document.querySelector(`.split[data-split="${id}"]`)?._panel || null;

/** Reset every remembered panel size (used by Settings → Restore layout). */
export function resetAll() {
  Object.keys(localStorage)
    .filter(k => k.startsWith('nova.panel.'))
    .forEach(k => localStorage.removeItem(k));
}
