/* ============================================================
   views/attendance.js — Employee attendance & payroll.

   Owner-only end to end: the nav item only appears when
   app.can.manage_attendance is true (see app.js's NAV), and every
   api call here is re-checked server-side by security.py regardless.

   Four tabs behind one left rail, mirroring settings.js's layout:
     Attendance  — a calendar grid, one row per employee, click or
                   drag across a row to paint the same status onto
                   several days at once (present/half/absent/leave).
     Employees   — add/edit staff, their pay type and rate.
     Advances    — cash given against salary, deducted at payroll time.
     Payroll     — one month's computed pay per employee, finalize it,
                   then mark it paid; a running history underneath.
   ============================================================ */

import { api } from '../api.js';
import {
  q, qa, node, on, esc, icon, inr, num, toast, modal, confirm, emptyState, prefs,
} from '../core.js';

const TABS = [
  { id: 'grid',      label: 'Attendance', icon: 'calendar' },
  { id: 'employees', label: 'Employees',  icon: 'users' },
  { id: 'advances',  label: 'Advances',   icon: 'rupee' },
  { id: 'payroll',   label: 'Payroll',    icon: 'card' },
];

/* A day is two halves - morning and evening - each marked on its own.
   "Half day" is therefore no longer something you pick: it is what a day
   IS when its two halves differ, which is why it appears in the totals
   and the legend but not in the cycle. */
const STATUS_CYCLE = [null, 'present', 'absent', 'leave'];
const STATUS_DEF = {
  present: { letter: 'P', bg: 'var(--ok-soft)',   ink: 'var(--ok-ink)',   title: 'Present' },
  absent:  { letter: 'A', bg: 'var(--bad-soft)',  ink: 'var(--bad-ink)',  title: 'Absent' },
  leave:   { letter: 'L', bg: 'var(--info-soft)', ink: 'var(--info-ink)', title: 'On leave' },
};
const SESSION_LABEL = { am: 'Morning', pm: 'Evening' };
const PAY_TYPE_LABEL = { monthly: 'Fixed monthly', daily: 'Daily wage', shift: 'Per shift' };

let S = null;

export default {
  title: 'Attendance',

  async mount(root, ctx) {
    S = {
      ctx, root,
      active: prefs.get('attendanceTab', 'grid'),
      month: todayMonth(),
      employees: [],
      grid: {},
      advances: [],
      payrollPreviews: [],
      payrollHistory: [],
      drag: null,
      loading: true,
    };
    if (!TABS.some(t => t.id === S.active)) S.active = 'grid';

    paint(root);
    wire();
    await reload();
  },

  destroy() {
    if (S?._mouseup) document.removeEventListener('mouseup', S._mouseup);
    S = null;
  },
};

/* ============================ date helpers ============================ */
function todayMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function todayISO() {
  const d = new Date();
  return `${todayMonth()}-${String(d.getDate()).padStart(2, '0')}`;
}

function monthLabel(m) {
  const [y, mo] = m.split('-');
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  return `${names[+mo - 1]} ${y}`;
}

function shiftMonth(m, delta) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function daysInMonth(m) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo, 0).getDate();
}

function dateOf(m, day) { return `${m}-${String(day).padStart(2, '0')}`; }

const WEEKDAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
function weekdayOf(m, day) {
  const [y, mo] = m.split('-').map(Number);
  return WEEKDAY_LETTER[new Date(y, mo - 1, day).getDay()];
}

/* ============================ layout ============================ */
function paint(root) {
  root.innerHTML = `
  <div class="split split-h grow" data-split="attendance.rail" style="padding:var(--s4) var(--s5) var(--s5)">
    <div class="pane pane-sized" data-size="200" data-min="170" data-max="280">
      <div class="panel grow">
        <div class="panel-head"><div class="h2 grow">Attendance</div></div>
        <div class="grow scroll-y" style="padding:10px">
          <div class="set-tabs" id="atTabs">
            ${TABS.map(t => `<button class="set-tab ${t.id === S.active ? 'on' : ''}" data-tab="${t.id}">
              ${icon(t.icon, 16)}<span class="grow ellipsis">${esc(t.label)}</span></button>`).join('')}
          </div>
        </div>
      </div>
    </div>
    <div class="pane pane-fill" style="padding-left:6px">
      <div class="panel grow">
        <div id="secBody" class="col grow" style="min-height:0"></div>
      </div>
    </div>
  </div>`;

  S.el = { body: q('#secBody', root) };
}

