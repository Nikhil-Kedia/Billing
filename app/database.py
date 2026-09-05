"""
database.py
Handles all SQLite database operations for Balaji Store Billing System.
Single-file database stored at data/balaji_billing.db
"""

import sqlite3
import os
from datetime import datetime
import appdata

# Resolved through appdata so the built .exe keeps its database
# outside the program folder - see appdata.py for why that matters.
DB_DIR = appdata.data_dir()
DB_PATH = os.path.join(DB_DIR, "balaji_billing.db")


def get_connection():
    os.makedirs(DB_DIR, exist_ok=True)
    # timeout= is how many seconds SQLite will keep silently retrying
    # before raising "database is locked" - Python's own default (5s) is
    # what the app used to run on. Bumped to 15s and also set explicitly
    # via PRAGMA busy_timeout (belt-and-braces: some SQLite builds only
    # honour one of the two), because this app opens a fresh connection
    # per call rather than one long-lived one - a maintenance job (the
    # nightly auto-backup) or a big import can legitimately hold a lock
    # for a couple of seconds, and 5s was cutting it close for a
    # shopkeeper mid-sale.
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.execute("PRAGMA busy_timeout = 15000")
    # WAL lets readers (every SELECT-only screen: dashboard, history,
    # autocomplete...) proceed without ever blocking on - or being
    # blocked by - a writer, which is what actually eliminates the
    # "database is locked" class of freeze under normal use (the
    # busy_timeout above is only the fallback for the genuine
    # writer-vs-writer case that WAL does not remove). This is a
    # one-time, idempotent switch of the database file's journal mode -
    # cheap to set on every connect.
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Create all tables if they do not already exist."""
    conn = get_connection()
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_code TEXT UNIQUE,
            name TEXT NOT NULL UNIQUE,
            category TEXT DEFAULT '',
            unit TEXT DEFAULT 'pcs',
            price REAL NOT NULL DEFAULT 0,
            quantity REAL NOT NULL DEFAULT 0,
            low_stock_threshold REAL DEFAULT 5,
            pack_size REAL,
            pack_unit_name TEXT DEFAULT '',
            created_at TEXT,
            updated_at TEXT
        )
    """)
    
    try:
        cur.execute("ALTER TABLE items ADD COLUMN item_code TEXT UNIQUE")
    except sqlite3.OperationalError:
        pass 

    try:
        cur.execute("ALTER TABLE items ADD COLUMN pack_size REAL")
    except sqlite3.OperationalError:
        pass

    try:
        cur.execute("ALTER TABLE items ADD COLUMN pack_unit_name TEXT DEFAULT ''")
    except sqlite3.OperationalError:
        pass

    cur.execute("""
        CREATE TABLE IF NOT EXISTS customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT DEFAULT '',
            address TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_at TEXT
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS bills (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bill_number TEXT UNIQUE NOT NULL,
            customer_id INTEGER,
            customer_name TEXT NOT NULL,
            customer_phone TEXT DEFAULT '',
            customer_address TEXT DEFAULT '',
            bill_date TEXT NOT NULL,
            bill_time TEXT NOT NULL,
            freight_charges REAL DEFAULT 0,
            discount REAL DEFAULT 0,
            subtotal REAL NOT NULL DEFAULT 0,
            total REAL NOT NULL DEFAULT 0,
            amount_paid REAL DEFAULT 0,
            notes TEXT DEFAULT '',
            bill_type TEXT NOT NULL DEFAULT 'sale',
            created_at TEXT,
            updated_at TEXT,
            FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
        )
    """)

    try:
        cur.execute("ALTER TABLE bills ADD COLUMN discount REAL DEFAULT 0")
    except sqlite3.OperationalError:
        pass
        
    try:
        cur.execute("ALTER TABLE bills ADD COLUMN amount_paid REAL DEFAULT 0")
    except sqlite3.OperationalError:
        pass

    try:
        # 'sale' (the only kind that existed before this column) or
        # 'purchase' - a purchase bill adds its quantities to stock
        # instead of deducting them. Every bill created before this
        # column existed defaults to 'sale', which is what it already
        # was.
        cur.execute("ALTER TABLE bills ADD COLUMN bill_type TEXT NOT NULL DEFAULT 'sale'")
    except sqlite3.OperationalError:
        pass

    # NEW: The immutable Khata / Ledger Table
    cur.execute("""
        CREATE TABLE IF NOT EXISTS customer_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL,
            transaction_date TEXT NOT NULL,
            transaction_type TEXT NOT NULL,
            reference TEXT DEFAULT '',
            debit REAL DEFAULT 0,
            credit REAL DEFAULT 0,
            notes TEXT DEFAULT '',
            created_at TEXT,
            FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS bill_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bill_id INTEGER NOT NULL,
            item_id INTEGER,
            item_name TEXT NOT NULL,
            quantity REAL NOT NULL,
            price_per_unit REAL NOT NULL,
            final_price REAL NOT NULL,
            pack_qty REAL,
            pack_unit_name TEXT DEFAULT '',
            pack_size REAL,
            FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
            FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE SET NULL
        )
    """)

    try:
        cur.execute("ALTER TABLE bill_items ADD COLUMN pack_qty REAL")
    except sqlite3.OperationalError:
        pass

    try:
        cur.execute("ALTER TABLE bill_items ADD COLUMN pack_unit_name TEXT DEFAULT ''")
    except sqlite3.OperationalError:
        pass

    try:
        cur.execute("ALTER TABLE bill_items ADD COLUMN pack_size REAL")
    except sqlite3.OperationalError:
        pass

    cur.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS inventory_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id INTEGER,
            item_name TEXT NOT NULL,
            change_type TEXT NOT NULL,
            quantity_change REAL NOT NULL,
            resulting_quantity REAL,
            reference TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_at TEXT
        )
    """)

    # ---- Accounts & audit trail ----
    # Added for the security pass. Both tables are deliberately NOT part of
    # any backup category (see backup_restore._CATEGORY_TABLES): password
    # hashes must not travel out of the shop on a pendrive, and an audit
    # trail that can be replaced by importing a file isn't an audit trail.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            display_name TEXT DEFAULT '',
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'staff',
            is_active INTEGER NOT NULL DEFAULT 1,
            recovery_hash TEXT DEFAULT '',
            failed_attempts INTEGER NOT NULL DEFAULT 0,
            lockout_count INTEGER NOT NULL DEFAULT 0,
            locked_until TEXT DEFAULT '',
            last_login TEXT DEFAULT '',
            must_change_password INTEGER NOT NULL DEFAULT 0,
            created_at TEXT,
            updated_at TEXT
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            username TEXT DEFAULT '',
            role TEXT DEFAULT '',
            action TEXT NOT NULL,
            detail TEXT DEFAULT '',
            outcome TEXT DEFAULT 'ok'
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC)")

    # Indexes for the lookups that run on every keystroke in the bill
    # editor and on every history search. Without these, each search is a
    # full table scan - fine at 50 bills, noticeably slow at 20,000.
    cur.execute("CREATE INDEX IF NOT EXISTS idx_bills_date ON bills(bill_date)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_bills_customer ON bills(customer_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_bill_items_bill ON bill_items(bill_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ledger_customer ON customer_ledger(customer_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ledger_reference ON customer_ledger(reference)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_invtx_item ON inventory_transactions(item_id)")

    defaults = {
        "store_name": "Balaji Store",
        "store_contact": "",
        "store_address": "Balangir, Odisha",
        "logo_path": "",
        "bill_prefix": "BS",
        "next_bill_seq": "1",
        # Off until the owner sets up the first account, so upgrading an
        # existing installation never locks anyone out of their own data.
        "auth_enabled": "0",
        "auto_backup_enabled": "1",
        "auto_backup_last": "",
        "auto_backup_keep": "14",
        # Stock tracking is OFF by default. Most shops start by using the
        # item list as a price list and only begin counting stock later;
        # until they do, low-stock warnings are noise. Turning this on
        # reveals the stock column, the low-stock tile and the Stock
        # History screen. Quantities are still maintained underneath
        # either way, so switching it on later gives real numbers rather
        # than starting from zero.
        "track_stock": "0",
        # Same idea for the credit ledger: a shop that always collects
        # full payment on the spot has no khata to track. Off hides the
        # Khata/Ledger screen, the dashboard's "Owed To You" tile and
        # "Collected vs On Credit" chart, and the ledger panel in
        # Customer Insights. Every bill still records how much was paid
        # underneath, so turning it on later is not a fresh start - the
        # ledger for every past bill is already there.
        "track_khata": "0",
    }
    for k, v in defaults.items():
        cur.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (k, v))

    conn.commit()
    conn.close()


# ---------------- IN-PROCESS SNAPSHOT CACHE ----------------
# The bill editor's autocomplete runs on every keystroke and needs the
# whole item list each time. Worse, recalculate() -> get_data() calls
# get_all_items() once PER ITEM ROW, so one character typed on a
# five-line bill cost six full table reads plus six 400-element scans.
#
# The cache lives here rather than in the editor for two reasons: a
# per-screen copy cannot be invalidated by a write made on a different
# screen, and putting it in the data layer means the command palette and
# the inventory table get the same benefit for free.

_cache = {}
_versions = {"items": 0, "customers": 0, "bills": 0}


def bump(*domains):
    """Invalidates cached snapshots. Called after every write, and after
    anything that replaces the database wholesale (backup or CSV import)."""
    for domain in domains:
        _versions[domain] = _versions.get(domain, 0) + 1
        _cache.pop(domain, None)


def data_version(domain):
    """Lets a screen cheaply detect that its cached view is out of date."""
    return _versions.get(domain, 0)


def items_snapshot():
    """Every item, with lookup indexes, rebuilt only when items change.

    READ-ONLY: callers must not mutate the returned list or its dicts.
    Filtering into a new list is fine.

    Two case foldings are kept deliberately. The autocomplete matches
    names case-INSENSITIVELY, while get_data() resolves a saved bill line
    back to an item by an EXACT name match. Collapsing them into one
    index would quietly change which item a stored line points at.
    """
    snap = _cache.get("items")
    if snap is None:
        rows = get_all_items()
        snap = {
            "list": rows,
            "by_id": {r["id"]: r for r in rows},
            "by_name": {r["name"]: r for r in rows},
            "by_name_lc": {r["name"].lower(): r for r in rows},
            "by_code": {r["item_code"]: r for r in rows if r.get("item_code")},
            "by_code_lc": {r["item_code"].lower(): r for r in rows if r.get("item_code")},
            # Lowercased once here so the per-keystroke filter never calls
            # .lower() four hundred times again.
            "search": [(r["name"].lower(), (r.get("item_code") or "").lower(), r)
                       for r in rows],
        }
        _cache["items"] = snap
    return snap


def customers_snapshot():
    """Same idea as items_snapshot(), for the customer autocomplete."""
    snap = _cache.get("customers")
    if snap is None:
        rows = get_all_customers()
        snap = {
            "list": rows,
            "by_id": {r["id"]: r for r in rows},
            "by_name_lc": {r["name"].lower(): r for r in rows},
        }
        _cache["customers"] = snap
    return snap


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _upper(name):
    """Customer names are always stored in capitals, everywhere they're
    saved - typed in the app, imported from a backup, or auto-created
    from an imported bill - so the whole customers list stays consistent
    no matter which path a name came in through."""
    return (name or "").strip().upper()


# ---------------- INVENTORY TRANSACTION LOG ----------------

def _current_quantity(cur, item_id):
    """The item's quantity after a stock adjustment, or None if the item
    itself is gone.

    An item can be deleted from Inventory while an old bill still
    references it (delete_item has never guarded against this - it just
    removes the row). Adjusting stock for a since-deleted item is a
    harmless no-op, but reading its new quantity back with a bare
    fetchone()["quantity"] crashes on that None. This is what several
    call sites in this file (create_bill, update_bill, delete_bill,
    delete_all_bills) used to do directly.
    """
    row = cur.execute("SELECT quantity FROM items WHERE id=?", (item_id,)).fetchone()
    return row["quantity"] if row is not None else None


def _log_inventory_transaction(cur, item_id, item_name, change_type, quantity_change,
                                resulting_quantity=None, reference="", notes=""):
    cur.execute("""
        INSERT INTO inventory_transactions
            (item_id, item_name, change_type, quantity_change, resulting_quantity, reference, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (item_id, item_name, change_type, quantity_change, resulting_quantity, reference, notes, now_str()))


