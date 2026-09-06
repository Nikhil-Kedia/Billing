/* ============================================================
   mock.js — stand-in backend used only when the UI runs in a plain
   browser (no pywebview host). It exists so the interface can be
   built and screenshot-tested without Windows. Never shipped logic:
   the real answers come from bridge.py.
   ============================================================ */

let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const iso = (d) => d.toISOString().slice(0, 10);

const NAMES = ['Parle-G Biscuit 100g','Aashirvaad Atta 5kg','Tata Salt 1kg','Amul Butter 500g',
  'Fortune Sunflower Oil 1L','Maggi Noodles 12pk','Colgate Toothpaste 100g','Dettol Soap 125g',
  'Britannia Marie Gold','Lays Chips 52g','Red Label Tea 500g','Nescafe Classic 50g','Surf Excel 1kg',
  'Good Day Cashew 200g','Bourbon Biscuit','Haldiram Bhujia 400g','Kissan Jam 500g','Boost 500g',
  'Horlicks 500g','Sunfeast Dark Fantasy','Vim Bar 200g','Rin Soap','Clinic Plus 175ml','Pepsodent 150g'];
const CUSTS = ['Rajesh Kumar','Sunita Traders','Manoj Sahu','Debasish Mishra','Priya Agarwal',
  'Bikash Naik','Laxmi Stores','Ashok Patra','Ganga Mandal','Sanjay Pradhan','Nirmala Devi',
  'Kishore Behera','Meena Traders','Sarita General Store'];
const PLACES = ['Sagarpali','Main Road','Kantabanji','Titlagarh','Patnagarh','Belpada','Station Road',
  'Loisingha','Turekela','Deogaon','Puintala','Agalpur','Gudvela'];
const CATS = ['Groceries','Dairy','Personal Care','Household','Snacks','Beverages'];
const UNITS = ['Pcs','Kg','Ltr','Pkt','Box','Bag'];

const items = NAMES.map((name, i) => {
  const price = Math.round((18 + rnd() * 290) * 100) / 100;
  const packed = rnd() > .55;
  return {
    id: i + 1,
    item_code: 'IT' + String(101 + i),
    name,
    category: pick(CATS),
    unit: pick(UNITS),
    price,
    cost_price: Math.round(price * (0.6 + rnd() * 0.25) * 100) / 100,
    quantity: Math.floor(rnd() * 140) - (rnd() > .85 ? 8 : 0),
    low_stock_threshold: 10,
    pack_size: packed ? pick([6, 10, 12, 24, 48]) : null,
    pack_unit_name: packed ? pick(['Carton', 'Case', 'Dozen', 'Box']) : '',
  };
});

const customers = CUSTS.map((name, i) => ({
  id: i + 1, name,
  phone: '9' + String(Math.floor(rnd() * 900000000) + 100000000),
  address: `${pick(PLACES)}, Balangir, Odisha`,
  notes: '',
}));

const bills = [];
{
  const today = new Date();
  for (let i = 0; i < 46; i++) {
    const d = new Date(today); d.setDate(d.getDate() - Math.floor(i * 0.8));
    const c = pick(customers);
    const n = 1 + Math.floor(rnd() * 5);
    const lines = Array.from({ length: n }, () => {
      const it = pick(items), q = 1 + Math.floor(rnd() * 14);
      return { item_id: it.id, item_name: it.name, quantity: q, price_per_unit: it.price,
               final_price: +(q * it.price).toFixed(2), pack_qty: null, pack_unit_name: '', pack_size: it.pack_size };
    });
    const sub = +lines.reduce((s, l) => s + l.final_price, 0).toFixed(2);
    const paid = rnd() > .32 ? sub : +(sub * rnd()).toFixed(2);
    bills.push({
      id: 1000 - i, bill_number: String(2413 - i).padStart(8, '0'),
      customer_id: c.id, customer_name: c.name, customer_phone: c.phone, customer_address: c.address,
      bill_date: iso(d), bill_time: String(9 + Math.floor(rnd() * 11)).padStart(2, '0') + ':' + String(Math.floor(rnd() * 60)).padStart(2, '0'),
      subtotal: sub, freight_charges: 0, discount: 0, total: sub, amount_paid: paid,
      bill_type: 'sale', notes: '', items: lines,
    });
  }
}