/* Every listener on this screen is delegated from S.root and attached
   ONCE, here. It used to be re-attached at the end of every render, and
   core.js's on() has no removal path, so handlers stacked up: three
   visits to Payroll meant one click on Finalize firing three confirms
   and three finalize calls. That is the "glitches" half of the bug
   report. Anything added below must stay in this function. */
function wire() {
  on(S.root, 'click', '[data-tab]', (e, b) => {
    S.active = b.dataset.tab;
    prefs.set('attendanceTab', S.active);
    qa('[data-tab]', S.root).forEach(x => x.classList.toggle('on', x === b));
    // Fetch, don't just re-render. Each tab used to draw whatever was in
    // memory from when the screen was first opened, so attendance marked
    // a moment earlier simply wasn't in the numbers Payroll showed - and
    // the Attendance grid could come up blank and then overwrite real
    // marks when clicked.
    loadAndRender();
  });

  on(S.root, 'click', '[data-mnav]', (e, b) => {
    S.month = shiftMonth(S.month, +b.dataset.mnav);
    loadAndRender();
  });

  /* ---- attendance grid ---- */
  on(S.root, 'mousedown', '.at-half', (e, halfEl) => {
    e.preventDefault();
    const { emp, date, session } = halfEl.dataset;
    const empId = +emp;
    const cur = S.grid[empId]?.[date]?.[session] || null;
    const next = cycleStatus(cur);
    paintHalf(empId, date, session, next);
    S.drag = { empId, session, status: next };
  });
  on(S.root, 'mouseover', '.at-half', (e, halfEl) => {
    if (!S.drag) return;
    const { emp, date, session } = halfEl.dataset;
    // A drag paints one employee's one half-of-day across the month -
    // never the other session, and never someone else's row.
    if (+emp !== S.drag.empId || session !== S.drag.session) return;
    paintHalf(+emp, date, session, S.drag.status);
  });
  // Marking a whole day at once, without four clicks: the day number.
  on(S.root, 'click', '.at-day-all', (e, b) => {
    const empId = +b.dataset.emp, date = b.dataset.date;
    const rec = S.grid[empId]?.[date];
    const cur = (rec && rec.am === rec.pm) ? rec.am : null;
    const next = cycleStatus(cur);
    paintHalf(empId, date, 'am', next, { silent: true });
    paintHalf(empId, date, 'pm', next, { silent: true });
    api.mark_attendance(empId, date, next || 'clear')
      .catch(err => toast('Could not save', err.message, 'bad'));
  });

  /* ---- employees ---- */
  on(S.root, 'click', '#addEmployee', () => openEmployeeModal(null));
  on(S.root, 'click', '[data-eact]', async (e, b) => {
    const emp = S.employees.find(x => x.id === +b.dataset.eid);
    if (!emp) return;
    if (b.dataset.eact === 'edit') return openEmployeeModal(emp);
    const yes = await confirm(emp.active ? 'Deactivate this employee?' : 'Reactivate this employee?',
      emp.active ? `${emp.name} will drop off the attendance grid and payroll. Their history is kept.`
                 : `${emp.name} will reappear on the attendance grid and payroll.`);
    if (!yes) return;
    try { await api.set_employee_active(emp.id, !emp.active); await reload(); }
    catch (err) { toast('Could not update', err.message, 'bad'); }
  });

  /* ---- advances ---- */
  on(S.root, 'click', '#addAdvance', openAdvanceModal);
  on(S.root, 'click', '[data-adel]', async (e, b) => {
    const yes = await confirm('Delete this advance?', 'This cannot be undone.', { danger: true, ok: 'Delete' });
    if (!yes) return;
    try { await api.delete_advance(+b.dataset.adel); await loadAndRender(); }
    catch (err) { toast('Could not delete', err.message, 'bad'); }
  });

  /* ---- payroll ---- */
  on(S.root, 'click', '[data-finalize]', async (e, b) => {
    const empId = +b.dataset.finalize;
    const emp = S.employees.find(x => x.id === empId);
    const already = S.payrollHistory.find(r => r.employee_id === empId && r.period_month === S.month);
    const yes = await confirm(already ? 'Re-finalize this month?' : 'Finalize payroll?',
      `${already ? 'This replaces the saved figures for ' : 'This locks in '}`
      + `${emp?.name || 'this employee'}'s pay for ${monthLabel(S.month)} with the attendance as it `
      + `stands now, and settles their pending advances against it. You can still mark it paid afterwards.`);
    if (!yes) return;
    try { await api.finalize_payroll(empId, S.month); toast('Payroll finalized', '', 'ok'); await loadAndRender(); }
    catch (err) { toast('Could not finalize', err.message, 'bad'); }
  });
  on(S.root, 'click', '[data-payid]', async (e, b) => {
    try { await api.mark_payroll_paid(+b.dataset.payid); await loadAndRender(); }
    catch (err) { toast('Could not update', err.message, 'bad'); }
  });

  S._mouseup = () => { S.drag = null; };
  document.addEventListener('mouseup', S._mouseup);
}