def get_inventory_transactions(search=None, item_id=None, date_from=None, date_to=None, limit=500):
    conn = get_connection()
    query = "SELECT * FROM inventory_transactions WHERE 1=1"
    params = []
    if search:
        query += " AND (item_name LIKE ? OR reference LIKE ? OR change_type LIKE ?)"
        params += [f"%{search}%", f"%{search}%", f"%{search}%"]
    if item_id:
        query += " AND item_id = ?"
        params.append(item_id)
    if date_from:
        query += " AND date(created_at) >= ?"
        params.append(date_from)
    if date_to:
        query += " AND date(created_at) <= ?"
        params.append(date_to)
    query += " ORDER BY id DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def clear_inventory_transactions():
    conn = get_connection()
    try:
        conn.execute("DELETE FROM inventory_transactions")
        conn.commit()
    finally:
        conn.close()


# ---------------- SETTINGS ----------------

def get_setting(key, default=""):
    conn = get_connection()
    row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    conn.close()
    return row["value"] if row else default

def set_setting(key, value):
    conn = get_connection()
    conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))
    conn.commit()
    conn.close()

def get_next_bill_number():
    """Preview of the next bill number (used by the UI before a bill is
    actually saved). Plain 8-digit, zero-padded (e.g. "00000001") - no
    prefix, since a single always-unique counter needs nothing else to
    stay unambiguous, and 8 digits gives 100 million bill numbers before
    running out (at 1,000 bills/day that's over 270,000 years).
    Self-healing: if the stored counter would produce a number that's
    already used by an existing bill - e.g. an old backup's settings got
    re-imported and rolled the counter back - this keeps checking forward
    until it finds one that's genuinely free, so the preview always
    matches what create_bill() will actually assign. Read-only: doesn't
    persist anything, since nothing's been saved yet."""
    conn = get_connection()
    seq = int(conn.execute("SELECT value FROM settings WHERE key='next_bill_seq'").fetchone()["value"])
    candidate = f"{seq:08d}"
    while conn.execute("SELECT 1 FROM bills WHERE bill_number=?", (candidate,)).fetchone():
        seq += 1
        candidate = f"{seq:08d}"
    conn.close()
    return candidate

def advance_bill_sequence():
    conn = get_connection()
    seq = int(conn.execute("SELECT value FROM settings WHERE key='next_bill_seq'").fetchone()["value"])
    conn.execute("UPDATE settings SET value=? WHERE key='next_bill_seq'", (str(seq + 1),))
    conn.commit()
    conn.close()


# ---------------- ITEMS (INVENTORY) ----------------

def add_item(item_code, name, category, unit, price, quantity, low_stock_threshold=5,
             pack_size=None, pack_unit_name=""):
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO items (item_code, name, category, unit, price, quantity, low_stock_threshold,
                            pack_size, pack_unit_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (item_code, name, category, unit, price, quantity, low_stock_threshold,
          pack_size, (pack_unit_name or "").strip(), now_str(), now_str()))
    item_id = cur.lastrowid
    if quantity:
        _log_inventory_transaction(cur, item_id, name, "Item Created", quantity,
                                    resulting_quantity=quantity, notes="Initial stock on item creation")
    conn.commit()
    bump("items")
    conn.close()
    return item_id

