# Nova view contract — read before writing any view

You are writing one screen of a Windows desktop billing app (Python backend + WebView2 UI).
The design system is already built. **Do not invent styles, colours, or components** — reuse what exists.

## Files you must read first
- `/home/claude/nova/web/css/tokens.css`, `components.css`, `views.css`, `panels.css` — every class you may use
- `/home/claude/nova/web/js/core.js` — helpers (read the exports)
- `/home/claude/nova/web/js/views/newbill.js` — **the reference view. Match its style, structure and level of polish.**
- `/home/claude/nova/web/js/mock.js` — the exact shape of every backend reply
- The behavioural spec for your screen in `/home/claude/spec/*.md` — this is the source of truth for
  *what the screen must do*. Preserve every rule, threshold, column, and message it documents.

## Module shape
```js
import { api } from '../api.js';
import { q, qa, el, node, on, esc, icon, inr, inrShort, qty, num, dmy, hm12,
         initials, toast, modal, confirm, menu, emptyState, debounce, prefs } from '../core.js';

export default {
  title: 'Bill History',
  async mount(root, ctx) { … },   // root is an empty <div class="view grow col">
  destroy() { … },                // optional; clear timers/listeners
};
```
`ctx` = `{ app, api, params, go(viewId, params), setTitle, setSub, setActions, refresh }`.
- `ctx.setActions([{label, icon, cls, iconOnly, title, onClick}])` puts buttons in the top bar.
  `cls` is one of `btn-primary`, `btn-grad`, `btn-ghost`, `btn-danger`, or omitted.
- `ctx.app.flags.stock` / `.khata` — feature toggles; hide stock or ledger UI when false.
- `ctx.app.settings` — store_name etc.

## Hard rules
1. **Colours only via CSS variables** (`var(--accent)`, `var(--bad-ink)`, …). Never a raw hex in JS or inline style.
2. **Money** → `inr(n)` (Indian grouping, "Rs. 1,23,456.00"). Compact → `inrShort(n)`. Quantities → `qty(n)`.
   Dates from the DB are `YYYY-MM-DD` strings → `dmy(iso)`. Times are `HH:MM` → `hm12(t)`.
3. **Every boundary between two boxes must be a split panel** (this is the headline feature of the rewrite):
   ```html
   <div class="split split-h grow" data-split="inventory.filters">
     <div class="pane pane-sized" data-size="300" data-min="220" data-max="560">…</div>
     <div class="pane pane-fill">…</div>
   </div>
   ```
   `data-split` must be globally unique (`viewname.purpose`). `split-h` = drag left/right,
   `split-v` = drag up/down. The splitter, drag, collapse, keyboard and persistence are automatic —
   just write the two panes. Nest splits for richer layouts. A screen with a list + detail, a
   filter rail + table, or a chart above a table **must** use one.
4. **Tables**: `.panel > .panel-head` + `.tbl-head` + scrolling `.tbl-body` of `.tr` rows.
   Every cell needs a width (`style="width:120px"`) or `class="grow"`; numeric cells get
   `class="num-cell mono"`. Rows get hover actions with `<div class="acts">`.
5. **Loading** → `.skel` blocks, not spinners, for content areas. **Empty** → `emptyState(icon, title, sub)`.
6. **Errors** → `toast(title, message, 'bad')`. Never leave a failure silent, never dump a stack trace.
7. Confirmations → `await confirm(title, message, {danger:true, ok:'Delete'})`.
8. Wording is plain and human — "No bills yet", not "No records found". Match the tone in newbill.js.
9. No external libraries, no CDN, no images. Icons via `icon(name, size)` — see the `P` map in core.js
   for the available names; if you need one that isn't there, add it to that map.
10. Charts are hand-drawn inline SVG (see the dashboard reference or build simple bars with `.bars > i`).
    They must re-render on `window.addEventListener('nova:resize', …)` since panels change size.

## Backend calls
All are `await api.method(args)` and throw on failure. Available (see mock.js for reply shapes):
`bootstrap, quick_search, dashboard(range), items_snapshot, customers_snapshot, customer_balance(id),
next_bill_number, stock_levels(ids), create_bill(payload), update_bill(payload), get_bills(search, from, to),
get_bill(id), delete_bill(id, restock), open_pdf(billId), print_bill(billId), send_whatsapp(billId, phone),
get_items(search), add_item(obj), update_item(id, obj), delete_item(id),
adjust_stock(id, delta, type, notes), inventory_transactions(search), clear_inventory_transactions(),
get_customers(search), add_customer(obj), update_customer(id, obj), delete_customer(id),
customers_with_dues(), customer_ledger(id), add_ledger_payment(id, amount, notes),
customer_kpis(id), customer_bills(id), customer_products(id), customer_product_history(id, name),
get_settings(), set_setting(key, value), backup_now(), restore_backup(), export_items(), import_items(),
list_users(), create_user(obj), update_user(id, obj), delete_user(id), audit_log(search),
data_dir(), open_folder(which), sign_out()`

If your screen needs a call that isn't listed, use it anyway with a sensible name and **list it in your
final answer** so the Python bridge can be extended.

## Quality bar
This app is meant to feel like it came from a large software company. That means: nothing jumps or
reflows after load, hover and focus states everywhere, keyboard support (Enter/Escape/arrows where it
makes sense), sensible tab order, numbers aligned, no text ever overlapping or spilling out of its box
(use `.ellipsis`), and transitions that are quick and purposeful rather than decorative.