async function reload() {
  S.loading = true;
  renderSection();
  try {
    S.employees = await api.employees_list(true);
    await loadTabData();
  } catch (e) {
    S.el.body.innerHTML = emptyState('warn', 'Could not load attendance', e.message || 'Please try again.');
    S.loading = false;
    return;
  }
  S.loading = false;
  renderSection();
}

async function loadTabData() {
  if (S.active === 'grid') {
    S.grid = await api.attendance_month(S.month);
  } else if (S.active === 'advances') {
    S.advances = await api.list_advances();
  } else if (S.active === 'payroll') {
    const active = S.employees.filter(e => e.active);
    // Both are computed fresh from the attendance as it stands right
    // now. History is asked for THIS month only - it used to be every
    // month ever, sitting directly under a month navigator that did not
    // change it.
    S.payrollPreviews = await Promise.all(active.map(e => api.payroll_preview(e.id, S.month)));
    S.payrollHistory = await api.payroll_runs(S.month);
  }
}

function renderSection() {
  const host = S.el.body;
  if (S.loading) { host.innerHTML = `<div class="col grow center" style="padding:40px"><div class="skel" style="width:220px;height:20px"></div></div>`; return; }
  const fn = { grid: sectionGrid, employees: sectionEmployees, advances: sectionAdvances, payroll: sectionPayroll }[S.active];
  host.innerHTML = fn ? fn() : '';
}

/* ============================ Attendance grid ============================ */
function monthNavHTML() {
  return `
    <div class="row gap2" style="align-items:center">
      <button class="btn btn-ghost btn-icon btn-sm" data-mnav="-1" title="Previous month">${icon('chevLeft', 15)}</button>
      <div class="h2" style="min-width:150px;text-align:center">${esc(monthLabel(S.month))}</div>
      <button class="btn btn-ghost btn-icon btn-sm" data-mnav="1" title="Next month" ${S.month >= todayMonth() ? 'disabled' : ''}>${icon('chevRight', 15)}</button>
    </div>`;
}