def update_item(item_id, item_code, name, category, unit, price, quantity, low_stock_threshold,
                 pack_size=None, pack_unit_name=""):
    conn = get_connection()
    cur = conn.cursor()
    old = cur.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
    cur.execute("""
        UPDATE items SET item_code=?, name=?, category=?, unit=?, price=?, quantity=?, low_stock_threshold=?,
                          pack_size=?, pack_unit_name=?, updated_at=?
        WHERE id=?
    """, (item_code, name, category, unit, price, quantity, low_stock_threshold,
          pack_size, (pack_unit_name or "").strip(), now_str(), item_id))
    if old is not None:
        diff = quantity - old["quantity"]
        if abs(diff) > 1e-9:
            _log_inventory_transaction(cur, item_id, name, "Manual Adjustment", diff,
                                        resulting_quantity=quantity, notes="Edited via Inventory tab")
    conn.commit()
    bump("items")
    conn.close()

def delete_item(item_id):
    conn = get_connection()
    cur = conn.cursor()
    old = cur.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
    if old is not None:
        _log_inventory_transaction(cur, item_id, old["name"], "Item Deleted", -old["quantity"],
                                    resulting_quantity=0, notes="Item removed from inventory")
    cur.execute("DELETE FROM items WHERE id=?", (item_id,))
    conn.commit()
    bump("items")
    conn.close()

def adjust_item_stock(item_id, delta, change_type="Manual Adjustment", reference="", notes=""):
    if item_id is None:
        return
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("UPDATE items SET quantity = quantity + ?, updated_at=? WHERE id=?",
                (delta, now_str(), item_id))
    row = cur.execute("SELECT name, quantity FROM items WHERE id=?", (item_id,)).fetchone()
    if row is not None:
        _log_inventory_transaction(cur, item_id, row["name"], change_type, delta,
                                    resulting_quantity=row["quantity"], reference=reference, notes=notes)
    conn.commit()
    bump("items")
    conn.close()

