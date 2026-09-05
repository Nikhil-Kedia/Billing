/* ============================================================
   ac.js — one autocomplete, used by every field that needs one.
   Keyboard: ↑↓ move, Enter picks, Esc closes. Mouse: hover
   highlights, click picks. Only ever one list open at a time.
   ============================================================ */

import { el, qa, esc, mark } from './core.js';

let open = null;   // { box, input, rows, sel, pick }

export function closeAC() {
  if (!open) return;
  open.box.remove();
  open = null;
}
export const isOpen = (input) => !!open && (!input || open.input === input);

function place(box, input) {
  const r = input.getBoundingClientRect();
  const w = Math.max(r.width, 260);
  box.style.width = w + 'px';
  box.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 10)) + 'px';
  const h = box.offsetHeight;
  box.style.top = (r.bottom + h > innerHeight - 10 && r.top > h + 10)
    ? (r.top - h - 4) + 'px'
    : (r.bottom + 4) + 'px';
}

function highlight() {
  qa('.ac-item', open.box).forEach((n, i) => n.classList.toggle('on', i === open.sel));
  qa('.ac-item', open.box)[open.sel]?.scrollIntoView({ block: 'nearest' });
}

/**
 * show(input, rows, onPick, term)
 *   rows: [{ label, sub?, value }] — `value` is handed to onPick
 */
export function show(input, rows, onPick, term = '') {
  closeAC();
  if (!rows || !rows.length) return;

  const box = el('div', 'ac');
  box.innerHTML = rows.map((r, i) => `
    <button class="ac-item ${i === 0 ? 'on' : ''}" data-i="${i}" tabindex="-1">
      <span class="grow ellipsis">${mark(r.label, term)}</span>
      ${r.sub ? `<span class="sub ellipsis" style="max-width:46%;text-align:right">${esc(r.sub)}</span>` : ''}
    </button>`).join('');
  document.body.appendChild(box);
  place(box, input);
  open = { box, input, rows, sel: 0, pick: onPick };

  box.addEventListener('mousedown', (e) => e.preventDefault());  // never steal focus from the field
  box.addEventListener('click', (e) => {
    const b = e.target.closest('.ac-item');
    if (!b) return;
    const row = rows[+b.dataset.i];
    closeAC();
    onPick(row.value, row);
  });
  box.addEventListener('mousemove', (e) => {
    const b = e.target.closest('.ac-item');
    if (b && open) { open.sel = +b.dataset.i; highlight(); }
  });
}

/** Call from the field's keydown. Returns true if the list consumed the key. */
export function handleKey(e, input) {
  if (!open || open.input !== input) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    open.sel = e.key === 'ArrowDown'
      ? Math.min(open.sel + 1, open.rows.length - 1)
      : Math.max(open.sel - 1, 0);
    highlight();
    return true;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const { rows, sel, pick } = open;
    const row = rows[sel];
    closeAC();
    if (row) pick(row.value, row);
    return true;
  }
  if (e.key === 'Escape') { e.preventDefault(); closeAC(); return true; }
  return false;
}

addEventListener('scroll', () => closeAC(), true);
addEventListener('resize', () => closeAC());