function sectionGrid() {
  const active = S.employees.filter(e => e.active);
  if (!active.length) {
    return `<div class="panel-head">${monthNavHTML()}</div>
      ${emptyState('users', 'No employees yet', 'Add someone on the Employees tab first.')}`;
  }
  const nDays = daysInMonth(S.month);
  const days = Array.from({ length: nDays }, (_, i) => i + 1);
  const today = todayMonth() === S.month ? new Date().getDate() : null;

  const headCells = days.map(d => `<div class="at-head ${weekdayOf(S.month, d) === 'S' ? 'is-weekend' : ''} ${d === today ? 'is-today' : ''}">
      <div class="tiny muted">${weekdayOf(S.month, d)}</div><div class="small">${d}</div>
    </div>`).join('');

  const rows = active.map(emp => {
    const rec = S.grid[emp.id] || {};
    const t = rowTotals(rec, S.month);
    const cells = days.map(d => {
      const date = dateOf(S.month, d);
      const day = rec[date] || {};
      return `<div class="at-cell ${d === today ? 'is-today' : ''}">
        ${['am', 'pm'].map(sn => {
          const st = day[sn] || null;
          const def = st ? STATUS_DEF[st] : null;
          return `<button class="at-half" data-emp="${emp.id}" data-date="${date}" data-session="${sn}"
            title="${SESSION_LABEL[sn]} ${d} — ${def ? def.title : 'not marked'}"
            style="${def ? `background:${def.bg};color:${def.ink}` : ''}">${def ? def.letter : ''}</button>`;
        }).join('')}
        <button class="at-day-all" data-emp="${emp.id}" data-date="${date}"
          title="Mark the whole day"></button>
      </div>`;
    }).join('');
    return `<div class="at-row">
      <div class="at-name ellipsis" title="${esc(emp.name)}">${esc(emp.name)}</div>
      <div class="at-cells">${cells}</div>
      <div class="at-totals tiny muted mono" data-tot="${emp.id}">${totalsText(t)}</div>
    </div>`;
  }).join('');

  return `
    <div class="panel-head row between">
      ${monthNavHTML()}
      <div class="row gap3">
        ${Object.entries(STATUS_DEF).map(([k, d]) => `<span class="tiny" style="display:inline-flex;align-items:center;gap:4px">
          <i style="width:14px;height:14px;border-radius:4px;display:inline-block;background:${d.bg};color:${d.ink};text-align:center;line-height:14px;font-size:10px;font-weight:700">${d.letter}</i>${d.title}</span>`).join('')}
        <span class="tiny muted">· a day with one half worked counts as half</span>
      </div>
    </div>
    <div class="tiny muted" style="padding:0 16px 8px">
      Each day is split: the <b>top</b> half is the morning, the <b>bottom</b> half the evening.
      Click either to cycle Present → Absent → Leave → blank, or click the thin strip between
      them to set the whole day. Drag sideways to fill the same half across several days.
    </div>
    <div class="grow" style="padding:0 16px 16px;overflow:auto;overscroll-behavior:contain">
      <div class="at-grid" id="atGrid" style="--days:${nDays}">
        <div class="at-row at-row-head">
          <div class="at-name"></div>
          <div class="at-cells">${headCells}</div>
          <div class="at-totals"></div>
        </div>
        ${rows}
      </div>
    </div>`;
}

/** Days, counted in halves: a morning worked is half a present day. Kept
    on this side too so the row totals move the instant a half is
    clicked, without waiting for a round trip. */
function rowTotals(rec, month) {
  let present = 0, absent = 0, leave = 0, mixed = 0;
  for (const date of Object.keys(rec)) {
    if (!date.startsWith(month)) continue;
    const { am = null, pm = null } = rec[date] || {};
    for (const s of [am, pm]) {
      if (s === 'present') present += 0.5;
      else if (s === 'absent') absent += 0.5;
      else if (s === 'leave') leave += 0.5;
    }
    if (am !== pm) mixed += 1;
  }
  return { present, absent, leave, mixed };
}

const fmtDays = (n) => (Math.round(n * 2) / 2).toString();

function totalsText(t) {
  return `P ${fmtDays(t.present)} · A ${fmtDays(t.absent)} · L ${fmtDays(t.leave)}`
       + (t.mixed ? ` · ${t.mixed} half-day${t.mixed === 1 ? '' : 's'}` : '');
}

function cycleStatus(cur) {
  const i = STATUS_CYCLE.indexOf(cur);
  return STATUS_CYCLE[(i + 1) % STATUS_CYCLE.length];
}

/** Marks one half of one day: repaints it immediately, updates that
    employee's running totals, and saves. The payroll figures are not
    touched here - they are recomputed from the database whenever the
    Payroll tab is opened, which is the only way they can be trusted. */
function paintHalf(empId, date, session, status, { silent = false } = {}) {
  const rec = (S.grid[empId] = S.grid[empId] || {});
  const day = (rec[date] = rec[date] || { am: null, pm: null });
  day[session] = status;
  if (!day.am && !day.pm) delete rec[date];

  const el = q(`.at-half[data-emp="${empId}"][data-date="${date}"][data-session="${session}"]`, S.root);
  if (el) {
    const def = status ? STATUS_DEF[status] : null;
    el.textContent = def ? def.letter : '';
    el.style.background = def ? def.bg : '';
    el.style.color = def ? def.ink : '';
    el.title = `${SESSION_LABEL[session]} ${date.slice(8)} — ${def ? def.title : 'not marked'}`;
  }
  const tot = q(`[data-tot="${empId}"]`, S.root);
  if (tot) tot.textContent = totalsText(rowTotals(rec, S.month));

  if (silent) return;                      // the whole-day click saves once, for both halves
  api.mark_attendance_session(empId, date, session, status || 'clear')
    .catch(e => toast('Could not save', e.message, 'bad'));
}