def get_all_items(search=None):
    conn = get_connection()
    if search:
        rows = conn.execute(
            "SELECT * FROM items WHERE item_code LIKE ? OR name LIKE ? OR category LIKE ? ORDER BY name",
            (f"%{search}%", f"%{search}%", f"%{search}%")
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM items ORDER BY name").fetchall()
    conn.close()
    return [dict(r) for r in rows]

def reset_all_item_quantities():
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SELECT id, name, quantity FROM items")
    items = cur.fetchall()
    for item in items:
        if item[2] != 0:
            cur.execute("UPDATE items SET quantity = 0, updated_at=? WHERE id=?", (now_str(), item[0]))
            _log_inventory_transaction(
                cur,
                item[0],
                item[1],
                "Inventory Reset",
                -item[2],
                resulting_quantity=0,
                notes="Bulk reset all quantities to zero"
            )
    conn.commit()
    bump("items")
    conn.close()

def get_item(item_id):
    conn = get_connection()
    row = conn.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
    conn.close()
    return dict(row) if row else None

def get_low_stock_items():
    conn = get_connection()
    rows = conn.execute("SELECT * FROM items WHERE quantity <= low_stock_threshold ORDER BY quantity ASC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ---------------- CUSTOMERS ----------------

def add_customer(name, phone, address, notes=""):
    conn = get_connection()
    cur = conn.execute("INSERT INTO customers (name, phone, address, notes, created_at) VALUES (?, ?, ?, ?, ?)",
                        (_upper(name), phone, _upper(address), notes, now_str()))
    conn.commit()
    bump("customers")
    cid = cur.lastrowid
    conn.close()
    return cid

def update_customer(customer_id, name, phone, address, notes):
    conn = get_connection()
    conn.execute("UPDATE customers SET name=?, phone=?, address=?, notes=? WHERE id=?",
                 (_upper(name), phone, _upper(address), notes, customer_id))
    conn.commit()
    bump("customers")
    conn.close()

def delete_customer(customer_id):
    conn = get_connection()
    conn.execute("DELETE FROM customers WHERE id=?", (customer_id,))
    conn.commit()
    bump("customers")
    conn.close()

def get_all_customers(search=None):
    conn = get_connection()
    if search:
        rows = conn.execute(
            "SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? ORDER BY name",
            (f"%{search}%", f"%{search}%")
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM customers ORDER BY name").fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_customer(customer_id):
    conn = get_connection()
    row = conn.execute("SELECT * FROM customers WHERE id=?", (customer_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


# ---------------- KHATA / LEDGER LOGIC ----------------

def get_customer_balance(customer_id):
    """Calculates the real-time outstanding balance (Total Debits - Total Credits)"""
    conn = get_connection()
    row = conn.execute("""
        SELECT COALESCE(SUM(debit) - SUM(credit), 0) as balance 
        FROM customer_ledger 
        WHERE customer_id=?
    """, (customer_id,)).fetchone()
    conn.close()
    return row["balance"]

def get_customer_ledger(customer_id):
    """Fetches the full passbook history with a running balance."""
    conn = get_connection()
    rows = conn.execute("""
        SELECT * FROM customer_ledger 
        WHERE customer_id=? 
        ORDER BY date(transaction_date) ASC, id ASC
    """, (customer_id,)).fetchall()
    
    ledger = []
    running_balance = 0
    for r in rows:
        d = dict(r)
        running_balance += (d['debit'] - d['credit'])
        d['balance'] = running_balance
        ledger.append(d)
    
    # Reverse so the newest transactions are at the top of the UI
    ledger.reverse()
    conn.close()
    return ledger

def add_ledger_payment(customer_id, amount, reference="", notes=""):
    """Manually adds a payment to the customer's ledger."""
    conn = get_connection()
    conn.execute("""
        INSERT INTO customer_ledger (customer_id, transaction_date, transaction_type, reference, debit, credit, notes, created_at) 
        VALUES (?, ?, 'Payment', ?, 0, ?, ?, ?)
    """, (customer_id, now_str(), reference, amount, notes, now_str()))
    conn.commit()
    conn.close()


# ---------------- BILLS ----------------

def create_bill(customer_id, customer_name, customer_phone, customer_address,
                 bill_date, bill_time, freight_charges, discount, amount_paid, items, notes="",
                 deduct_stock=True, bill_type="sale"):
    """bill_type "sale" deducts each item's quantity from stock, as this
    always has. "purchase" adds it instead - stock coming IN, e.g.
    recording what a supplier delivered - using this same screen and bill
    number sequence rather than a separate workflow."""
    bill_type = bill_type if bill_type in ("sale", "purchase") else "sale"
    stock_sign = -1 if bill_type == "sale" else 1
    conn = get_connection()
    cur = conn.cursor()

    try:
        # BEGIN IMMEDIATE grabs the write lock right here, before the
        # counter is even read. Without this, two bills saved at the same
        # moment (two js_api calls each get their own connection and run
        # on their own thread) can both read the same next_bill_seq value,
        # both compute the same bill_number, and the second INSERT then
        # fails with "UNIQUE constraint failed: bills.bill_number" -
        # reproduced under concurrent load in scratch/stress_sqlite.py.
        # Holding the write lock for the rest of this function makes the
        # read-check-insert-advance sequence atomic across connections.
        conn.execute("BEGIN IMMEDIATE")
        seq = int(cur.execute("SELECT value FROM settings WHERE key='next_bill_seq'").fetchone()["value"])
        bill_number = f"{seq:08d}"
        # Self-heal: never trust the counter blindly - if this number is
        # somehow already taken (e.g. the counter got rolled back by an
        # old settings import), keep advancing until we find one that's
        # actually free. Two different bills can then never collide.
        while cur.execute("SELECT 1 FROM bills WHERE bill_number=?", (bill_number,)).fetchone():
            seq += 1
            bill_number = f"{seq:08d}"

        subtotal = sum(it["final_price"] for it in items)
        total = subtotal + (freight_charges or 0) - (discount or 0)

        cur.execute("""
            INSERT INTO bills (bill_number, customer_id, customer_name, customer_phone, customer_address,
                                bill_date, bill_time, freight_charges, discount, subtotal, total, amount_paid, notes, bill_type, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (bill_number, customer_id, _upper(customer_name), customer_phone, _upper(customer_address),
              bill_date, bill_time, freight_charges, discount, subtotal, total, amount_paid, notes, bill_type, now_str(), now_str()))
        bill_id = cur.lastrowid

        # Add items to bill and adjust stock
        for it in items:
            cur.execute("""
                INSERT INTO bill_items (bill_id, item_id, item_name, quantity, price_per_unit, final_price,
                                         pack_qty, pack_unit_name, pack_size)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (bill_id, it.get("item_id"), it["item_name"], it["quantity"], it["price_per_unit"], it["final_price"],
                  it.get("pack_qty"), it.get("pack_unit_name") or "", it.get("pack_size")))
            if deduct_stock and it.get("item_id"):
                cur.execute("UPDATE items SET quantity = quantity + ?, updated_at=? WHERE id=?",
                            (stock_sign * it["quantity"], now_str(), it["item_id"]))
                new_qty = _current_quantity(cur, it["item_id"])
                _log_inventory_transaction(
                    cur, it["item_id"], it["item_name"],
                    "Sale" if bill_type == "sale" else "Purchase",
                    stock_sign * it["quantity"],
                    resulting_quantity=new_qty, reference=bill_number)

        # Automatically Update the Khata/Ledger. A purchase bill's
        # "customer" field is really whoever supplied the stock - the
        # khata models what a customer owes the shop, which does not
        # apply here, so a purchase writes no ledger entry at all rather
        # than one that reads backwards.
        if bill_type == "sale":
            if total > 0:
                cur.execute("""
                    INSERT INTO customer_ledger (customer_id, transaction_date, transaction_type, reference, debit, credit, created_at)
                    VALUES (?, ?, 'Invoice', ?, ?, 0, ?)
                """, (customer_id, f"{bill_date} {bill_time}", bill_number, total, now_str()))

            if amount_paid > 0:
                cur.execute("""
                    INSERT INTO customer_ledger (customer_id, transaction_date, transaction_type, reference, debit, credit, notes, created_at)
                    VALUES (?, ?, 'Payment', ?, 0, ?, ?, ?)
                """, (customer_id, f"{bill_date} {bill_time}", f"Payment for {bill_number}", amount_paid, "Paid at checkout", now_str()))

        cur.execute("UPDATE settings SET value=? WHERE key='next_bill_seq'", (str(seq + 1),))

        conn.commit()
        bump("items", "bills")
        return bill_id, bill_number
    finally:
        conn.close()

def update_bill(bill_id, customer_id, customer_name, customer_phone, customer_address,
                 bill_date, bill_time, freight_charges, discount, amount_paid, items, notes="",
                 restock_old=True, bill_type="sale"):
    """The bill's stock effect can flip between sale and purchase across
    an edit (the toggle stays changeable while editing), so the OLD
    items are reversed using the bill's stored (old) type, and the NEW
    items are applied using `bill_type`, independently of each other."""
    bill_type = bill_type if bill_type in ("sale", "purchase") else "sale"
    new_sign = -1 if bill_type == "sale" else 1
    conn = get_connection()
    cur = conn.cursor()

    try:
        bill_row = cur.execute("SELECT bill_number, bill_type FROM bills WHERE id=?", (bill_id,)).fetchone()
        bill_number = bill_row["bill_number"] if bill_row else ""
        old_type = (bill_row["bill_type"] if bill_row and bill_row["bill_type"] in ("sale", "purchase")
                   else "sale")
        # Reversing an old line item undoes whatever it originally did:
        # a sale (-qty) is reversed by adding it back, a purchase (+qty)
        # by taking it back out.
        undo_sign = 1 if old_type == "sale" else -1

        if restock_old:
            old_items = cur.execute("SELECT * FROM bill_items WHERE bill_id=?", (bill_id,)).fetchall()
            for oi in old_items:
                if oi["item_id"]:
                    cur.execute("UPDATE items SET quantity = quantity + ?, updated_at=? WHERE id=?",
                                (undo_sign * oi["quantity"], now_str(), oi["item_id"]))
                    new_qty = _current_quantity(cur, oi["item_id"])
                    _log_inventory_transaction(
                        cur, oi["item_id"], oi["item_name"],
                        "Bill Edit (Restock)" if old_type == "sale" else "Bill Edit (Purchase Reversed)",
                        undo_sign * oi["quantity"], resulting_quantity=new_qty, reference=bill_number,
                        notes="Old line item removed before applying edit")

        cur.execute("DELETE FROM bill_items WHERE bill_id=?", (bill_id,))

        # Erase old ledger entries associated with this specific bill to recreate them cleanly
        cur.execute("DELETE FROM customer_ledger WHERE reference = ? OR reference = ?", (bill_number, f"Payment for {bill_number}"))

        subtotal = sum(it["final_price"] for it in items)
        total = subtotal + (freight_charges or 0) - (discount or 0)

        cur.execute("""
            UPDATE bills SET customer_id=?, customer_name=?, customer_phone=?, customer_address=?,
                              bill_date=?, bill_time=?, freight_charges=?, discount=?, subtotal=?, total=?, amount_paid=?, notes=?, bill_type=?, updated_at=?
            WHERE id=?
        """, (customer_id, _upper(customer_name), customer_phone, _upper(customer_address),
              bill_date, bill_time, freight_charges, discount, subtotal, total, amount_paid, notes, bill_type, now_str(), bill_id))

        for it in items:
            cur.execute("""
                INSERT INTO bill_items (bill_id, item_id, item_name, quantity, price_per_unit, final_price,
                                         pack_qty, pack_unit_name, pack_size)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (bill_id, it.get("item_id"), it["item_name"], it["quantity"], it["price_per_unit"], it["final_price"],
                  it.get("pack_qty"), it.get("pack_unit_name") or "", it.get("pack_size")))
            if it.get("item_id"):
                cur.execute("UPDATE items SET quantity = quantity + ?, updated_at=? WHERE id=?",
                            (new_sign * it["quantity"], now_str(), it["item_id"]))
                new_qty = _current_quantity(cur, it["item_id"])
                _log_inventory_transaction(
                    cur, it["item_id"], it["item_name"],
                    "Bill Edit (Sale)" if bill_type == "sale" else "Bill Edit (Purchase)",
                    new_sign * it["quantity"], resulting_quantity=new_qty, reference=bill_number,
                    notes="New/updated line item applied")

        # Recreate the Khata/Ledger entries for the updated amounts - see
        # create_bill for why a purchase writes none at all.
        if bill_type == "sale":
            if total > 0:
                cur.execute("""
                    INSERT INTO customer_ledger (customer_id, transaction_date, transaction_type, reference, debit, credit, created_at)
                    VALUES (?, ?, 'Invoice', ?, ?, 0, ?)
                """, (customer_id, f"{bill_date} {bill_time}", bill_number, total, now_str()))

            if amount_paid > 0:
                cur.execute("""
                    INSERT INTO customer_ledger (customer_id, transaction_date, transaction_type, reference, debit, credit, notes, created_at)
                    VALUES (?, ?, 'Payment', ?, 0, ?, ?, ?)
                """, (customer_id, f"{bill_date} {bill_time}", f"Payment for {bill_number}", amount_paid, "Paid at checkout", now_str()))

        conn.commit()
        bump("items", "bills")
    finally:
        conn.close()

def delete_all_bills(restock=True):
    """Same reversal rule as delete_bill, applied per bill: a sale's
    quantities are added back, a purchase's are taken back out."""
    conn = get_connection()
    cur = conn.cursor()

    try:
        bills = cur.execute("SELECT id, bill_number, bill_type FROM bills ORDER BY id").fetchall()

        for bill in bills:
            bill_id = bill["id"]
            bill_number = bill["bill_number"]
            bill_type = (bill["bill_type"] if bill["bill_type"] in ("sale", "purchase") else "sale")
            undo_sign = 1 if bill_type == "sale" else -1
            if restock:
                old_items = cur.execute("SELECT * FROM bill_items WHERE bill_id=?", (bill_id,)).fetchall()
                for oi in old_items:
                    if oi["item_id"]:
                        cur.execute("UPDATE items SET quantity = quantity + ?, updated_at=? WHERE id=?",
                                    (undo_sign * oi["quantity"], now_str(), oi["item_id"]))
                        new_qty = _current_quantity(cur, oi["item_id"])
                        _log_inventory_transaction(
                            cur, oi["item_id"], oi["item_name"],
                            "Bill Deleted (Restock)" if bill_type == "sale" else "Bill Deleted (Purchase Reversed)",
                            undo_sign * oi["quantity"], resulting_quantity=new_qty, reference=bill_number)

            if bill_number:
                cur.execute("DELETE FROM customer_ledger WHERE reference = ? OR reference = ?", (bill_number, f"Payment for {bill_number}"))

        cur.execute("DELETE FROM bills")
        conn.commit()
        bump("items", "bills")
    finally:
        conn.close()


def delete_bill(bill_id, restock=True):
    """restock undoes whatever the bill originally did to stock: a sale
    is undone by adding its quantities back, a purchase by taking them
    back out - deleting a purchase must not leave stock it never
    actually received."""
    conn = get_connection()
    cur = conn.cursor()

    try:
        bill_row = cur.execute("SELECT bill_number, bill_type FROM bills WHERE id=?", (bill_id,)).fetchone()
        bill_number = bill_row["bill_number"] if bill_row else ""
        bill_type = (bill_row["bill_type"] if bill_row and bill_row["bill_type"] in ("sale", "purchase")
                    else "sale")
        undo_sign = 1 if bill_type == "sale" else -1
        if restock:
            old_items = cur.execute("SELECT * FROM bill_items WHERE bill_id=?", (bill_id,)).fetchall()
            for oi in old_items:
                if oi["item_id"]:
                    cur.execute("UPDATE items SET quantity = quantity + ?, updated_at=? WHERE id=?",
                                (undo_sign * oi["quantity"], now_str(), oi["item_id"]))
                    new_qty = _current_quantity(cur, oi["item_id"])
                    _log_inventory_transaction(
                        cur, oi["item_id"], oi["item_name"],
                        "Bill Deleted (Restock)" if bill_type == "sale" else "Bill Deleted (Purchase Reversed)",
                        undo_sign * oi["quantity"], resulting_quantity=new_qty, reference=bill_number)
        
        # Remove associated ledger entries when a bill is entirely deleted
        if bill_number:
            cur.execute("DELETE FROM customer_ledger WHERE reference = ? OR reference = ?", (bill_number, f"Payment for {bill_number}"))

        cur.execute("DELETE FROM bills WHERE id=?", (bill_id,))
        conn.commit()
        bump("items", "bills")
    finally:
        conn.close()

def get_bill_items(bill_id):
    conn = get_connection()
    rows = conn.execute("SELECT * FROM bill_items WHERE bill_id=? ORDER BY id", (bill_id,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_bill(bill_id):
    conn = get_connection()
    row = conn.execute("SELECT * FROM bills WHERE id=?", (bill_id,)).fetchone()
    conn.close()
    if not row:
        return None
    bill = dict(row)
    bill["items"] = get_bill_items(bill_id)
    return bill

def get_bill_by_number(bill_number):
    conn = get_connection()
    row = conn.execute("SELECT * FROM bills WHERE bill_number=?", (bill_number,)).fetchone()
    conn.close()
    if not row:
        return None
    bill = dict(row)
    bill["items"] = get_bill_items(bill["id"])
    return bill

def get_all_bills(search=None, date_from=None, date_to=None):
    conn = get_connection()
    query = "SELECT * FROM bills WHERE 1=1"
    params = []
    if search:
        query += " AND (bill_number LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)"
        params += [f"%{search}%", f"%{search}%", f"%{search}%"]
    if date_from:
        query += " AND bill_date >= ?"
        params.append(date_from)
    if date_to:
        query += " AND bill_date <= ?"
        params.append(date_to)
    query += " ORDER BY id DESC"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]

# ---------------- ANALYTICS ----------------

def get_sales_summary(date_from=None, date_to=None):
    conn = get_connection()
    # bill_type='sale' - a purchase bill is stock coming in, not revenue,
    # and must not inflate what this shop sold.
    query = "SELECT COUNT(*) as bill_count, COALESCE(SUM(total),0) as total_sales, " \
            "COALESCE(SUM(freight_charges),0) as total_freight FROM bills WHERE bill_type = 'sale'"
    params = []
    if date_from:
        query += " AND bill_date >= ?"
        params.append(date_from)
    if date_to:
        query += " AND bill_date <= ?"
        params.append(date_to)
    row = conn.execute(query, params).fetchone()
    conn.close()
    return dict(row)

def get_top_selling_items(limit=10, date_from=None, date_to=None):
    conn = get_connection()
    query = """
        SELECT bi.item_name, SUM(bi.quantity) as total_qty, SUM(bi.final_price) as total_revenue
        FROM bill_items bi
        JOIN bills b ON bi.bill_id = b.id
        WHERE b.bill_type = 'sale'
    """
    params = []
    if date_from:
        query += " AND b.bill_date >= ?"
        params.append(date_from)
    if date_to:
        query += " AND b.bill_date <= ?"
        params.append(date_to)
    query += " GROUP BY bi.item_name ORDER BY total_revenue DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_sales_by_date(date_from=None, date_to=None):
    conn = get_connection()
    query = "SELECT bill_date, SUM(total) as day_total FROM bills WHERE bill_type = 'sale'"
    params = []
    if date_from:
        query += " AND bill_date >= ?"
        params.append(date_from)
    if date_to:
        query += " AND bill_date <= ?"
        params.append(date_to)
    query += " GROUP BY bill_date ORDER BY bill_date"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_top_customers(limit=10, date_from=None, date_to=None):
    conn = get_connection()
    query = "SELECT customer_name, COUNT(*) as bill_count, SUM(total) as total_spent FROM bills WHERE bill_type = 'sale'"
    params = []
    if date_from:
        query += " AND bill_date >= ?"
        params.append(date_from)
    if date_to:
        query += " AND bill_date <= ?"
        params.append(date_to)
    query += " GROUP BY customer_name ORDER BY total_spent DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ---------------- CUSTOMER ANALYTICS (NEW) ----------------

def get_customer_kpis(customer_id):
    # bill_type='sale': a purchase bill's "customer" slot is really the
    # supplier the stock came from, and must not count toward what this
    # customer bought.
    conn = get_connection()
    row = conn.execute("""
        SELECT COUNT(id) as total_bills,
               COALESCE(SUM(total), 0) as total_spent,
               MAX(bill_date) as last_purchase_date
        FROM bills
        WHERE customer_id = ? AND bill_type = 'sale'
    """, (customer_id,)).fetchone()
    conn.close()

    kpis = dict(row)
    kpis["avg_order_value"] = kpis["total_spent"] / kpis["total_bills"] if kpis["total_bills"] > 0 else 0
    return kpis

def get_customer_bills(customer_id):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM bills WHERE customer_id = ? AND bill_type = 'sale' ORDER BY id DESC",
        (customer_id,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_customer_purchased_items(customer_id):
    conn = get_connection()
    rows = conn.execute("""
        SELECT DISTINCT bi.item_name
        FROM bill_items bi
        JOIN bills b ON bi.bill_id = b.id
        WHERE b.customer_id = ? AND b.bill_type = 'sale'
        ORDER BY bi.item_name
    """, (customer_id,)).fetchall()
    conn.close()
    return [r["item_name"] for r in rows]

def get_customer_product_history(customer_id, item_name):
    conn = get_connection()
    rows = conn.execute("""
        SELECT b.bill_date, b.bill_number, bi.quantity, bi.price_per_unit, bi.final_price
        FROM bill_items bi
        JOIN bills b ON bi.bill_id = b.id
        WHERE b.customer_id = ? AND bi.item_name = ? AND b.bill_type = 'sale'
        ORDER BY b.id DESC
    """, (customer_id, item_name)).fetchall()
    conn.close()
    return [dict(r) for r in rows]

# ---------------- USER ACCOUNTS, LOGIN & AUDIT TRAIL ----------------
# Added during the security hardening pass. See security.py for the
# hashing scheme and the permission model; this module owns only the
# storage and the lockout bookkeeping.

def track_stock():
    """Whether this shop counts stock. See the setting default above."""
    return get_setting("track_stock", "0") == "1"


def set_track_stock(enabled):
    set_setting("track_stock", "1" if enabled else "0")


def track_khata():
    """Whether this shop uses the credit ledger. See the setting default above."""
    return get_setting("track_khata", "0") == "1"


def set_track_khata(enabled):
    set_setting("track_khata", "1" if enabled else "0")


def is_auth_enabled():
    """Whether the app requires a login. Stored as a setting so that an
    existing installation upgrades to the new version with authentication
    switched OFF and behaving exactly as before, until the owner turns it
    on deliberately."""
    return get_setting("auth_enabled", "0") == "1" and count_users() > 0


def set_auth_enabled(enabled):
    set_setting("auth_enabled", "1" if enabled else "0")


def count_users(active_only=True):
    conn = get_connection()
    q = "SELECT COUNT(*) AS n FROM users" + (" WHERE is_active=1" if active_only else "")
    n = conn.execute(q).fetchone()["n"]
    conn.close()
    return n


def count_owners():
    """Used to refuse the last owner being deleted or demoted - an app
    with no owner has no way to reach settings, users or backups again."""
    conn = get_connection()
    n = conn.execute(
        "SELECT COUNT(*) AS n FROM users WHERE role='owner' AND is_active=1"
    ).fetchone()["n"]
    conn.close()
    return n


def list_users():
    conn = get_connection()
    rows = conn.execute("""
        SELECT id, username, display_name, role, is_active, last_login, locked_until, created_at
        FROM users ORDER BY role DESC, username
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_user_by_username(username):
    conn = get_connection()
    row = conn.execute("SELECT * FROM users WHERE username = ? COLLATE NOCASE",
                       ((username or "").strip(),)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_user(user_id):
    conn = get_connection()
    row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def create_user(username, password, role, display_name="", recovery_code=None):
    """Stores a new account. The password is hashed here and the plaintext
    is never written anywhere - not to the row, not to the audit log."""
    import security

    username = (username or "").strip()
    if not username:
        raise ValueError("A username is required.")
    if role not in security.ROLES:
        raise ValueError("Unknown role.")

    recovery_hash = security.hash_password(recovery_code) if recovery_code else ""

    conn = get_connection()
    try:
        cur = conn.execute("""
            INSERT INTO users (username, display_name, password_hash, role, is_active,
                               recovery_hash, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, ?, ?)
        """, (username, (display_name or username).strip(), security.hash_password(password),
              role, recovery_hash, now_str(), now_str()))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def set_user_password(user_id, new_password):
    import security
    conn = get_connection()
    conn.execute("""
        UPDATE users SET password_hash=?, must_change_password=0, failed_attempts=0,
                         lockout_count=0, locked_until='', updated_at=?
        WHERE id=?
    """, (security.hash_password(new_password), now_str(), user_id))
    conn.commit()
    conn.close()


def update_user(user_id, display_name=None, role=None, is_active=None):
    """Partial update. Refuses to remove the last active owner - the check
    lives here rather than only in the dialog, so no future caller can
    skip it and strand the installation with no way back into settings."""
    current = get_user(user_id)
    if not current:
        raise ValueError("That user no longer exists.")

    new_role = role if role is not None else current["role"]
    new_active = current["is_active"] if is_active is None else (1 if is_active else 0)

    losing_owner = (current["role"] == "owner" and current["is_active"] == 1
                    and (new_role != "owner" or new_active == 0))
    if losing_owner and count_owners() <= 1:
        raise ValueError(
            "This is the only owner account. Create another owner first, "
            "otherwise nobody will be able to reach Settings, backups or user accounts."
        )

    conn = get_connection()
    conn.execute("""
        UPDATE users SET display_name=?, role=?, is_active=?, updated_at=? WHERE id=?
    """, (
        (display_name if display_name is not None else current["display_name"]).strip(),
        new_role, new_active, now_str(), user_id,
    ))
    conn.commit()
    conn.close()


def delete_user(user_id):
    current = get_user(user_id)
    if not current:
        return
    if current["role"] == "owner" and current["is_active"] == 1 and count_owners() <= 1:
        raise ValueError(
            "This is the only owner account and cannot be deleted. "
            "Create another owner account first."
        )
    conn = get_connection()
    conn.execute("DELETE FROM users WHERE id=?", (user_id,))
    conn.commit()
    conn.close()


def _clear_lockout(conn, user_id):
    conn.execute("UPDATE users SET failed_attempts=0, locked_until='' WHERE id=?", (user_id,))


def authenticate(username, password):
    """Returns (user_dict_or_None, message).

    Rate limiting: the failed-attempt count and the lock expiry live in
    the database, not in memory, so closing and reopening the app does not
    reset them. The lockout window grows with each repeated lockout (see
    security.LOCKOUT_ESCALATION).

    The message for an unknown username is identical to the message for a
    wrong password, so the login screen cannot be used to discover which
    usernames exist. A dummy hash verification runs in the unknown-user
    case so that the two paths also take a similar amount of time.
    """
    import security
    from datetime import datetime as _dt

    username = (username or "").strip()
    generic = "Incorrect username or password."

    user = get_user_by_username(username)
    if not user or not user["is_active"]:
        # Comparable work regardless of whether the account exists.
        security.verify_password(password or "x", security.hash_password("dummy", iterations=1000))
        log_audit("login.failed", "Unknown or disabled account", outcome="denied",
                  as_username=username[:40])
        return None, generic

    locked_until = user.get("locked_until") or ""
    if locked_until:
        try:
            until = _dt.strptime(locked_until, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            until = None
        if until and until > _dt.now():
            remaining = security.format_remaining(until - _dt.now())
            return None, ("This account is temporarily locked after too many failed attempts.\n\n"
                          "Try again in " + remaining + ".")

    if security.verify_password(password, user["password_hash"]):
        conn = get_connection()
        try:
            _clear_lockout(conn, user["id"])
            conn.execute("UPDATE users SET lockout_count=0, last_login=? WHERE id=?",
                         (now_str(), user["id"]))
            # Transparently upgrade a hash made with an older cost factor,
            # which is only possible here, while the plaintext is in hand.
            if security.needs_rehash(user["password_hash"]):
                conn.execute("UPDATE users SET password_hash=? WHERE id=?",
                             (security.hash_password(password), user["id"]))
            conn.commit()
        finally:
            conn.close()
        log_audit("login.success", "Signed in as " + user["role"],
                  as_username=user["username"], as_role=user["role"])
        return get_user(user["id"]), ""

    # --- failed attempt ---
    attempts = (user["failed_attempts"] or 0) + 1
    conn = get_connection()
    try:
        if attempts >= security.MAX_FAILED_ATTEMPTS:
            lockout_count = user["lockout_count"] or 0
            until = _dt.now() + security.lockout_duration(lockout_count)
            conn.execute("""
                UPDATE users SET failed_attempts=0, lockout_count=?, locked_until=? WHERE id=?
            """, (lockout_count + 1, until.strftime("%Y-%m-%d %H:%M:%S"), user["id"]))
            conn.commit()
            wait = security.format_remaining(until - _dt.now())
            log_audit("login.locked", "Account locked for " + wait + " after repeated failures",
                      outcome="denied", as_username=user["username"])
            return None, "Too many failed attempts. This account is locked for " + wait + "."
        conn.execute("UPDATE users SET failed_attempts=? WHERE id=?", (attempts, user["id"]))
        conn.commit()
    finally:
        conn.close()

    left = security.MAX_FAILED_ATTEMPTS - attempts
    log_audit("login.failed", "Wrong password", outcome="denied", as_username=user["username"])
    plural = "s" if left != 1 else ""
    return None, generic + "\n\n" + str(left) + " attempt" + plural + " left before the account is locked."


def verify_recovery_code(username, code):
    """Owner-only fallback for a forgotten password, using the one-time
    code shown when the account was created. Consumes the code on success
    so a written-down code cannot be reused by whoever finds the paper."""
    import security
    user = get_user_by_username(username)
    if not user or not user.get("recovery_hash"):
        return None
    if not security.verify_password(security.normalize_recovery_code(code), user["recovery_hash"]):
        log_audit("recovery.failed", "Wrong recovery code", outcome="denied", as_username=username)
        return None
    conn = get_connection()
    conn.execute("UPDATE users SET recovery_hash='', failed_attempts=0, lockout_count=0, "
                 "locked_until='' WHERE id=?", (user["id"],))
    conn.commit()
    conn.close()
    log_audit("recovery.used", "Password reset using recovery code", as_username=username)
    return get_user(user["id"])


# ---------------- AUDIT LOG ----------------

def log_audit(action, detail="", outcome="ok", as_username=None, as_role=None):
    """Appends one line to the activity trail.

    Written with its own connection and never raises: an audit failure
    must not be able to abort the business action it was recording, and
    must not be able to crash the app either.
    """
    try:
        import security
        username = as_username if as_username is not None else (security.current.username or "")
        role = as_role if as_role is not None else (security.current.role or "")
    except Exception:
        username, role = as_username or "", as_role or ""

    try:
        conn = get_connection()
        conn.execute("""
            INSERT INTO audit_log (created_at, username, role, action, detail, outcome)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (now_str(), str(username)[:60], str(role)[:20], str(action)[:60],
              str(detail)[:500], str(outcome)[:20]))
        conn.commit()
        conn.close()
    except Exception:
        pass


def get_audit_log(search=None, limit=500):
    conn = get_connection()
    query = "SELECT * FROM audit_log WHERE 1=1"
    params = []
    if search:
        query += " AND (username LIKE ? OR action LIKE ? OR detail LIKE ?)"
        params += [f"%{search}%", f"%{search}%", f"%{search}%"]
    query += " ORDER BY id DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def prune_audit_log(keep_days=365):
    """Keeps the trail from growing without bound. A year is well past any
    practical dispute about a bill, and the rows are tiny."""
    conn = get_connection()
    conn.execute("DELETE FROM audit_log WHERE date(created_at) < date('now', ?)",
                 (f"-{int(keep_days)} days",))
    conn.commit()
    conn.close()


# ---------------- STOCK AVAILABILITY ----------------

def get_stock_levels(item_ids):
    """Current stock for a set of items in one query, used by the bill
    editor to warn before a sale takes an item negative."""
    ids = [i for i in (item_ids or []) if i]
    if not ids:
        return {}
    conn = get_connection()
    q = f"SELECT id, name, quantity FROM items WHERE id IN ({','.join('?' * len(ids))})"
    rows = conn.execute(q, ids).fetchall()
    conn.close()
    return {r["id"]: {"name": r["name"], "quantity": r["quantity"]} for r in rows}


def get_total_outstanding():
    """Total money customers currently owe the shop, across every khata.

    For a shop that runs on credit this is the single most important
    number of the day and it was not shown anywhere - the dashboard
    reported sales but never how much of it was actually collected.
    """
    conn = get_connection()
    row = conn.execute("""
        SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS outstanding FROM customer_ledger
    """).fetchone()
    conn.close()
    return row["outstanding"] or 0


def get_customers_with_dues(limit=8):
    """Customers with an outstanding balance, largest first."""
    conn = get_connection()
    rows = conn.execute("""
        SELECT c.id, c.name, c.phone,
               COALESCE(SUM(l.debit) - SUM(l.credit), 0) AS balance
        FROM customers c
        JOIN customer_ledger l ON l.customer_id = c.id
        GROUP BY c.id, c.name, c.phone
        HAVING balance > 0.009
        ORDER BY balance DESC
        LIMIT ?
    """, (limit,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_bill_date_bounds():
    """Earliest and latest bill dates, so a screen showing an empty date
    range can say where the data actually is instead of just '0'."""
    conn = get_connection()
    row = conn.execute("SELECT MIN(bill_date) AS first, MAX(bill_date) AS last FROM bills").fetchone()
    conn.close()
    return (row["first"], row["last"]) if row else (None, None)


# ---------------- DASHBOARD ANALYTICS ----------------

def get_cash_vs_credit(date_from=None, date_to=None):
    """How much was billed, how much was actually collected, and how much
    went out on credit.

    For a shop running on khata this is the number that decides whether
    the drawer balances at closing, and it was not shown anywhere.
    """
    conn = get_connection()
    query = ("SELECT COALESCE(SUM(total),0) AS billed, "
             "COALESCE(SUM(amount_paid),0) AS collected, "
             "COALESCE(SUM(total - amount_paid),0) AS on_credit "
             "FROM bills WHERE bill_type = 'sale'")
    params = []
    if date_from:
        query += " AND bill_date >= ?"; params.append(date_from)
    if date_to:
        query += " AND bill_date <= ?"; params.append(date_to)
    row = conn.execute(query, params).fetchone()
    conn.close()
    result = dict(row)
    # A credit note or an overpayment can push this negative; clamp so the
    # chart never tries to draw a bar below the axis.
    result["on_credit"] = max(0.0, result["on_credit"])
    result["collected"] = max(0.0, result["collected"])
    return result


def get_sales_by_hour(date_from=None, date_to=None):
    """Bill count per hour of the day, 0-23.

    bill_time is stored as 'HH:MM', so the hour is the first two
    characters - substr is used rather than a date function because the
    column is text, not a timestamp.
    """
    conn = get_connection()
    query = ("SELECT CAST(substr(bill_time, 1, 2) AS INTEGER) AS hour, "
             "COUNT(*) AS bills, COALESCE(SUM(total),0) AS revenue "
             "FROM bills WHERE bill_time IS NOT NULL AND bill_time != '' "
             "AND bill_type = 'sale'")
    params = []
    if date_from:
        query += " AND bill_date >= ?"; params.append(date_from)
    if date_to:
        query += " AND bill_date <= ?"; params.append(date_to)
    query += " GROUP BY hour ORDER BY hour"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    buckets = {r["hour"]: dict(r) for r in rows if r["hour"] is not None}
    return [buckets.get(h, {"hour": h, "bills": 0, "revenue": 0.0})
            for h in range(24)]


def get_receivables_ageing():
    """Outstanding khata money split by how old the debt is.

    Answers the collections question - not "how much is owed" but "how
    long has it been owed", which is what decides who gets chased first.

    Ageing is per customer, on the date of their oldest unsettled invoice,
    because a running balance has no single date of its own.
    """
    conn = get_connection()
    rows = conn.execute("""
        SELECT c.id, c.name,
               COALESCE(SUM(l.debit) - SUM(l.credit), 0) AS balance,
               MIN(CASE WHEN l.debit > 0 THEN date(l.transaction_date) END) AS oldest
        FROM customers c
        JOIN customer_ledger l ON l.customer_id = c.id
        GROUP BY c.id, c.name
        HAVING balance > 0.009
    """).fetchall()
    conn.close()

    from datetime import date, datetime
    buckets = [("0-30 days", 0.0), ("31-60 days", 0.0),
               ("61-90 days", 0.0), ("Over 90 days", 0.0)]
    totals = [0.0, 0.0, 0.0, 0.0]
    today = date.today()

    for row in rows:
        try:
            oldest = datetime.strptime(row["oldest"], "%Y-%m-%d").date()
            age = (today - oldest).days
        except (TypeError, ValueError):
            age = 0
        index = 0 if age <= 30 else 1 if age <= 60 else 2 if age <= 90 else 3
        totals[index] += row["balance"]

    return [{"label": label, "amount": total}
            for (label, _), total in zip(buckets, totals)]


# ---------------- BUSINESS INTELLIGENCE ----------------
# Everything below powers the dashboard's analytics section. Two rules
# hold across all of it, and both matter for the numbers to mean what
# they say:
#
#   - bill_type='sale' everywhere. A purchase bill is stock coming in
#     from a supplier, not trade; counting it would inflate every figure
#     a shopkeeper reads as "what I sold".
#   - the date window is the dashboard's own range filter, passed
#     straight through, so every chart on the screen is describing the
#     same period.


def _date_window(query, params, date_from, date_to, column="bill_date"):
    """Appends the dashboard's date range to a query. Kept in one place
    so a new chart cannot accidentally ignore the filter."""
    if date_from:
        query += f" AND {column} >= ?"
        params.append(date_from)
    if date_to:
        query += f" AND {column} <= ?"
        params.append(date_to)
    return query, params


def get_daily_performance(date_from=None, date_to=None):
    """Revenue and bill count per calendar day, oldest first.

    Both series come from one pass so the two stacked charts can never
    disagree about a day.
    """
    conn = get_connection()
    query = ("SELECT bill_date, COALESCE(SUM(total),0) AS revenue, "
             "COUNT(*) AS bills FROM bills WHERE bill_type = 'sale'")
    query, params = _date_window(query, [], date_from, date_to)
    query += " GROUP BY bill_date ORDER BY bill_date"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_monthly_performance(date_from=None, date_to=None):
    """Revenue and bill count per calendar month ('YYYY-MM'), oldest
    first. substr rather than a date function because bill_date is text."""
    conn = get_connection()
    query = ("SELECT substr(bill_date, 1, 7) AS month, "
             "COALESCE(SUM(total),0) AS revenue, COUNT(*) AS bills "
             "FROM bills WHERE bill_type = 'sale'")
    query, params = _date_window(query, [], date_from, date_to)
    query += " GROUP BY month ORDER BY month"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_top_products(limit=20, date_from=None, date_to=None, order_by="revenue"):
    """Best sellers, ranked by revenue or by units moved.

    Both measures are returned either way, so the two side-by-side
    charts share one shape and only differ in their sort.
    """
    order = "total_qty" if order_by == "quantity" else "total_revenue"
    conn = get_connection()
    query = ("SELECT bi.item_name, COALESCE(SUM(bi.quantity),0) AS total_qty, "
             "COALESCE(SUM(bi.final_price),0) AS total_revenue "
             "FROM bill_items bi JOIN bills b ON bi.bill_id = b.id "
             "WHERE b.bill_type = 'sale'")
    query, params = _date_window(query, [], date_from, date_to, "b.bill_date")
    query += f" GROUP BY bi.item_name ORDER BY {order} DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_revenue_by_weekday(date_from=None, date_to=None):
    """Revenue and bills per weekday, Monday first.

    SQLite's strftime('%w') counts Sunday as 0; the list is rotated so
    it reads Monday-to-Sunday, which is how a trading week is read.
    """
    conn = get_connection()
    query = ("SELECT CAST(strftime('%w', bill_date) AS INTEGER) AS dow, "
             "COALESCE(SUM(total),0) AS revenue, COUNT(*) AS bills "
             "FROM bills WHERE bill_type = 'sale'")
    query, params = _date_window(query, [], date_from, date_to)
    query += " GROUP BY dow"
    rows = {r["dow"]: dict(r) for r in conn.execute(query, params).fetchall()}
    conn.close()

    names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    out = []
    for index, name in enumerate(names):
        sqlite_dow = (index + 1) % 7          # Mon(0) -> 1 ... Sun(6) -> 0
        row = rows.get(sqlite_dow, {})
        out.append({"day": name,
                    "revenue": row.get("revenue", 0.0),
                    "bills": row.get("bills", 0)})
    return out


def get_day_hour_matrix(date_from=None, date_to=None,
                        start_hour=8, end_hour=22):
    """Revenue per (weekday, hour) cell for the heatmap.

    Returns a dense 7 x N grid - every cell present, zero where nothing
    was sold - because a heatmap with holes in it is unreadable.
    """
    conn = get_connection()
    query = ("SELECT CAST(strftime('%w', bill_date) AS INTEGER) AS dow, "
             "CAST(substr(bill_time, 1, 2) AS INTEGER) AS hour, "
             "COALESCE(SUM(total),0) AS revenue, COUNT(*) AS bills "
             "FROM bills WHERE bill_type = 'sale' "
             "AND bill_time IS NOT NULL AND bill_time != ''")
    query, params = _date_window(query, [], date_from, date_to)
    query += " GROUP BY dow, hour"
    rows = conn.execute(query, params).fetchall()
    conn.close()

    hours = list(range(start_hour, end_hour + 1))
    lookup = {(r["dow"], r["hour"]): float(r["revenue"] or 0.0) for r in rows}
    grid = []
    for index in range(7):                     # Mon..Sun
        sqlite_dow = (index + 1) % 7
        grid.append([lookup.get((sqlite_dow, h), 0.0) for h in hours])
    return {"days": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
            "hours": hours, "grid": grid}


def get_customer_acquisition(date_from=None, date_to=None, granularity="day"):
    """New vs returning customers per period.

    "New" means the period contains that customer's first ever bill -
    judged against their whole history, not just the window, so a
    long-standing customer never counts as new because the filter
    happens to start after they joined.

    Walk-in bills with no customer record are excluded: there is no
    identity to say whether they came back.
    """
    period = "substr(b.bill_date, 1, 7)" if granularity == "month" else "b.bill_date"
    conn = get_connection()
    query = (
        "WITH first_bill AS ("
        "  SELECT customer_id, MIN(bill_date) AS first_date FROM bills"
        "  WHERE bill_type = 'sale' AND customer_id IS NOT NULL"
        "  GROUP BY customer_id)"
        f" SELECT {period} AS period,"
        "  COUNT(DISTINCT CASE WHEN f.first_date = b.bill_date THEN b.customer_id END) AS new_customers,"
        "  COUNT(DISTINCT CASE WHEN f.first_date < b.bill_date THEN b.customer_id END) AS returning_customers"
        " FROM bills b JOIN first_bill f ON f.customer_id = b.customer_id"
        " WHERE b.bill_type = 'sale' AND b.customer_id IS NOT NULL")
    query, params = _date_window(query, [], date_from, date_to, "b.bill_date")
    query += " GROUP BY period ORDER BY period"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]