const ledger = {};
customers.forEach(c => {
  const mine = bills.filter(b => b.customer_id === c.id);
  let bal = 0;
  ledger[c.id] = mine.flatMap(b => {
    const out = [{ transaction_date: b.bill_date + ' 10:00:00', transaction_type: 'Invoice',
                   reference: b.bill_number, notes: '', debit: b.total, credit: 0 }];
    if (b.amount_paid > 0) out.push({ transaction_date: b.bill_date + ' 10:05:00', transaction_type: 'Payment',
                   reference: 'Payment for ' + b.bill_number, notes: '', debit: 0, credit: b.amount_paid });
    return out;
  }).sort((a, b2) => a.transaction_date.localeCompare(b2.transaction_date))
    .map(r => { bal += r.debit - r.credit; return { ...r, balance: +bal.toFixed(2) }; });
});
const balanceOf = (id) => { const l = ledger[id] || []; return l.length ? l[l.length - 1].balance : 0; };

const sum = (a) => a.reduce((s, x) => s + x, 0);
const ok = (data) => ({ ok: true, data });

// Employee attendance & payroll mock store.
const mockEmployees = [];
const mockAttendance = {};
let mockAdvances = [];
let mockEmpSeq = 0, mockAdvSeq = 0, mockPayrollSeq = 0;