async function loadAndRender() {
  S.loading = true; renderSection();
  await loadTabData();
  S.loading = false; renderSection();
}

/* ============================ Employees ============================ */
function sectionEmployees() {
  const rows = S.employees.map(e => `
    <div class="row between" style="padding:11px 16px;border-bottom:1px solid var(--line-soft)" data-emp-row="${e.id}">
      <div class="col" style="min-width:0">
        <div class="row gap2" style="align-items:center">
          <span class="ellipsis" style="font-weight:600">${esc(e.name)}</span>
          ${!e.active ? '<span class="pill">Inactive</span>' : ''}
        </div>
        <div class="tiny muted">${esc(e.role || 'No role set')}${e.phone ? ' · ' + esc(e.phone) : ''}</div>
      </div>
      <div class="row gap3" style="align-items:center;flex:none">
        <div class="tiny muted mono" style="text-align:right">${esc(PAY_TYPE_LABEL[e.pay_type] || e.pay_type)}<br>${inr(e.pay_rate)}${e.pay_type === 'shift' ? '/shift' : e.pay_type === 'daily' ? '/day' : '/month'}</div>
        <button class="btn btn-ghost btn-sm" data-eact="edit" data-eid="${e.id}">${icon('pencil', 14)}Edit</button>
        <button class="btn btn-ghost btn-sm" data-eact="toggle" data-eid="${e.id}">${e.active ? icon('x', 14) + 'Deactivate' : icon('refresh', 14) + 'Reactivate'}</button>
      </div>
    </div>`).join('');

  return `
    <div class="panel-head"><div class="h2 grow">Employees</div>
      <button class="btn btn-primary btn-sm" id="addEmployee">${icon('plus', 14)}Add employee</button>
    </div>
    <div class="grow scroll-y">
      ${S.employees.length ? rows : emptyState('users', 'No employees yet', 'Add your first staff member to start marking attendance.')}
    </div>`;
}

function readEmployeeForm(body) {
  const val = (id) => (q('#' + id, body)?.value ?? '').trim();
  const name = val('e-name');
  if (!name) { toast('Name is required', 'Enter the employee’s name.', 'warn'); return null; }
  const rate = num(val('e-rate'), NaN);
  if (!isFinite(rate) || rate < 0) { toast('Check the pay rate', 'Enter a valid amount of 0 or more.', 'warn'); return null; }
  return {
    name, phone: val('e-phone'), role: val('e-role'),
    pay_type: val('e-paytype') || 'monthly',
    pay_rate: +rate.toFixed(2),
    joined_date: val('e-joined') || undefined,
    notes: val('e-notes'),
  };
}

async function openEmployeeModal(emp) {
  const isEdit = !!emp;
  const body = node(`<div class="col gap4">
    <div class="row gap3">
      <div class="field grow"><label class="label">Name<span class="req">*</span></label>
        <input class="input" id="e-name" value="${esc(emp?.name || '')}"></div>
      <div class="field" style="width:160px"><label class="label">Phone</label>
        <input class="input mono" id="e-phone" value="${esc(emp?.phone || '')}"></div>
    </div>
    <div class="row gap3">
      <div class="field grow"><label class="label">Role</label>
        <input class="input" id="e-role" placeholder="e.g. Cashier" value="${esc(emp?.role || '')}"></div>
      <div class="field" style="width:160px"><label class="label">Joined</label>
        <input class="input mono" id="e-joined" placeholder="YYYY-MM-DD" value="${esc(emp?.joined_date || '')}"></div>
    </div>
    <div class="divider"></div>
    <div class="row gap3">
      <div class="field"><label class="label">Pay type</label>
        <select class="input" id="e-paytype">
          <option value="monthly" ${emp?.pay_type === 'monthly' || !emp ? 'selected' : ''}>Fixed monthly salary</option>
          <option value="daily" ${emp?.pay_type === 'daily' ? 'selected' : ''}>Daily wage</option>
          <option value="shift" ${emp?.pay_type === 'shift' ? 'selected' : ''}>Per shift</option>
        </select>
      </div>
      <div class="field grow"><label class="label">Rate (Rs.)<span class="req">*</span></label>
        <input class="input" id="e-rate" inputmode="decimal" value="${emp ? String(emp.pay_rate) : '0'}"></div>
    </div>
    <div class="tiny muted" style="margin-top:-10px">Monthly pay is pro-rated by attendance across the days in each month. Daily and per-shift pay are multiplied by days or shifts worked.</div>
    <div class="field"><label class="label">Notes</label>
      <textarea class="input" id="e-notes" rows="2">${esc(emp?.notes || '')}</textarea></div>
  </div>`);

  const res = await modal({
    title: isEdit ? `Edit employee: ${emp.name}` : 'Add employee',
    icon: isEdit ? 'pencil' : 'plus', wide: 'modal-wide', body,
    actions: [
      { label: 'Cancel', value: false },
      {
        label: isEdit ? 'Save changes' : 'Add employee', cls: 'btn-primary', default: true,
        onClick: async () => {
          const data = readEmployeeForm(body);
          if (!data) return false;
          try {
            if (isEdit) await api.update_employee(emp.id, data);
            else await api.add_employee(data);
            toast(isEdit ? 'Employee updated' : 'Employee added', `${data.name} was saved.`, 'ok');
          } catch (e) { toast('Could not save', e.message, 'bad'); return false; }
          return true;
        },
      },
    ],
  });
  if (res) await reload();
}

