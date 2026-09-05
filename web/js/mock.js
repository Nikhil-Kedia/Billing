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

export const mockApi = {
  bootstrap: async () => ok({
    settings: { store_name: 'Balaji Store', store_contact: '+91 94370 12345',
                store_address: 'Main Road, Balangir, Odisha 767001', bill_prefix: 'BS' },
    user: { id: 1, username: 'balaji', display_name: 'Balaji', role: 'owner' },
    track_stock: true, track_khata: true,
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
  pdf_list: async () => ok(bills.slice(0, 24).map(b => ({
    bill_id: b.id, bill_number: b.bill_number, customer_name: b.customer_name,
    date: b.bill_date, size_kb: 60 + Math.floor(rnd() * 70), filename: b.bill_number + '.pdf', exists: true }))),

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
  restore_backup: async () => ok({ restored: true }),
  reset_all_stock: async () => ok(true),
  create_user: async () => ok(2),
  update_user: async () => ok(true),
  delete_user: async () => ok(true),
};

// The real bridge exposes a couple of methods under two names, because the
// screens grew up calling them different things. Mirror that here so the
// mock and the shipped backend answer to exactly the same set.
mockApi.customers_overview = mockApi.get_customers;
mockApi.get_all_items = mockApi.get_items;