export const mockApi = {
  bootstrap: async () => ok({
    settings: { store_name: 'Balaji Store', store_contact: '+91 94370 12345',
                store_address: 'Main Road, Balangir, Odisha 767001', bill_prefix: 'BS' },
    user: { id: 1, username: 'balaji', display_name: 'Balaji', role: 'owner' },
    track_stock: true, track_khata: true,
    // The mock always plays "signed in as the owner", so browser-preview
    // shows every screen including the owner-only ones.
    can: { view_profit: true, manage_attendance: true, delete_bill: true, delete_all_bills: true,
           edit_bill: true, manage_inventory: true, reset_inventory: true, delete_customer: true,
           view_analytics: true, manage_settings: true, backup_data: true, import_data: true,
           archive_bills: true, manage_users: true, view_audit_log: true, clear_stock_history: true,
           ledger_payment: true },
    app: { name: 'Vikray', version: '3.0' }, data_dir: 'C:\\Users\\…\\BalajiBilling\\data',
  }),

  quick_search: async (t) => {
    const s = t.toLowerCase();
    return ok([
      ...customers.filter(c => c.name.toLowerCase().includes(s)).slice(0, 4)
        .map(c => ({ kind: 'customer', id: c.id, label: c.name, sub: c.phone })),
      ...items.filter(i => i.name.toLowerCase().includes(s)).slice(0, 4)
        .map(i => ({ kind: 'item', id: i.id, label: i.name, sub: i.item_code })),
      ...bills.filter(b => b.bill_number.includes(s) || b.customer_name.toLowerCase().includes(s)).slice(0, 3)
        .map(b => ({ kind: 'bill', id: b.id, label: 'Bill ' + b.bill_number, sub: b.customer_name })),
    ]);
  },

  dashboard: async (range = 'month', month = null) => {
    const allDates = bills.map(b => b.bill_date).sort();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const iso2 = (d) => iso(d);
    let curFrom, curTo, resolvedMonth = null;
    if (range === 'today') {
      curFrom = new Date(today); curTo = new Date(today);
    } else if (range === 'week') {
      curFrom = new Date(today); curFrom.setDate(curFrom.getDate() - 6); curTo = new Date(today);
    } else if (range === 'all') {
      curFrom = allDates.length ? new Date(allDates[0]) : new Date(today);
      curTo = new Date(today);
    } else { // month
      const maxMonth = iso2(today).slice(0, 7);
      const minMonth = allDates.length ? allDates[0].slice(0, 7) : maxMonth;
      let m = (month && /^\d{4}-\d{2}$/.test(month)) ? month : maxMonth;
      if (m > maxMonth) m = maxMonth;
      if (m < minMonth) m = minMonth;
      const [y, mo] = m.split('-').map(Number);
      curFrom = new Date(y, mo - 1, 1);
      curTo = new Date(y, mo, 0);
      if (curTo > today) curTo = new Date(today);
      resolvedMonth = m;
    }
    const inWindow = (d) => { const t = new Date(d); return t >= curFrom && t <= curTo; };
    const inRange = bills.filter(b => inWindow(b.bill_date));
    const total = sum(inRange.map(b => b.total));

    // previous period of equal span, for the KPI deltas — 'all' has none.
    let revDelta = null, billsDelta = null, avgDelta = null;
    if (range !== 'all') {
      const spanDays = Math.round((curTo - curFrom) / 86400000) + 1;
      const prevTo = new Date(curFrom); prevTo.setDate(prevTo.getDate() - 1);
      const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - (spanDays - 1));
      const prevBills = bills.filter(b => { const t = new Date(b.bill_date); return t >= prevFrom && t <= prevTo; });
      const prevTotal = sum(prevBills.map(b => b.total));
      const pct = (cur, prev) => prev ? (cur - prev) / prev * 100 : null;
      revDelta = pct(total, prevTotal);
      billsDelta = pct(inRange.length, prevBills.length);
      const prevAvg = prevBills.length ? prevTotal / prevBills.length : null;
      avgDelta = prevAvg ? pct(inRange.length ? total / inRange.length : 0, prevAvg) : null;
    }

    const byDate = {}; inRange.forEach(b => { byDate[b.bill_date] = (byDate[b.bill_date] || 0) + b.total; });
    const daily = Object.entries(byDate).sort()
      .map(([d, v]) => ({ date: d, revenue: v, bills: inRange.filter(b => b.bill_date === d).length }));
    const byItem = {};
    inRange.forEach(b => b.items.forEach(l => {
      byItem[l.item_name] = byItem[l.item_name] || { name: l.item_name, qty: 0, revenue: 0 };
      byItem[l.item_name].qty += l.quantity; byItem[l.item_name].revenue += l.final_price;
    }));
    const top = Object.values(byItem).sort((a, b) => b.revenue - a.revenue).slice(0, 8);
    const weekday = Array.from({ length: 7 }, (_, i) => ({ day: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][i],
      revenue: sum(inRange.filter(b => (new Date(b.bill_date).getDay() + 6) % 7 === i).map(b => b.total)),
      bills: inRange.filter(b => (new Date(b.bill_date).getDay() + 6) % 7 === i).length }));
    const heat = Array.from({ length: 7 }, () => Array.from({ length: 13 }, () => Math.round(rnd() * 100)));
    const collected = sum(inRange.map(b => b.amount_paid));
    const outstandingRows = customers.map(c => Math.max(0, balanceOf(c.id))).filter(v => v > 0.009);
    return ok({
      kpis: {
        revenue: total, revenue_delta: revDelta,
        bills: inRange.length, bills_delta: billsDelta,
        avg: inRange.length ? total / inRange.length : 0, avg_delta: avgDelta,
        outstanding: sum(outstandingRows), outstanding_accounts: outstandingRows.length,
        low_stock: items.filter(i => i.quantity <= i.low_stock_threshold).length,
      },
      daily, top_products: top, weekday, heatmap: heat,
      cash_credit: { collected, credit: Math.max(0, sum(inRange.map(b => b.total)) - collected) },
      acquisition: ['Apr','May','Jun','Jul','Aug','Sep'].map(m => ({ label: m, count: 5 + Math.floor(rnd() * 18) })),
      ageing: [{ bucket: '0-30 days', amount: 8200 }, { bucket: '31-60 days', amount: 4100 },
               { bucket: '61-90 days', amount: 2400 }, { bucket: 'Over 90 days', amount: 1500 }],
      period: { from: iso2(curFrom), to: iso2(curTo), month: resolvedMonth },
    });
  },

  bill_date_bounds: async () => {
    const dates = bills.map(b => b.bill_date).sort();
    return ok({ first: dates[0] || null, last: dates[dates.length - 1] || null });
  },

  /** Mirrors bridge.py's custom_report grouping/measure logic closely
      enough for the UI to be built and exercised in a plain browser -
      the real numbers always come from the SQL in bridge.py. */
  custom_report: async (spec = {}) => {
    const { x, y, limit, date_from, date_to } = spec || {};
    const X_LABELS = { date: 'Date', month: 'Month', weekday: 'Day of week', hour: 'Hour of day',
      customer: 'Customer', product: 'Product', category: 'Product category',
      payment_status: 'Payment status', bill_type: 'Bill type' };
    const Y_LABELS = { revenue: 'Revenue', bills: 'Bill count', items_sold: 'Items sold', quantity: 'Quantity',
      avg_bill: 'Average bill value', collected: 'Amount collected', outstanding: 'Outstanding' };
    if (!X_LABELS[x]) return { ok: false, error: 'Please choose what to group by.', title: 'Check the details' };
    if (!Y_LABELS[y]) return { ok: false, error: 'Please choose what to measure.', title: 'Check the details' };
    const n = Math.max(1, Math.min(50, parseInt(limit, 10) || 10));

    const WD = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const catOf = (name) => items.find(i => i.name === name)?.category || 'Uncategorised';
    const statusOf = (b) => (b.amount_paid - b.total >= -0.009) ? 'Paid' : (b.amount_paid <= 0.009 ? 'Credit' : 'Partial');

    let pool = bills.filter(b => x === 'bill_type' ? true : b.bill_type === 'sale');
    if (date_from) pool = pool.filter(b => b.bill_date >= date_from);
    if (date_to) pool = pool.filter(b => b.bill_date <= date_to);

    const groups = new Map();   // key -> { bills: Bill[], lines: {b,line}[] }
    const bucket = (key) => {
      if (key == null) return null;
      if (!groups.has(key)) groups.set(key, { bills: [], lines: [] });
      return groups.get(key);
    };
    const itemLevel = x === 'product' || x === 'category';
    if (itemLevel) {
      pool.forEach(b => b.items.forEach(line => bucket(x === 'product' ? line.item_name : catOf(line.item_name))?.lines.push({ b, line })));
    } else {
      pool.forEach(b => {
        let key;
        if (x === 'date') key = b.bill_date;
        else if (x === 'month') key = b.bill_date.slice(0, 7);
        else if (x === 'weekday') key = WD[(new Date(b.bill_date).getDay() + 6) % 7];
        else if (x === 'hour') key = b.bill_time.slice(0, 2) + ':00';
        else if (x === 'customer') key = b.customer_name;
        else if (x === 'payment_status') key = statusOf(b);
        else if (x === 'bill_type') key = b.bill_type === 'purchase' ? 'Purchase' : 'Sale';
        bucket(key)?.bills.push(b);
      });
    }

    const measure = (g) => {
      const distinctBills = g.bills.length ? g.bills : [...new Set(g.lines.map(l => l.b))];
      switch (y) {
        case 'revenue': return g.bills.length ? sum(g.bills.map(b => b.total)) : sum(g.lines.map(l => l.line.final_price));
        case 'bills': return distinctBills.length;
        case 'items_sold': return g.bills.length ? sum(g.bills.map(b => b.items.length)) : g.lines.length;
        case 'quantity': return g.bills.length ? sum(g.bills.flatMap(b => b.items).map(l => l.quantity)) : sum(g.lines.map(l => l.line.quantity));
        case 'avg_bill': {
          const rev = g.bills.length ? sum(g.bills.map(b => b.total)) : sum(g.lines.map(l => l.line.final_price));
          return distinctBills.length ? rev / distinctBills.length : 0;
        }
        case 'collected': return g.bills.length
          ? sum(g.bills.map(b => b.amount_paid))
          : sum(g.lines.map(l => l.line.final_price * (l.b.amount_paid / (l.b.total || 1))));
        case 'outstanding': return g.bills.length
          ? sum(g.bills.map(b => Math.max(0, b.total - b.amount_paid)))
          : sum(g.lines.map(l => l.line.final_price * (Math.max(0, l.b.total - l.b.amount_paid) / (l.b.total || 1))));
        default: return 0;
      }
    };

    let rows;
    if (x === 'weekday') {
      rows = WD.map(name => ({ label: name, value: groups.has(name) ? measure(groups.get(name)) : 0 }));
    } else if (x === 'hour') {
      rows = Array.from({ length: 24 }, (_, h) => { const key = String(h).padStart(2, '0') + ':00';
        return { label: key, value: groups.has(key) ? measure(groups.get(key)) : 0 }; });
    } else {
      rows = [...groups.entries()].map(([label, g]) => ({ label: String(label), value: measure(g) }));
      if (x === 'date' || x === 'month') rows.sort((a, b) => a.label.localeCompare(b.label));
      else { rows.sort((a, b) => b.value - a.value); if (x === 'customer' || itemLevel) rows = rows.slice(0, n); }
    }
    const total = sum(rows.map(r => r.value));
    return ok({ rows, x_label: X_LABELS[x], y_label: Y_LABELS[y], total });
  },

  export_custom_report: async () => ok('C:\\…\\custom_report.csv'),

  items_snapshot: async () => ok(items),
  customers_snapshot: async () => ok(customers),
  customer_balance: async (id) => ok(balanceOf(id)),
  next_bill_number: async () => ok(String(2414).padStart(8, '0')),
  stock_levels: async (ids) => ok(Object.fromEntries(ids.map(i => [i, items.find(x => x.id === i)?.quantity ?? 0]))),

  create_bill: async (p) => { await new Promise(r => setTimeout(r, 260));
    return ok({ bill_id: 9999, bill_number: String(2414).padStart(8, '0'), pdf_path: 'C:\\…\\00002414.pdf' }); },
  update_bill: async () => ok({ bill_id: 1, bill_number: '00002413' }),

  get_bills: async (search = '') => ok(bills.filter(b =>
    !search || b.bill_number.includes(search) || b.customer_name.toLowerCase().includes(search.toLowerCase()))),
  get_bill: async (id) => ok(bills.find(b => b.id === id) || bills[0]),
  delete_bill: async () => ok(true),
  open_pdf: async () => ok(true),
  print_bill: async () => ok(true),
  send_whatsapp: async () => ok('Sent'),
  reveal: async () => ok(true),

  // Earnings (owner-only). Enough shape for the browser preview to
  // render every level of the drill-down.
  earnings: async (range) => {
    const days = Array.from({ length: 24 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - (23 - i));
      const revenue = Math.round(8000 + rnd() * 26000);
      const profit = Math.round(revenue * (0.06 + rnd() * 0.22)) * (rnd() > .92 ? -1 : 1);
      return { date: d.toISOString().slice(0, 10), revenue, cost: revenue - profit, profit,
               margin: +(profit / revenue * 100).toFixed(2) };
    });
    const sum = (k) => days.reduce((a, d) => a + d[k], 0);
    const mk = (label, extra = {}) => {
      const revenue = Math.round(4000 + rnd() * 40000);
      const profit = Math.round(revenue * (0.05 + rnd() * 0.25));
      return { label, revenue, cost: revenue - profit, profit,
               margin: +(profit / revenue * 100).toFixed(2), bills: 1 + Math.floor(rnd() * 12),
               uncosted_lines: rnd() > .85 ? 1 : 0, ...extra };
    };
    return ok({
      range, date_from: days[0].date, date_to: days[days.length - 1].date,
      summary: { revenue: sum('revenue'), cost: sum('cost'), profit: sum('profit'),
                 margin: +(sum('profit') / sum('revenue') * 100).toFixed(2),
                 bills: 96, lines: 240, uncosted_lines: 3,
                 costed_revenue: Math.round(sum('revenue') * 0.94), costed_pct: 94 },
      delta: { profit: 12.4, revenue: 8.1 },
      daily: days,
      items: items.slice(0, 14).map(i => mk(i.name, { quantity: Math.round(20 + rnd() * 400) })),
      customers: customers.slice(0, 12).map(c => mk(c.name)),
      categories: ['Groceries', 'Dairy', 'Snacks', 'Household'].map(c => mk(c)),
    });
  },
  earnings_bills: async (range, month, itemName, customerName) => ok({
    date_from: null, date_to: null, item_name: itemName || null, customer_name: customerName || null,
    bills: bills.slice(0, 18).map(b => {
      const revenue = Math.round(b.total);
      const profit = Math.round(revenue * (0.04 + rnd() * 0.26));
      return { bill_id: b.id, bill_number: b.bill_number, bill_date: b.bill_date, bill_time: b.bill_time,
               customer_name: b.customer_name, bill_total: b.total, lines: 3, uncosted_lines: 0,
               revenue, cost: revenue - profit, profit, margin: +(profit / revenue * 100).toFixed(2) };
    }),
  }),
  bill_profit: async (billId) => {
    const b = bills.find(x => x.id === billId) || bills[0];
    const lines = (b.items || []).map(li => {
      const rev = li.final_price;
      const costUnit = +(li.price_per_unit * (0.62 + rnd() * 0.2)).toFixed(2);
      const cost = +(costUnit * li.quantity).toFixed(2);
      return { ...li, line_revenue: rev, line_cost: cost, cost_per_unit: costUnit,
               line_profit: +(rev - cost).toFixed(2), margin: +((rev - cost) / rev * 100).toFixed(2),
               cost_source: rnd() > .85 ? 'default' : 'recorded', item_unit: 'Pcs' };
    });
    const revenue = lines.reduce((a, l) => a + l.line_revenue, 0);
    const cost = lines.reduce((a, l) => a + l.line_cost, 0);
    return ok({ bill: b, lines, is_sale: b.bill_type !== 'purchase',
                revenue: +revenue.toFixed(2), cost: +cost.toFixed(2),
                profit: +(revenue - cost).toFixed(2),
                margin: +((revenue - cost) / revenue * 100).toFixed(2) });
  },
  earnings_checks: async () => {
    const one = (n) => bills.slice(0, n).map(b => ({
      bill_id: b.id, bill_number: b.bill_number, bill_date: b.bill_date,
      customer_name: b.customer_name, item_name: pick(items).name,
      quantity: 12, price_per_unit: 9, line_cost: 140, line_revenue: 108,
      line_profit: -32, cost_at_sale: 140 }));
    return ok({ sold_below_cost: one(2), no_cost: one(1), free: [], suspicious_margin: [] });
  },
  earnings_export: async () => ok('C:\\Users\\Demo\\profit_by_item.csv'),

  item_cost_layers: async (id) => {
    const it = items.find(x => x.id === id) || {};
    const half = Math.max(1, Math.round((it.quantity || 0) / 2));
    const layers = (it.quantity || 0) <= 0 ? [] : [
      { id: 1, item_id: id, cost_price: +( (it.cost_price || 0) * 1.06 ).toFixed(2), remaining: half,
        source: 'purchase', reference: '00000042', received_date: '2026-07-14' },
      { id: 2, item_id: id, cost_price: it.cost_price || 0, remaining: (it.quantity || 0) - half,
        source: 'purchase', reference: '00000061', received_date: '2026-08-30' },
    ];
    const units = layers.reduce((s, l) => s + l.remaining, 0);
    const value = layers.reduce((s, l) => s + l.remaining * l.cost_price, 0);
    return ok({ layers, units, value: +value.toFixed(2), avg_cost: units ? +(value / units).toFixed(4) : 0 });
  },
  stock_valuation: async () => ok({ value: 184320, units: 4120, items: items.length }),
  get_items: async (search = '') => ok(items.filter(i => !search ||
    i.name.toLowerCase().includes(search.toLowerCase()) || i.item_code.toLowerCase().includes(search.toLowerCase()))),
  add_item: async () => ok(true), update_item: async () => ok(true), delete_item: async () => ok(true),
  adjust_stock: async () => ok(true),
  inventory_transactions: async () => ok(bills.slice(0, 24).flatMap(b => b.items.slice(0, 1).map(l => ({
    id: b.id, created_at: b.bill_date + ' ' + b.bill_time, item_name: l.item_name,
    change_type: pick(['Sale', 'Restock', 'Damaged', 'Manual Adjustment']),
    quantity_change: -l.quantity, resulting_quantity: 40 + Math.floor(rnd() * 60), reference: 'Bill ' + b.bill_number })))),
  clear_inventory_transactions: async () => ok(true),

  get_customers: async (search = '') => ok(customers.filter(c => !search ||
    c.name.toLowerCase().includes(search.toLowerCase()) || c.phone.includes(search))
    .map(c => {
      const mine = bills.filter(b => b.customer_id === c.id);
      return {
        ...c,
        balance: balanceOf(c.id),
        bill_count: mine.length,
        total_revenue: sum(mine.map(b => b.total)),
        last_purchase: mine.length ? mine.map(b => b.bill_date).sort().pop() : null,
      };
    })),
  add_customer: async () => ok(1), update_customer: async () => ok(true), delete_customer: async () => ok(true),
  merge_customers: async () => ok({ merged_name: 'DUPLICATE', kept_name: 'KEPT', bills_moved: 3, ledger_moved: 2 }),
  claim_device: async () => ok({ user: { id: 1, username: 'owner', role: 'owner' },
                                 recovery_code: 'K7QP-2MRX-9FTA-4WHD' }),
  reset_with_recovery_code: async () => ok(true),
  customers_with_dues: async () => ok(customers.map(c => ({ ...c, balance: balanceOf(c.id) }))
    .filter(c => c.balance > 0).sort((a, b) => b.balance - a.balance)),
  customer_ledger: async (id) => ok(ledger[id] || []),
  add_ledger_payment: async () => ok(true),
  customer_kpis: async (id) => {
    const mine = bills.filter(b => b.customer_id === id);
    const tot = sum(mine.map(b => b.total));
    return ok({ total_revenue: tot, bill_count: mine.length, avg_order: mine.length ? tot / mine.length : 0,
                last_purchase: mine[0]?.bill_date || null, balance: balanceOf(id) });
  },
  customer_bills: async (id) => ok(bills.filter(b => b.customer_id === id)),
  customer_products: async (id) => {
    const m = {};
    bills.filter(b => b.customer_id === id).forEach(b => b.items.forEach(l => {
      m[l.item_name] = m[l.item_name] || { item_name: l.item_name, times: 0, qty: 0, amount: 0 };
      m[l.item_name].times++; m[l.item_name].qty += l.quantity; m[l.item_name].amount += l.final_price;
    }));
    return ok(Object.values(m).sort((a, b) => b.amount - a.amount));
  },
  customer_product_history: async (id, name) => ok(bills.filter(b => b.customer_id === id)
    .flatMap(b => b.items.filter(l => l.item_name === name).map(l => ({
      bill_date: b.bill_date, bill_number: b.bill_number, quantity: l.quantity,
      price_per_unit: l.price_per_unit, final_price: l.final_price })))),

  get_settings: async () => ok({ store_name: 'Balaji Store', store_contact: '+91 94370 12345',
    store_address: 'Main Road, Balangir, Odisha 767001', bill_prefix: 'BS', next_bill_seq: '2414',
    track_stock: '1', track_khata: '1', auth_enabled: '0', auto_backup_enabled: '1', auto_backup_keep: '14',
    auto_backup_last: '2026-09-04 23:30' }),
  set_setting: async () => ok(true),
  backup_now: async () => { await new Promise(r => setTimeout(r, 500)); return ok({ path: 'C:\\…\\backup.bbak' }); },
  list_users: async () => ok([{ id: 1, username: 'balaji', display_name: 'Balaji', role: 'owner', is_active: 1 }]),
  data_dir: async () => ok('C:\\Users\\…\\AppData\\Local\\BalajiBilling\\data'),
  audit_log: async () => ok([]),
  sign_out: async () => ok(true),
  export_items: async () => ok('C:\\…\\inventory.csv'),
  import_items: async () => ok({ added: 0, updated: 0, skipped: 0 }),
  reveal: async () => ok(true),
  open_folder: async () => ok(true),
  archive_settings: async () => ok({ folder: 'E:\\Vikray archives', exists: true, last_archived: '2026-09-05 21:40' }),
  choose_archive_folder: async () => ok({ folder: 'E:\\Vikray archives' }),
  archive_preview: async (from, to) => ok({
    date_from: from, date_to: to, bills: 14, sales: 13, purchases: 1, sales_value: 184320,
    folder: 'E:\\Vikray archives', folder_exists: true,
    filename: `vikray-archive-${from}.bbak`, path: `E:\\Vikray archives\\vikray-archive-${from}.bbak`,
    existing: null }),
  archive_run: async (from) => ok({ archived: 14, already_present: 0, renumbered: 0, purged: 14,
    verified: true, error: '', path: `E:\\Vikray archives\\vikray-archive-${from}.bbak`,
    date_from: from, date_to: from }),
  open_archive_folder: async () => ok(true),
  restore_backup: async () => ok({ restored: true }),
  reset_all_stock: async () => ok(true),
  create_user: async () => ok(2),
  update_user: async () => ok(true),
  delete_user: async () => ok(true),

  // Auto-update (Phase 3) - mock mode is always "already up to date" so
  // the browser-preview dev flow never shows an install prompt.
  get_update_status: async () => ok({ info: null, last_check: new Date().toISOString(), version: '3.0' }),
  check_for_updates: async () => ok(null),
  start_update_download: async () => ok(true),
  get_update_progress: async () => ok({ downloading: false, downloaded: 0, total: 0, ready: false, error: null }),
  install_update: async () => ok(true),
  dismiss_update_notice: async () => ok(true),

  // Employee attendance & payroll (owner-only) - a small, self-contained
  // mock store so the screen has something to show in browser preview.
  employees_list: async () => ok(mockEmployees),
  add_employee: async (data) => { const id = ++mockEmpSeq; mockEmployees.push({ id, active: 1, ...data }); return ok(id); },
  update_employee: async (id, data) => { const e = mockEmployees.find(x => x.id === id); if (e) Object.assign(e, data); return ok(true); },
  set_employee_active: async (id, active) => { const e = mockEmployees.find(x => x.id === id); if (e) e.active = active ? 1 : 0; return ok(true); },
  attendance_month: async (month) => ok(mockAttendance[month] || {}),
  mark_attendance: async (employeeId, date, status) => {
    const m = date.slice(0, 7);
    mockAttendance[m] = mockAttendance[m] || {};
    mockAttendance[m][employeeId] = mockAttendance[m][employeeId] || {};
    if (status === 'clear') { delete mockAttendance[m][employeeId][date]; return ok(true); }
    const am = status === 'half' ? 'present' : status;
    const pm = status === 'half' ? 'absent' : status;
    mockAttendance[m][employeeId][date] = { status, am, pm, shifts: (am === 'present') + (pm === 'present') };
    return ok(true);
  },
  mark_attendance_session: async (employeeId, date, session, status) => {
    const m = date.slice(0, 7);
    mockAttendance[m] = mockAttendance[m] || {};
    const rec = (mockAttendance[m][employeeId] = mockAttendance[m][employeeId] || {});
    const day = rec[date] || { am: null, pm: null };
    day[session] = status === 'clear' ? null : status;
    if (!day.am && !day.pm) { delete rec[date]; return ok({ am: null, pm: null, status: null }); }
    day.status = day.am === day.pm ? day.am : 'half';
    day.shifts = (day.am === 'present') + (day.pm === 'present');
    rec[date] = day;
    return ok(day);
  },
  add_advance: async (employeeId, date, amount, notes) => {
    const id = ++mockAdvSeq;
    mockAdvances.push({ id, employee_id: employeeId, date, amount, notes: notes || '', settled: 0 });
    return ok(id);
  },
  list_advances: async (employeeId, unsettledOnly) => ok(mockAdvances.filter(a =>
    (employeeId == null || a.employee_id === employeeId) && (!unsettledOnly || !a.settled))),
  delete_advance: async (id) => { mockAdvances = mockAdvances.filter(a => a.id !== id || a.settled); return ok(true); },
  payroll_preview: async (employeeId, month) => {
    const emp = mockEmployees.find(e => e.id === employeeId);
    return ok(emp ? {
      employee_id: employeeId, employee_name: emp.name, period_month: month,
      pay_type: emp.pay_type, pay_rate: emp.pay_rate, days_in_month: 30,
      present_days: 12.5, half_days: 1, absent_days: 1, leave_days: 2, shifts_total: 25,
      gross_pay: emp.pay_rate || 0, advances_deducted: 0, advance_ids: [], net_pay: emp.pay_rate || 0,
    } : null);
  },
  finalize_payroll: async () => ok(++mockPayrollSeq),
  mark_payroll_paid: async () => ok(true),
  payroll_runs: async () => ok([]),
};

// The real bridge exposes a couple of methods under two names, because the
// screens grew up calling them different things. Mirror that here so the
// mock and the shipped backend answer to exactly the same set.
mockApi.customers_overview = mockApi.get_customers;
mockApi.get_all_items = mockApi.get_items;