/* ============================ Advances ============================ */
function sectionAdvances() {
  const empById = new Map(S.employees.map(e => [e.id, e]));
  const rows = S.advances.map(a => `
    <div class="row between" style="padding:10px 16px;border-bottom:1px solid var(--line-soft)">
      <div class="col" style="min-width:0">
        <div class="ellipsis">${esc(empById.get(a.employee_id)?.name || 'Unknown')}</div>
        <div class="tiny muted">${esc(a.date)}${a.notes ? ' · ' + esc(a.notes) : ''}</div>
      </div>
      <div class="row gap3" style="align-items:center;flex:none">
        <span class="mono">${inr(a.amount)}</span>
        <span class="pill ${a.settled ? '' : 'pill-warn'}">${a.settled ? 'Settled' : 'Unsettled'}</span>
        ${!a.settled ? `<button class="btn btn-ghost btn-icon btn-sm" data-adel="${a.id}" title="Delete">${icon('x', 14)}</button>` : ''}
      </div>
    </div>`).join('');

  return `
    <div class="panel-head"><div class="h2 grow">Advances</div>
      <button class="btn btn-primary btn-sm" id="addAdvance" ${!S.employees.length ? 'disabled' : ''}>${icon('plus', 14)}Add advance</button>
    </div>
    <div class="tiny muted" style="padding:0 16px 8px">An unsettled advance is automatically deducted the next time that employee's payroll is finalized.</div>
    <div class="grow scroll-y">
      ${S.advances.length ? rows : emptyState('rupee', 'No advances recorded', 'Advances given against salary will appear here.')}
    </div>`;
}

async function openAdvanceModal() {
  const body = node(`<div class="col gap4">
    <div class="field"><label class="label">Employee<span class="req">*</span></label>
      <select class="input" id="a-emp">
        ${S.employees.filter(e => e.active).map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}
      </select></div>
    <div class="row gap3">
      <div class="field"><label class="label">Date</label>
        <input class="input mono" id="a-date" value="${todayISO()}"></div>
      <div class="field grow"><label class="label">Amount (Rs.)<span class="req">*</span></label>
        <input class="input" id="a-amount" inputmode="decimal" placeholder="0.00"></div>
    </div>
    <div class="field"><label class="label">Notes</label>
      <input class="input" id="a-notes" placeholder="Optional"></div>
  </div>`);

  const res = await modal({
    title: 'Add advance', icon: 'plus', body,
    actions: [
      { label: 'Cancel', value: false },
      {
        label: 'Add advance', cls: 'btn-primary', default: true,
        onClick: async () => {
          const empId = +q('#a-emp', body).value;
          const date = q('#a-date', body).value.trim();
          const amount = num(q('#a-amount', body).value, NaN);
          if (!isFinite(amount) || amount <= 0) { toast('Check the amount', 'Enter an amount greater than 0.', 'warn'); return false; }
          try {
            await api.add_advance(empId, date, +amount.toFixed(2), q('#a-notes', body).value.trim());
            toast('Advance recorded', '', 'ok');
          } catch (e) { toast('Could not save', e.message, 'bad'); return false; }
          return true;
        },
      },
    ],
  });
  if (res) await loadAndRender();
}

