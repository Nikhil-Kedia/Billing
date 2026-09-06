/* ============================================================
   customer-edit.js — the one Add/Edit customer dialog, shared by
   every screen that shows a customer.

   WHY THIS IS ITS OWN MODULE

   The dialog used to live inside views/customers.js, reachable only
   from a hover-revealed pencil on a table row — so on Customer
   Insights (where you actually sit and look at one person) there was
   no way to fix a misspelt name or a wrong phone number at all, and
   on the Customers screen you had to know to hover. It is a plain
   function with an `onSaved` callback instead of a view method so
   that it never touches any one screen's module state: each caller
   refreshes itself its own way.

   Saving a rename also rewrites the name/phone/address stored on
   that customer's own bills - see bridge.update_customer.
   ============================================================ */

import { api } from './api.js';
import { q, node, esc, modal, toast } from './core.js';

function fieldRow(label, id, opts = {}) {
  return `<div class="field grow" style="${opts.style || ''}">
    <label class="label">${esc(label)}${opts.req ? '<span class="req">*</span>' : ''}</label>
    <input class="input" id="${id}" autocomplete="off" placeholder="${esc(opts.ph || '')}" value="${esc(opts.val ?? '')}">
    <div class="tiny" style="color:var(--bad-ink);min-height:14px" data-err="${id}"></div>
  </div>`;
}

function setErr(body, id, msg) {
  const input = q('#' + id, body), err = q(`[data-err="${id}"]`, body);
  if (input) input.classList.toggle('is-bad', !!msg);
  if (err) err.textContent = msg || '';
}

/** Opens the Add (cust = null) or Edit (cust = the customer) dialog.
    Resolves true when something was actually saved. `onSaved` runs
    first, so the calling screen can reload before the caller
    continues. */
export async function openCustomerModal(cust, { onSaved } = {}) {
  const isEdit = !!cust;
  const body = node(`<div class="col gap4">
    ${fieldRow('Customer name', 'f-name', { req: true, val: cust?.name || '' })}
    <div class="row gap3">
      ${fieldRow('Phone', 'f-phone', { val: cust?.phone || '', ph: '98530 21456' })}
      ${fieldRow('Address', 'f-addr', { val: cust?.address || '', ph: 'Town, district' })}
    </div>
    ${isEdit ? fieldRow('Notes', 'f-notes', { val: cust?.notes || '', ph: 'Optional' }) : ''}
    ${isEdit ? `<div class="tiny muted">Changing the name, phone or address also updates it on this
      customer's own bills, so their history and any reprinted bill stay in one name.</div>` : ''}
  </div>`);

  const res = await modal({
    title: isEdit ? `Edit customer: ${cust.name}` : 'Add customer',
    icon: isEdit ? 'pencil' : 'plus',
    body,
    actions: [
      { label: 'Cancel', value: false },
      {
        label: isEdit ? 'Save changes' : 'Add customer', cls: 'btn-primary', default: true,
        onClick: async () => {
          setErr(body, 'f-name', '');
          const name = q('#f-name', body).value.trim();
          if (!name) { setErr(body, 'f-name', 'Customer name is required.'); return false; }
          const data = {
            name,
            phone: q('#f-phone', body).value.trim(),
            address: q('#f-addr', body).value.trim(),
            ...(isEdit ? { notes: q('#f-notes', body).value.trim() } : {}),
          };
          try {
            if (isEdit) await api.update_customer(cust.id, data);
            else await api.add_customer(data);
            toast(isEdit ? 'Customer updated' : 'Customer added', `${name} was saved.`, 'ok');
          } catch (e) {
            toast(isEdit ? 'Could not save customer' : 'Could not add customer', e.message, 'bad');
            return false;
          }
          return true;
        },
      },
    ],
  });

  if (res && onSaved) await onSaved();
  return !!res;
}