/* ============================ Payroll ============================ */
function sectionPayroll() {
  const savedFor = new Map(S.payrollHistory.map(r => [r.employee_id, r]));

  const previewRows = S.payrollPreviews.map(p => {
    const saved = savedFor.get(p.employee_id);
    // A finalized month is a saved snapshot. Attendance marked after it
    // was finalized changes the live figure and NOT the saved one, which
    // is correct - but it has to be said, or it looks like payroll is
    // ignoring the attendance that was just entered.
    const drifted = saved && Math.abs((saved.net_pay || 0) - p.net_pay) > 0.009;
    return `
    <div class="row between" style="padding:11px 16px;border-bottom:1px solid var(--line-soft)">
      <div class="col" style="min-width:0">
        <div style="font-weight:600">${esc(p.employee_name)}
          <span class="tiny muted">— ${esc(PAY_TYPE_LABEL[p.pay_type] || p.pay_type)} ${inr(p.pay_rate)}</span></div>
        <div class="tiny muted mono">Present ${p.present_days} · Absent ${p.absent_days} · Leave ${p.leave_days}${
          p.half_days ? ` · ${p.half_days} half-day${p.half_days === 1 ? '' : 's'}` : ''}${
          p.pay_type === 'shift' ? ` · ${p.shifts_total} shift${p.shifts_total === 1 ? '' : 's'}` : ''}</div>
        ${drifted ? `<div class="tiny" style="color:var(--warn-ink)">
          Attendance has changed since this month was finalized (saved: ${inr(saved.net_pay)}).
          Finalize again to update it.</div>` : ''}
      </div>
      <div class="row gap4" style="align-items:center;flex:none">
        <div class="tiny muted mono" style="text-align:right">Gross ${inr(p.gross_pay)}${p.advances_deducted ? `<br>Advances -${inr(p.advances_deducted)}` : ''}</div>
        <div class="mono" style="font-weight:700;min-width:90px;text-align:right">${inr(p.net_pay)}</div>
        <button class="btn ${drifted ? 'btn-primary' : saved ? 'btn-ghost' : 'btn-primary'} btn-sm"
          data-finalize="${p.employee_id}">${icon('save', 14)}${saved ? 'Re-finalize' : 'Finalize'}</button>
      </div>
    </div>`;
  }).join('');

  const historyRows = S.payrollHistory.map(r => `
    <div class="row between" style="padding:9px 16px;border-bottom:1px solid var(--line-soft)">
      <div class="col">
        <div>${esc(r.employee_name)} <span class="tiny muted">— ${esc(r.period_month)}</span></div>
        <div class="tiny muted">${r.status === 'paid' ? 'Paid ' + esc(r.paid_date || '') : 'Finalized, not yet paid'}</div>
      </div>
      <div class="row gap3" style="align-items:center">
        <span class="mono">${inr(r.net_pay)}</span>
        <span class="pill ${r.status === 'paid' ? '' : 'pill-warn'}">${r.status === 'paid' ? 'Paid' : 'Pending'}</span>
        ${r.status !== 'paid' ? `<button class="btn btn-ghost btn-sm" data-payid="${r.id}">${icon('save', 14)}Mark paid</button>` : ''}
      </div>
    </div>`).join('');

  return `
    <div class="panel-head">${monthNavHTML()}</div>
    <div class="grow scroll-y">
      <div class="panel-head" style="padding-top:0">
        <div class="col grow">
          <div class="h2">Working out now</div>
          <div class="tiny muted">Calculated from the attendance for ${esc(monthLabel(S.month))} as it stands
            this moment — it moves as soon as you change a day on the Attendance tab.</div>
        </div>
      </div>
      ${S.payrollPreviews.length ? previewRows : emptyState('card', 'No active employees', 'Add employees to run payroll.')}
      <div class="panel-head">
        <div class="col grow">
          <div class="h2">Finalized for ${esc(monthLabel(S.month))}</div>
          <div class="tiny muted">Saved figures, frozen at the moment they were finalized.</div>
        </div>
      </div>
      ${S.payrollHistory.length ? historyRows
        : emptyState('history', 'Nothing finalized for this month', 'Finalize an employee above to lock their figures in.')}
    </div>`;
}


