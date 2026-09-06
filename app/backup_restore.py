"""
backup_restore.py - Selective, additive backup/import for the Balaji Billing
& Inventory System, plus the end-of-day bill archiving workflow.

Design:
  - Backups are still plain SQLite files (openable in any SQLite browser,
    or by scan_import()/apply_import() below) but scoped to only the
    tables the user picked, not a blind copy of the whole live database.
  - Importing NEVER wipes existing data. It merges: rows that don't exist
    yet are added; rows that look like duplicates are flagged as conflicts
    for the user to resolve (skip / overwrite) - one at a time or in bulk
    via "skip all" / "overwrite all" in the UI.
  - Categories: items, customers, bills (bundles their bill_items and the
    khata/ledger entries tied to those specific bills), khata (standalone
    ledger entries not tied to an exported bill), inventory_history,
    settings.
  - "khata" (standalone) and "inventory_history" are logs: exact-duplicate
    rows are skipped automatically with no prompt, since there's nothing
    meaningful to overwrite in an immutable log row.
  - Archiving a day's bills exports bills + bill_items + their linked
    ledger entries, then deletes all three from the live database. It
    does NOT restock inventory (the stock was genuinely sold).
  - Archive backups are APPEND-ONLY: exporting a day's bills to the same
    archive file you used yesterday adds to it rather than replacing it,
    keyed on the unique bill_number, so re-running an export (or pointing
    two days at the same file) can never create duplicate rows.
  - A shared bill_number between an incoming and an existing bill is only
    treated as a real duplicate if the date, customer and total also
    match. If they don't, it's almost certainly a coincidence from the
    live bill counter having been reset/reused at some point - the two
    are different bills, and the incoming one is auto-renumbered on
    import so both are kept (see _looks_like_same_bill / import_bills).
  - Importing a bill from a customer who doesn't exist yet automatically
    creates that customer, using the name/phone/address already on the
    bill (see _get_or_create_customer_id).
  - Customer names are always stored upper-case, on every path that
    writes one (see _upper()).
  - Double-clicking a .bbak file does NOT go through this module at all -
    see backup_viewer.py, a separate read-only viewer window that opens
    instead of the main app and never writes anything. Bringing data from
    a backup into the live app is always an explicit action from inside
    the app (Settings > Import Data, which uses scan_import/apply_import
    below).
"""

import os
import sqlite3
import tempfile
from urllib.request import pathname2url

import database as db
import validation
import safe_paths


# Settings that a backup file is NEVER allowed to change, no matter what
# the user picks in the import dialog.
#
# Without this, importing a "settings" backup made before authentication
# existed (or one edited by hand in any free SQLite browser - these files
# are not signed and travel on pendrives) would set auth_enabled back to
# "0" and switch the login off. That is privilege escalation through a
# data file: a staff member with permission to import data could use it
# to grant themselves owner access. The keys below are therefore always
# reported as skipped rather than applied.
PROTECTED_SETTINGS = frozenset({
    "auth_enabled",
})

# Ceilings on how much a single backup file may contain. A hostile or
# corrupt file should be refused quickly rather than being allowed to
# insert rows until the disk fills.
MAX_ROWS_PER_TABLE = 500_000


def _read_only_conn(path):
    """Opens a backup file READ-ONLY.

    Import files arrive from outside the app - a pendrive, an email
    attachment, another shop's machine - and are just SQLite databases.
    Opening one read-write means a malformed or malicious file can be
    modified (or have its journal/WAL sidecar files written) in place
    while we are only supposed to be reading it. mode=ro makes that
    impossible at the SQLite level rather than by convention.

    The path is converted through pathname2url so that spaces, '?' and
    '#' in a Windows filename cannot alter the URI's meaning.
    """
    uri = "file:" + pathname2url(os.path.abspath(path)) + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _clean_row_text(row, field_limits):
    """Runs imported text through the same cleaner used on typed input.

    Rows in a backup file were not necessarily produced by this app, so
    they get exactly the same treatment as something a person typed:
    control characters removed, whitespace collapsed, length capped.
    Values that are too long are truncated rather than rejected, because
    refusing the whole import over one long note would be worse than
    keeping a shortened one.
    """
    cleaned = dict(row)
    for field, limit in field_limits.items():
        if field in cleaned:
            try:
                cleaned[field] = validation.clean_text(cleaned[field], limit, field)
            except validation.ValidationError:
                cleaned[field] = validation.clean_text(
                    str(cleaned[field] or "")[:limit], limit, field
                )
    return cleaned


_CUSTOMER_LIMITS = {
    "name": validation.MAX_NAME_LENGTH,
    "phone": validation.MAX_PHONE_LENGTH,
    "address": validation.MAX_ADDRESS_LENGTH,
    "notes": validation.MAX_NOTES_LENGTH,
}
_ITEM_LIMITS = {
    "name": validation.MAX_NAME_LENGTH,
    "item_code": validation.MAX_ITEM_CODE_LENGTH,
    "category": validation.MAX_CATEGORY_LENGTH,
    "unit": validation.MAX_UNIT_LENGTH,
}
_BILL_LIMITS = {
    "bill_number": 40,
    "customer_name": validation.MAX_NAME_LENGTH,
    "customer_phone": validation.MAX_PHONE_LENGTH,
    "customer_address": validation.MAX_ADDRESS_LENGTH,
    "notes": validation.MAX_NOTES_LENGTH,
}
_EMPLOYEE_LIMITS = {
    "name": validation.MAX_NAME_LENGTH,
    "phone": validation.MAX_PHONE_LENGTH,
    "role": 60,
    "notes": validation.MAX_NOTES_LENGTH,
}

# Whitelists for the attendance-family enum-like columns. A backup file
# is untrusted input like any other - without this, a hand-edited or
# corrupt file could land a nonsense string in a column the calendar
# grid / payroll screen switches on by exact value.
_VALID_ATTENDANCE_STATUS = {"present", "half", "absent", "leave"}
_VALID_PAY_TYPE = {"monthly", "daily", "shift"}
_VALID_PAYROLL_STATUS = {"pending", "paid"}


def open_import_source(path, password=None):
    """Prepares any supported backup file for reading and returns
    (path_to_read, temp_path_to_delete_or_None).

    A password-protected backup is decrypted into a temporary file first;
    the caller must delete that file when finished (see
    cleanup_import_source), so the plaintext copy exists only for the
    duration of the import.
    """
    kind = safe_paths.validate_backup_file(path)
    if kind == "sqlite":
        return path, None

    import backup_crypto
    if not password:
        raise backup_crypto.BackupCryptoError("This backup is password-protected.")

    fd, tmp_path = tempfile.mkstemp(prefix="balaji_import_", suffix=".db")
    os.close(fd)
    try:
        backup_crypto.decrypt_to_file(path, tmp_path, password)
    except Exception:
        cleanup_import_source(tmp_path)
        raise
    return tmp_path, tmp_path


def cleanup_import_source(temp_path):
    """Removes the decrypted temporary copy. Best-effort: a file still
    held open by Windows is not worth crashing the import over."""
    if not temp_path:
        return
    try:
        os.remove(temp_path)
    except OSError:
        pass


def _upper(name):
    """Customer names are always stored in capitals - matches the same
    normalization in database.py, applied here too since this module
    writes customer/bill rows directly via SQL rather than going through
    database.py's add_customer()/create_bill()."""
    return (name or "").strip().upper()

CATEGORIES = ["items", "customers", "bills", "khata", "inventory_history", "settings", "attendance"]

CATEGORY_LABELS = {
    "items": "Items / Inventory",
    "customers": "Customers",
    "bills": "Bills (+ their line items and khata entries)",
    "khata": "Khata / Ledger (standalone entries)",
    "inventory_history": "Stock History Log",
    "settings": "Store Settings",
    "attendance": "Employees, Attendance & Payroll",
}

_TABLE_SCHEMA_SQL = {
    "items": """CREATE TABLE items (
            id INTEGER PRIMARY KEY AUTOINCREMENT, item_code TEXT UNIQUE, name TEXT NOT NULL UNIQUE,
            category TEXT DEFAULT '', unit TEXT DEFAULT 'pcs', price REAL NOT NULL DEFAULT 0,
            cost_price REAL NOT NULL DEFAULT 0,
            quantity REAL NOT NULL DEFAULT 0, low_stock_threshold REAL DEFAULT 5,
            pack_size REAL, pack_unit_name TEXT DEFAULT '',
            created_at TEXT, updated_at TEXT)""",
    "customers": """CREATE TABLE customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT DEFAULT '',
            address TEXT DEFAULT '', notes TEXT DEFAULT '', created_at TEXT)""",
    "bills": """CREATE TABLE bills (
            id INTEGER PRIMARY KEY AUTOINCREMENT, bill_number TEXT UNIQUE NOT NULL, customer_id INTEGER,
            customer_name TEXT NOT NULL, customer_phone TEXT DEFAULT '', customer_address TEXT DEFAULT '',
            bill_date TEXT NOT NULL, bill_time TEXT NOT NULL, freight_charges REAL DEFAULT 0,
            discount REAL DEFAULT 0, subtotal REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
            amount_paid REAL DEFAULT 0, notes TEXT DEFAULT '',
            bill_type TEXT NOT NULL DEFAULT 'sale',
            created_at TEXT, updated_at TEXT)""",
    "bill_items": """CREATE TABLE bill_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT, bill_id INTEGER NOT NULL, item_id INTEGER,
            item_name TEXT NOT NULL, quantity REAL NOT NULL, price_per_unit REAL NOT NULL,
            final_price REAL NOT NULL, pack_qty REAL, pack_unit_name TEXT DEFAULT '', pack_size REAL,
            cost_at_sale REAL)""",
    "customer_ledger": """CREATE TABLE customer_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, transaction_date TEXT NOT NULL,
            transaction_type TEXT NOT NULL, reference TEXT DEFAULT '', debit REAL DEFAULT 0, credit REAL DEFAULT 0,
            notes TEXT DEFAULT '', created_at TEXT)""",
    "inventory_transactions": """CREATE TABLE inventory_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER, item_name TEXT NOT NULL,
            change_type TEXT NOT NULL, quantity_change REAL NOT NULL, resulting_quantity REAL,
            reference TEXT DEFAULT '', notes TEXT DEFAULT '', created_at TEXT)""",
    "settings": """CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)""",
    # Stock on hand, batch by batch, with what each batch cost - the
    # thing that makes profit right when the same item was bought at
    # two different prices. Backed up with the items themselves.
    #
    # cost_consumption (which sale line ate which batch) is deliberately
    # NOT backed up: it exists only to undo a LIVE bill edit or delete,
    # and every layer's `remaining` here is already net of it. The cost
    # of anything already sold lives on bill_items.cost_at_sale, which
    # is backed up, so no profit figure depends on the journal.
    "cost_lots": """CREATE TABLE cost_lots (
            id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
            cost_price REAL NOT NULL DEFAULT 0, quantity REAL NOT NULL DEFAULT 0,
            remaining REAL NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'purchase',
            bill_id INTEGER, reference TEXT DEFAULT '', received_date TEXT, created_at TEXT)""",
    "employees": """CREATE TABLE employees (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT DEFAULT '',
            role TEXT DEFAULT '', pay_type TEXT NOT NULL DEFAULT 'monthly', pay_rate REAL NOT NULL DEFAULT 0,
            joined_date TEXT, active INTEGER NOT NULL DEFAULT 1, notes TEXT DEFAULT '',
            created_at TEXT, updated_at TEXT)""",
    "attendance": """CREATE TABLE attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, date TEXT NOT NULL,
            status TEXT NOT NULL, shifts REAL DEFAULT 1, notes TEXT DEFAULT '', marked_at TEXT,
            UNIQUE(employee_id, date))""",
    "employee_advances": """CREATE TABLE employee_advances (
            id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, date TEXT NOT NULL,
            amount REAL NOT NULL, notes TEXT DEFAULT '', settled INTEGER NOT NULL DEFAULT 0,
            payroll_id INTEGER, created_at TEXT)""",
    "payroll_runs": """CREATE TABLE payroll_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, period_month TEXT NOT NULL,
            present_days REAL NOT NULL DEFAULT 0, half_days REAL NOT NULL DEFAULT 0,
            absent_days REAL NOT NULL DEFAULT 0, leave_days REAL NOT NULL DEFAULT 0,
            gross_pay REAL NOT NULL DEFAULT 0, advances_deducted REAL NOT NULL DEFAULT 0,
            net_pay REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
            paid_date TEXT, notes TEXT DEFAULT '', created_at TEXT,
            UNIQUE(employee_id, period_month))""",
}

# Which real tables each user-facing category pulls from.
_CATEGORY_TABLES = {
    "items": ["items", "cost_lots"],
    "customers": ["customers"],
    "bills": ["bills", "bill_items", "customer_ledger"],
    "khata": ["customer_ledger"],
    "inventory_history": ["inventory_transactions"],
    "settings": ["settings"],
    "attendance": ["employees", "attendance", "employee_advances", "payroll_runs"],
}


def _new_backup_conn(dest_path, tables):
    """Fresh, single-shot backup file - used by the plain 'Backup Data'
    export, which is a point-in-time snapshot the user explicitly names
    each time, not something that grows day over day."""
    if os.path.exists(dest_path):
        os.remove(dest_path)
    conn = sqlite3.connect(dest_path)
    for t in tables:
        conn.execute(_TABLE_SCHEMA_SQL[t])
    conn.commit()
    return conn


def _open_or_create_archive_conn(dest_path, tables):
    """Used by the Archive workflow. Unlike _new_backup_conn(), this NEVER
    deletes an existing file - it opens it as-is (creating any missing
    tables) so repeated archiving into the same file accumulates data
    instead of replacing it."""
    conn = sqlite3.connect(dest_path)
    conn.row_factory = sqlite3.Row
    for t in tables:
        create_sql = _TABLE_SCHEMA_SQL[t].replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ", 1)
        conn.execute(create_sql)
    conn.commit()
    return conn


def _table_exists(conn, name):
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


# ---------------- EXPORT / BACKUP ----------------

def export_data(dest_path, categories):
    """Writes a new SQLite file at dest_path containing only the tables
    for the selected categories, fully populated from the live DB."""
    tables_needed = set()
    for c in categories:
        tables_needed.update(_CATEGORY_TABLES[c])

    live = db.get_connection()
    out = _new_backup_conn(dest_path, tables_needed)

    if "items" in categories:
        _copy_all(live, out, "items")
        _copy_all(live, out, "cost_lots")
    if "customers" in categories:
        _copy_all(live, out, "customers")
    if "bills" in categories:
        bill_ids = _copy_all(live, out, "bills")
        _copy_bill_items(live, out, bill_ids)
        _copy_ledger_for_bills(live, out, bill_ids)
    if "khata" in categories:
        _copy_standalone_ledger(live, out)
    if "inventory_history" in categories:
        _copy_all(live, out, "inventory_transactions")
    if "settings" in categories:
        _copy_all(live, out, "settings")
    if "attendance" in categories:
        _copy_all(live, out, "employees")
        _copy_all(live, out, "attendance")
        _copy_all(live, out, "employee_advances")
        _copy_all(live, out, "payroll_runs")

    out.commit()
    out.close()
    live.close()


def _copy_all(live, out, table):
    rows = live.execute(f"SELECT * FROM {table}").fetchall()
    ids = []
    for r in rows:
        cols = r.keys()
        placeholders = ",".join("?" * len(cols))
        out.execute(f"INSERT INTO {table} ({','.join(cols)}) VALUES ({placeholders})",
                    tuple(r[c] for c in cols))
        if "id" in cols:
            ids.append(r["id"])
    return ids


def _copy_bill_items(live, out, bill_ids):
    if not bill_ids:
        return
    q = f"SELECT * FROM bill_items WHERE bill_id IN ({','.join('?' * len(bill_ids))})"
    rows = live.execute(q, bill_ids).fetchall()
    for r in rows:
        cols = r.keys()
        out.execute(f"INSERT INTO bill_items ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                    tuple(r[c] for c in cols))


def _copy_ledger_for_bills(live, out, bill_ids, number_overrides=None):
    """Copies customer_ledger rows tied to the given live bill ids into
    the archive. `number_overrides` (original live bill_number ->
    disambiguated archive bill_number) lets export_bills_for_archive()
    keep a ledger entry's `reference` pointing at the right bill even
    when that bill had to be archived under a different number because
    its original number collided with an unrelated bill already in the
    archive file - see export_bills_for_archive() for why that happens."""
    number_overrides = number_overrides or {}
    if not bill_ids:
        return
    q = f"SELECT bill_number FROM bills WHERE id IN ({','.join('?' * len(bill_ids))})"
    bill_numbers = [r["bill_number"] for r in live.execute(q, bill_ids).fetchall()]
    if not bill_numbers:
        return
    refs = bill_numbers + [f"Payment for {bn}" for bn in bill_numbers]
    q2 = f"SELECT * FROM customer_ledger WHERE reference IN ({','.join('?' * len(refs))})"
    rows = live.execute(q2, refs).fetchall()
    for r in rows:
        cols = r.keys()
        reference = r["reference"]
        for orig, new in number_overrides.items():
            if reference == orig:
                reference = new
                break
            if reference == f"Payment for {orig}":
                reference = f"Payment for {new}"
                break
        values = [reference if c == "reference" else r[c] for c in cols]
        out.execute(f"INSERT INTO customer_ledger ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                    tuple(values))


def _copy_standalone_ledger(live, out):
    """Ledger rows whose reference doesn't match any bill number - manual
    payments, opening balances, etc. This is the 'khata' category."""
    rows = live.execute("""
        SELECT cl.* FROM customer_ledger cl
        WHERE NOT EXISTS (
            SELECT 1 FROM bills b
            WHERE cl.reference = b.bill_number OR cl.reference = ('Payment for ' || b.bill_number)
        )
    """).fetchall()
    for r in rows:
        cols = r.keys()
        out.execute(f"INSERT INTO customer_ledger ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                    tuple(r[c] for c in cols))


def export_bills_for_archive(dest_path, date_from, date_to):
    """Backs up bills + their bill_items + their ledger entries for a date
    range, WITHOUT touching the live database. Call delete_archived_bills()
    afterwards, once the backup is confirmed written. Returns
    (bills_archived, bills_renumbered).

    APPEND-ONLY: if dest_path already exists (e.g. it's the same archive
    file you used yesterday, sitting on a pendrive), this adds to it.

    A live bill whose bill_number already exists in the archive file is
    only treated as an already-archived duplicate (and skipped) if its
    date/customer/total also match (see _looks_like_same_bill) - i.e. if
    it's genuinely the same bill, such as re-running an export for a day
    you already archived. If the number matches but the bill is clearly
    DIFFERENT (this happens once the live bill counter has restarted -
    e.g. after bills were cleared out and new ones started again from
    #1), the bill is still archived - never silently dropped - just under
    a disambiguated bill_number so it can't collide with the older bill
    already sitting in the archive file. Its original number is recorded
    in its notes for traceability, and any linked khata/ledger entries
    are re-pointed at the new number so nothing goes orphaned. This
    matters because delete_archived_bills() afterwards deletes every live
    bill for the date regardless of whether it hit this edge case - so
    every bill MUST end up captured in the archive one way or another, or
    it would be deleted with no backup at all."""
    live = db.get_connection()
    out = _open_or_create_archive_conn(dest_path, ["bills", "bill_items", "customer_ledger"])

    rows = live.execute("SELECT * FROM bills WHERE bill_date >= ? AND bill_date <= ?",
                         (date_from, date_to)).fetchall()
    bill_ids = []
    number_overrides = {}  # original live bill_number -> disambiguated archive bill_number
    for r in rows:
        existing_archived = out.execute(
            "SELECT * FROM bills WHERE bill_number = ?", (r["bill_number"],)
        ).fetchone()

        if existing_archived and _looks_like_same_bill(existing_archived, r):
            # Genuinely the same bill, already safely in the archive -
            # nothing new to add.
            continue

        archive_bill_number = r["bill_number"]
        notes = r["notes"] or ""
        if existing_archived:
            # Same bill_number, but a clearly DIFFERENT bill - the live
            # counter reused a number that's already taken in this
            # archive file. Archive it under a disambiguated number
            # instead of dropping it or crashing on the archive's own
            # UNIQUE constraint.
            archive_bill_number = f"{r['bill_number']}-DUP{r['id']}"
            number_overrides[r["bill_number"]] = archive_bill_number
            notes = (notes + f" [Archived as {archive_bill_number} - bill number {r['bill_number']} was "
                              f"already used by a different bill in this archive file]").strip()

        cols = r.keys()
        values = [archive_bill_number if c == "bill_number" else (notes if c == "notes" else r[c])
                  for c in cols]
        out.execute(f"INSERT INTO bills ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", tuple(values))
        bill_ids.append(r["id"])

    _copy_bill_items(live, out, bill_ids)
    _copy_ledger_for_bills(live, out, bill_ids, number_overrides)

    out.commit()
    out.close()
    live.close()
    return len(bill_ids), len(number_overrides)


def delete_archived_bills(date_from, date_to):
    """Deletes bills (+ their bill_items + linked khata entries) for a date
    range from the live database. Does NOT restock inventory. Returns the
    number of bills deleted."""
    conn = db.get_connection()
    cur = conn.cursor()
    rows = cur.execute("SELECT id, bill_number FROM bills WHERE bill_date >= ? AND bill_date <= ?",
                        (date_from, date_to)).fetchall()
    for r in rows:
        cur.execute("DELETE FROM customer_ledger WHERE reference = ? OR reference = ?",
                    (r["bill_number"], f"Payment for {r['bill_number']}"))
        cur.execute("DELETE FROM bill_items WHERE bill_id = ?", (r["id"],))
        cur.execute("DELETE FROM bills WHERE id = ?", (r["id"],))
    conn.commit()
    conn.close()
    return len(rows)


# ---------------- IMPORT / MERGE ----------------

class Conflict:
    """One row from the backup file that looks like it already exists in
    the live database. The UI sets `.resolution` to 'skip' or 'overwrite'
    before apply_import() is called."""

    def __init__(self, category, key, description, existing_row, incoming_row, existing_id):
        self.category = category
        self.key = key
        self.description = description
        self.existing_row = existing_row
        self.incoming_row = incoming_row
        self.existing_id = existing_id
        self.resolution = "skip"  # safest default


def _looks_like_same_bill(existing, incoming):
    """Two bills sharing a bill_number are only treated as the SAME bill -
    a real duplicate, e.g. a file you've already imported before - if
    their date, customer and total also match. If any of those differ,
    the shared number is almost certainly just a coincidence (the live
    bill counter got reset/reused at some point) and these are two
    unrelated bills that both need to be kept - see scan_import()."""
    try:
        same_total = abs(float(existing["total"]) - float(incoming["total"])) < 0.01
    except (TypeError, ValueError):
        same_total = existing["total"] == incoming["total"]
    return (existing["bill_date"] == incoming["bill_date"]
            and _upper(existing["customer_name"]) == _upper(incoming["customer_name"])
            and same_total)


def scan_import(src_path, categories):
    """Reads the backup file and figures out, for each selected category,
    which incoming rows are brand-new (auto-added) vs. which look like
    duplicates of something already in the live DB (need a decision).
    Returns (plan, conflicts). `plan` is passed to apply_import() once
    every Conflict in it has a `.resolution` set."""
    live = db.get_connection()
    # Read-only: an imported file is untrusted input and is never written
    # to, not even by SQLite's own journalling. See _read_only_conn().
    bak = _read_only_conn(src_path)

    plan = {k: [] for k in CATEGORIES}
    conflicts = []

    if "items" in categories and _table_exists(bak, "items"):
        for raw in bak.execute("SELECT * FROM items LIMIT ?", (MAX_ROWS_PER_TABLE,)).fetchall():
            r = _clean_row_text(raw, _ITEM_LIMITS)
            if not r.get("name"):
                continue   # a nameless item can't be matched or displayed
            existing = live.execute("SELECT * FROM items WHERE name = ?", (r["name"],)).fetchone()
            if existing:
                c = Conflict("items", f"items:{r['name']}", f"Item '{r['name']}'",
                              dict(existing), dict(r), existing["id"])
                conflicts.append(c)
                plan["items"].append({"row": dict(r), "conflict": c})
            else:
                plan["items"].append({"row": dict(r), "conflict": None})

    # Cost layers (what each batch of stock cost). These carry only a raw
    # item_id, so - exactly like the attendance family below - the backup's
    # OWN items table is what turns that id back into a name that can be
    # matched here.
    if "items" in categories and _table_exists(bak, "cost_lots") and _table_exists(bak, "items"):
        bak_item_names = {r["id"]: r["name"] for r in bak.execute("SELECT id, name FROM items").fetchall()}
        # A layer is only taken on for an item that is not already holding
        # stock of its own here. Without this, importing a backup into a
        # shop that has been trading would stack a second set of batches
        # on top of the real ones and quietly double what the godown is
        # worth. Restoring into an empty (or never-costed) item - the case
        # that actually matters - is unaffected.
        already_costed = set()
        for r in live.execute("""SELECT i.name AS name FROM cost_lots cl
                                 JOIN items i ON i.id = cl.item_id
                                 WHERE cl.remaining > 0.000001""").fetchall():
            already_costed.add(r["name"])
        for raw in bak.execute("SELECT * FROM cost_lots LIMIT ?", (MAX_ROWS_PER_TABLE,)).fetchall():
            r = dict(raw)
            item_name = bak_item_names.get(r["item_id"])
            if not item_name or item_name in already_costed:
                continue
            if (r.get("remaining") or 0) <= 0.000001:
                continue                      # a used-up batch has nothing left to describe
            plan["items"].append({"kind": "cost_lot", "row": r, "item_name": item_name,
                                   "conflict": None})

    if "customers" in categories and _table_exists(bak, "customers"):
        for raw in bak.execute("SELECT * FROM customers LIMIT ?", (MAX_ROWS_PER_TABLE,)).fetchall():
            r = _clean_row_text(raw, _CUSTOMER_LIMITS)
            if not r.get("name"):
                continue
            existing = live.execute(
                "SELECT * FROM customers WHERE UPPER(name) = ? AND phone = ?", (_upper(r["name"]), r["phone"])
            ).fetchone()
            if existing:
                c = Conflict("customers", f"customers:{r['name']}:{r['phone']}",
                              f"Customer '{r['name']}' ({r['phone'] or 'no phone'})",
                              dict(existing), dict(r), existing["id"])
                conflicts.append(c)
                plan["customers"].append({"row": dict(r), "conflict": c})
            else:
                plan["customers"].append({"row": dict(r), "conflict": None})

    if "settings" in categories and _table_exists(bak, "settings"):
        for r in bak.execute("SELECT * FROM settings LIMIT ?", (MAX_ROWS_PER_TABLE,)).fetchall():
            # Security-critical keys are never taken from a file. See
            # PROTECTED_SETTINGS for why.
            if r["key"] in PROTECTED_SETTINGS:
                continue
            existing = live.execute("SELECT * FROM settings WHERE key = ?", (r["key"],)).fetchone()
            if existing and existing["value"] != r["value"]:
                c = Conflict("settings", f"settings:{r['key']}", f"Setting '{r['key']}'",
                              dict(existing), dict(r), None)
                conflicts.append(c)
                plan["settings"].append({"row": dict(r), "conflict": c})
            else:
                plan["settings"].append({"row": dict(r), "conflict": None})

    if "bills" in categories and _table_exists(bak, "bills"):
        for raw in bak.execute("SELECT * FROM bills LIMIT ?", (MAX_ROWS_PER_TABLE,)).fetchall():
            r = _clean_row_text(raw, _BILL_LIMITS)
            # A bill number from a file becomes part of a PDF filename, so
            # it is reduced to something that can only ever be a plain file
            # name (see safe_paths). Without this, a bill numbered
            # "..\..\Windows\System32\x" would make "open this bill's PDF"
            # point outside the app's own folder.
            original_number = raw["bill_number"]
            r["bill_number"] = safe_paths.safe_filename_component(original_number, fallback="")
            if not r["bill_number"] or not r.get("customer_name"):
                continue
            existing = live.execute("SELECT * FROM bills WHERE bill_number = ?", (r["bill_number"],)).fetchone()
            items = bak.execute("SELECT * FROM bill_items WHERE bill_id = ?", (raw["id"],)).fetchall() \
                if _table_exists(bak, "bill_items") else []

            # The file's own ledger rows still reference the ORIGINAL
            # number, so they are looked up with that and then re-pointed
            # at the sanitised one - otherwise sanitising a bill number
            # would silently orphan its khata entries.
            ledger = bak.execute(
                "SELECT * FROM customer_ledger WHERE reference = ? OR reference = ?",
                (original_number, f"Payment for {original_number}")
            ).fetchall() if _table_exists(bak, "customer_ledger") else []

            ledger_rows = []
            for lg in ledger:
                lg = dict(lg)
                if original_number != r["bill_number"]:
                    lg["reference"] = str(lg.get("reference") or "").replace(
                        original_number, r["bill_number"]
                    )
                ledger_rows.append(lg)

            entry = {"row": dict(r), "items": [dict(i) for i in items], "ledger": ledger_rows,
                      "number_collision": False}
            if existing and _looks_like_same_bill(existing, r):
                # Same date, same customer, same total under the same
                # bill_number - this is genuinely the same bill (e.g. a
                # re-import of a file you've imported before). Ask the
                # usual skip/overwrite question.
                c = Conflict("bills", f"bills:{r['bill_number']}",
                              f"Bill {r['bill_number']} ({r['bill_date']}, Rs. {r['total']})",
                              dict(existing), dict(r), existing["id"])
                conflicts.append(c)
                entry["conflict"] = c
            elif existing:
                # Same bill_number, but a clearly DIFFERENT bill (different
                # date/customer/total) - almost always caused by the bill
                # counter having been reset at some point. Both bills are
                # real and both need to be kept, so this one is imported
                # under a freshly-minted unique number instead of forcing
                # a false skip-or-overwrite choice between two unrelated
                # bills. See _next_unique_bill_number() in apply_import.
                entry["conflict"] = None
                entry["number_collision"] = True
            else:
                entry["conflict"] = None
            plan["bills"].append(entry)

    if "khata" in categories and _table_exists(bak, "customer_ledger"):
        for r in bak.execute("SELECT * FROM customer_ledger LIMIT ?", (MAX_ROWS_PER_TABLE,)).fetchall():
            dup = live.execute("""
                SELECT id FROM customer_ledger
                WHERE transaction_date=? AND transaction_type=? AND reference=? AND debit=? AND credit=?
            """, (r["transaction_date"], r["transaction_type"], r["reference"], r["debit"], r["credit"])).fetchone()
            if not dup:  # exact-duplicate log rows are silently skipped, no prompt needed
                plan["khata"].append({"row": dict(r)})

    if "inventory_history" in categories and _table_exists(bak, "inventory_transactions"):
        for r in bak.execute("SELECT * FROM inventory_transactions LIMIT ?", (MAX_ROWS_PER_TABLE,)).fetchall():
            dup = live.execute("""
                SELECT id FROM inventory_transactions
                WHERE item_name=? AND change_type=? AND quantity_change=? AND created_at=?
            """, (r["item_name"], r["change_type"], r["quantity_change"], r["created_at"])).fetchone()
            if not dup:
                plan["inventory_history"].append({"row": dict(r)})

    # Employees, attendance marks, advances and payroll runs. Bundled as
    # one category (like "bills" bundles bill_items/customer_ledger)
    # because they only make sense together - an attendance mark with no
    # employee, or a payroll run for nobody, is meaningless.
    #
    # employee_lookup maps the BACKUP FILE's own employee row id -> that
    # employee's (name, phone), read straight from the backup's own
    # employees table (never from the live one). Every other row in this
    # category references an employee only by that backup-local id, so
    # this is what lets a mark/advance/payroll row be matched to the
    # right LIVE employee (by name+phone, same idea as
    # _resolve_customer_id) before that employee has necessarily been
    # imported yet.
    if "attendance" in categories:
        employee_lookup = {}

        if _table_exists(bak, "employees"):
            for raw in bak.execute("SELECT * FROM employees LIMIT ?", (MAX_ROWS_PER_TABLE,)).fetchall():
                r = _clean_row_text(dict(raw), _EMPLOYEE_LIMITS)
                if not r.get("name"):
                    continue                          # a nameless employee can't be matched or shown
                if r.get("pay_type") not in _VALID_PAY_TYPE:
                    r["pay_type"] = "monthly"
                employee_lookup[raw["id"]] = (r["name"], r.get("phone") or "")
                existing = live.execute(
                    "SELECT * FROM employees WHERE UPPER(name) = ? AND phone = ?",
                    (_upper(r["name"]), r.get("phone") or "")
                ).fetchone()
                if existing:
                    c = Conflict("attendance", f"employee:{r['name']}:{r.get('phone', '')}",
                                  f"Employee '{r['name']}' ({r.get('phone') or 'no phone'})",
                                  dict(existing), dict(r), existing["id"])
                    conflicts.append(c)
                    plan["attendance"].append(
                        {"kind": "employee", "row": r, "conflict": c, "backup_id": raw["id"]})
                else:
                    plan["attendance"].append(
                        {"kind": "employee", "row": r, "conflict": None, "backup_id": raw["id"]})

        if _table_exists(bak, "attendance"):
            for raw in bak.execute("SELECT * FROM attendance LIMIT ?", (MAX_ROWS_PER_TABLE,)).fetchall():
                r = dict(raw)
                if r.get("status") not in _VALID_ATTENDANCE_STATUS:
                    continue                          # garbage status - nothing sensible to import
                emp_name, emp_phone = employee_lookup.get(r["employee_id"], (None, None))
                entry = {"kind": "mark", "row": r, "emp_name": emp_name, "emp_phone": emp_phone,
                          "backup_emp_id": r["employee_id"]}
                existing_mark = None
                if emp_name:
                    existing_emp = live.execute(
                        "SELECT id FROM employees WHERE UPPER(name)=? AND phone=?",
                        (_upper(emp_name), emp_phone or "")
                    ).fetchone()
                    if existing_emp:
                        existing_mark = live.execute(
                            "SELECT * FROM attendance WHERE employee_id=? AND date=?",
                            (existing_emp["id"], r["date"])
                        ).fetchone()
                if existing_mark:
                    c = Conflict("attendance", f"mark:{emp_name}:{r['date']}",
                                  f"{emp_name} - {r['date']} attendance",
                                  dict(existing_mark), r, existing_mark["id"])
                    conflicts.append(c)
                    entry["conflict"] = c
                else:
                    entry["conflict"] = None
                plan["attendance"].append(entry)

        if _table_exists(bak, "employee_advances"):
            # A cash advance is a log entry like khata/inventory history -
            # an exact-duplicate row (same employee, date, amount, note)
            # is skipped automatically with no prompt.
            for raw in bak.execute("SELECT * FROM employee_advances LIMIT ?", (MAX_ROWS_PER_TABLE,)).fetchall():
                r = dict(raw)
                emp_name, emp_phone = employee_lookup.get(r["employee_id"], (None, None))
                dup = None
                if emp_name:
                    existing_emp = live.execute(
                        "SELECT id FROM employees WHERE UPPER(name)=? AND phone=?",
                        (_upper(emp_name), emp_phone or "")
                    ).fetchone()
                    if existing_emp:
                        dup = live.execute("""
                            SELECT id FROM employee_advances
                            WHERE employee_id=? AND date=? AND amount=? AND notes=?
                        """, (existing_emp["id"], r["date"], r["amount"], r.get("notes") or "")).fetchone()
                if not dup:
                    plan["attendance"].append(
                        {"kind": "advance", "row": r, "emp_name": emp_name, "emp_phone": emp_phone,
                         "backup_emp_id": r["employee_id"]})

        if _table_exists(bak, "payroll_runs"):
            for raw in bak.execute("SELECT * FROM payroll_runs LIMIT ?", (MAX_ROWS_PER_TABLE,)).fetchall():
                r = dict(raw)
                if r.get("status") not in _VALID_PAYROLL_STATUS:
                    r["status"] = "pending"
                emp_name, emp_phone = employee_lookup.get(r["employee_id"], (None, None))
                entry = {"kind": "payroll", "row": r, "emp_name": emp_name, "emp_phone": emp_phone,
                          "backup_emp_id": r["employee_id"]}
                existing_run = None
                if emp_name:
                    existing_emp = live.execute(
                        "SELECT id FROM employees WHERE UPPER(name)=? AND phone=?",
                        (_upper(emp_name), emp_phone or "")
                    ).fetchone()
                    if existing_emp:
                        existing_run = live.execute(
                            "SELECT * FROM payroll_runs WHERE employee_id=? AND period_month=?",
                            (existing_emp["id"], r["period_month"])
                        ).fetchone()
                if existing_run:
                    c = Conflict("attendance", f"payroll:{emp_name}:{r['period_month']}",
                                  f"{emp_name} - {r['period_month']} payroll ({r['status']})",
                                  dict(existing_run), r, existing_run["id"])
                    conflicts.append(c)
                    entry["conflict"] = c
                else:
                    entry["conflict"] = None
                plan["attendance"].append(entry)

    live.close()
    bak.close()
    return plan, conflicts


def _resolve_customer_id(cur, backup_id, name, phone, customer_id_map):
    """Maps a backup row's customer_id to a valid live customer id.
    Backup IDs aren't portable across backups taken at different times, so
    this NEVER trusts the raw id - it only uses it if the customers
    category was imported in this same run (customer_id_map), otherwise it
    looks the customer up live by name+phone (case-insensitively, since
    names are always stored upper-case - see _upper()). Falls back to
    None (no linked customer) when there's no name to match at all (e.g.
    standalone khata rows, which don't carry a customer name)."""
    if backup_id in customer_id_map:
        return customer_id_map[backup_id]
    name = _upper(name)
    if not name:
        return None
    row = cur.execute("SELECT id FROM customers WHERE UPPER(name)=? AND phone=?",
                       (name, phone or "")).fetchone()
    return row["id"] if row else None


def _get_or_create_customer_id(cur, backup_id, name, phone, address, customer_id_map):
    """Like _resolve_customer_id(), but when no matching customer exists
    yet, CREATES one instead of leaving the bill unlinked - a bill
    imported from a customer who isn't in the app yet should result in
    that customer existing here, same as if the bill had just been made
    in the app today. Only used for bills, which always carry a name (and
    usually a phone/address) directly on the row, unlike standalone khata
    entries. The new customer's name AND address are stored upper-case,
    same as every other path that saves a customer name/address."""
    if backup_id in customer_id_map:
        return customer_id_map[backup_id]
    name = _upper(name)
    if not name:
        return None
    phone = phone or ""
    row = cur.execute("SELECT id FROM customers WHERE UPPER(name)=? AND phone=?", (name, phone)).fetchone()
    if row:
        customer_id_map[backup_id] = row["id"]
        return row["id"]
    cur.execute("INSERT INTO customers (name, phone, address, notes, created_at) VALUES (?,?,?,?,?)",
                (name, phone, _upper(address), "Auto-created from an imported bill", db.now_str()))
    new_id = cur.lastrowid
    customer_id_map[backup_id] = new_id
    return new_id


def _resolve_employee_id(cur, backup_id, name, phone, employee_id_map):
    """Same idea as _resolve_customer_id, but for the employee an
    attendance/advance/payroll row belongs to. `backup_id` is the raw
    employee_id from the BACKUP FILE's own attendance-family table -
    never trusted directly, only used as a key into employee_id_map
    (populated while this same import processes the "employee" plan
    entries) or, failing that, resolved live by name+phone."""
    if backup_id in employee_id_map:
        return employee_id_map[backup_id]
    name = (name or "").strip()
    if not name:
        return None
    row = cur.execute("SELECT id FROM employees WHERE UPPER(name)=? AND phone=?",
                       (name.upper(), phone or "")).fetchone()
    return row["id"] if row else None


def _get_or_create_employee_id(cur, backup_id, name, phone, employee_id_map):
    """Like _resolve_employee_id(), but creates a minimal employee record
    instead of leaving the row orphaned when no match exists - mirrors
    _get_or_create_customer_id() for bills. In practice this only fires
    for an older/hand-trimmed backup that carries attendance data but no
    employees table (or a row whose employee was itself skipped and
    never matched anything live), since a normal "attendance" category
    backup always carries its employees alongside."""
    if backup_id in employee_id_map:
        return employee_id_map[backup_id]
    name = (name or "").strip()
    if not name:
        return None
    phone = phone or ""
    row = cur.execute("SELECT id FROM employees WHERE UPPER(name)=? AND phone=?",
                       (name.upper(), phone)).fetchone()
    if row:
        employee_id_map[backup_id] = row["id"]
        return row["id"]
    cur.execute("""INSERT INTO employees (name, phone, role, pay_type, pay_rate, joined_date,
                    active, notes, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,1,?,?,?)""",
                (name, phone, "", "monthly", 0, db.now_str()[:10],
                 "Auto-created from imported attendance data", db.now_str(), db.now_str()))
    new_id = cur.lastrowid
    employee_id_map[backup_id] = new_id
    return new_id


def _next_unique_bill_number(cur):
    """Mints a fresh, guaranteed-unique bill number using the same plain
    8-digit next_bill_seq scheme create_bill() uses in database.py - but
    done directly against THIS import's own cursor/transaction, so it
    correctly sees (and skips past) both already-committed live bills AND
    any bills already inserted earlier in this same import run, and
    persists the advanced counter as part of the same transaction. Used
    only when an imported bill's number collides with an existing but
    genuinely different bill (see _looks_like_same_bill)."""
    seq = int(cur.execute("SELECT value FROM settings WHERE key='next_bill_seq'").fetchone()["value"])
    candidate = f"{seq:08d}"
    while cur.execute("SELECT 1 FROM bills WHERE bill_number=?", (candidate,)).fetchone():
        seq += 1
        candidate = f"{seq:08d}"
    cur.execute("UPDATE settings SET value=? WHERE key='next_bill_seq'", (str(seq + 1),))
    return candidate


def _resolve_item_id(cur, backup_id, item_name, item_id_map):
    """Same idea as _resolve_customer_id, but for items on a bill line."""
    if backup_id in item_id_map:
        return item_id_map[backup_id]
    if not item_name:
        return None
    row = cur.execute("SELECT id FROM items WHERE name=?", (item_name,)).fetchone()
    return row["id"] if row else None


def apply_import(plan):
    """Applies a plan produced by scan_import(), after every Conflict in it
    has had `.resolution` set to 'skip' or 'overwrite'. Returns a summary
    dict of counts per category for the confirmation message.

    Runs as one all-or-nothing transaction: if anything goes wrong partway
    through, everything is rolled back and the connection is always closed
    in the `finally` block - a failed import can never leave the database
    locked for the next attempt."""
    conn = db.get_connection()
    try:
        return _apply_import_inner(conn, plan)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _apply_import_inner(conn, plan):
    cur = conn.cursor()
    summary = {k: {"added": 0, "updated": 0, "skipped": 0, "renumbered": 0} for k in CATEGORIES}

    item_id_map = {}      # backup item id -> live item id (only for items in THIS backup's import)
    customer_id_map = {}  # backup customer id -> live customer id (only for customers in THIS backup's import)
    employee_id_map = {}  # backup employee id -> live employee id (only for employees in THIS backup's import)

    # Items first (bills/inventory history reference them). Cost layers
    # are queued into this same list by scan_import, always after every
    # real item row, so item_id_map is fully populated by the time one
    # needs to resolve the item it belongs to.
    for entry in plan["items"]:
        if entry.get("kind") == "cost_lot":
            row = entry["row"]
            new_item_id = _resolve_item_id(cur, row["item_id"], entry.get("item_name"), item_id_map)
            if new_item_id is None:
                summary["items"]["skipped"] += 1
                continue
            # `remaining`, not `quantity`, is what still exists - the
            # rest of that batch was sold before the backup was taken.
            # bill_id is dropped: it points at a bill row in whatever
            # database this file came from.
            remaining = row.get("remaining") or 0
            cur.execute("""INSERT INTO cost_lots (item_id, cost_price, quantity, remaining, source,
                            bill_id, reference, received_date, created_at)
                            VALUES (?,?,?,?,?,NULL,?,?,?)""",
                        (new_item_id, row.get("cost_price") or 0, remaining, remaining,
                         row.get("source") or "purchase", row.get("reference") or "",
                         row.get("received_date"), row.get("created_at") or db.now_str()))
            summary["items"]["added"] += 1
            continue
        row, conflict = entry["row"], entry["conflict"]
        # .get() throughout: an older backup file made before the carton/
        # pack-size feature existed simply won't have these columns at
        # all in its items table - treat that as "no pack info", not an
        # error.
        pack_size = row.get("pack_size")
        pack_unit_name = row.get("pack_unit_name") or ""
        # .get() with a 0 default: an older backup made before cost_price
        # existed simply won't have this column at all - treat that as
        # "no cost recorded yet", not an error. Owner-only data, but
        # gating who is even ALLOWED to reach this import path at all is
        # already handled by PERM_IMPORT_DATA at the bridge.py layer (see
        # its own comment) - by the time a row gets here it is fine to
        # carry cost_price straight through, same as price.
        cost_price = row.get("cost_price") or 0
        if conflict is None:
            cur.execute("""INSERT INTO items (item_code, name, category, unit, price, cost_price, quantity,
                            low_stock_threshold, pack_size, pack_unit_name, created_at, updated_at)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (row["item_code"], row["name"], row["category"], row["unit"], row["price"], cost_price,
                         row["quantity"], row["low_stock_threshold"], pack_size, pack_unit_name,
                         row["created_at"], row["updated_at"]))
            item_id_map[row["id"]] = cur.lastrowid
            summary["items"]["added"] += 1
        elif conflict.resolution == "overwrite":
            cur.execute("""UPDATE items SET item_code=?, category=?, unit=?, price=?, cost_price=?, quantity=?,
                            low_stock_threshold=?, pack_size=?, pack_unit_name=?, updated_at=? WHERE id=?""",
                        (row["item_code"], row["category"], row["unit"], row["price"], cost_price, row["quantity"],
                         row["low_stock_threshold"], pack_size, pack_unit_name, db.now_str(), conflict.existing_id))
            item_id_map[row["id"]] = conflict.existing_id
            summary["items"]["updated"] += 1
        else:
            item_id_map[row["id"]] = conflict.existing_id
            summary["items"]["skipped"] += 1

    # Customers next (bills reference them)
    for entry in plan["customers"]:
        row, conflict = entry["row"], entry["conflict"]
        if conflict is None:
            cur.execute("INSERT INTO customers (name, phone, address, notes, created_at) VALUES (?,?,?,?,?)",
                        (_upper(row["name"]), row["phone"], _upper(row["address"]), row["notes"], row["created_at"]))
            customer_id_map[row["id"]] = cur.lastrowid
            summary["customers"]["added"] += 1
        elif conflict.resolution == "overwrite":
            cur.execute("UPDATE customers SET address=?, notes=? WHERE id=?",
                        (_upper(row["address"]), row["notes"], conflict.existing_id))
            customer_id_map[row["id"]] = conflict.existing_id
            summary["customers"]["updated"] += 1
        else:
            customer_id_map[row["id"]] = conflict.existing_id
            summary["customers"]["skipped"] += 1

    # Settings
    for entry in plan["settings"]:
        row, conflict = entry["row"], entry["conflict"]
        if row["key"] in PROTECTED_SETTINGS:
            # Checked here as well as in scan_import: this is the layer
            # that actually writes, so it is the one that must be right.
            summary["settings"]["skipped"] += 1
            continue
        if conflict is None:
            cur.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (row["key"], row["value"]))
            summary["settings"]["added"] += 1
        elif conflict.resolution == "overwrite":
            cur.execute("UPDATE settings SET value=? WHERE key=?", (row["value"], row["key"]))
            summary["settings"]["updated"] += 1
        else:
            summary["settings"]["skipped"] += 1

    # Bills (+ their items + their ledger entries)
    for entry in plan["bills"]:
        row, conflict = entry["row"], entry["conflict"]
        if conflict is not None and conflict.resolution == "skip":
            summary["bills"]["skipped"] += 1
            continue

        # A bill imported from a customer who doesn't exist in the app yet
        # gets that customer CREATED automatically (from the name/phone/
        # address already on the bill row), instead of importing with no
        # customer link. Also never trusts the backup's raw customer_id -
        # that's a row id from whatever machine/moment the backup was
        # made and almost certainly doesn't match this database.
        new_customer_id = _get_or_create_customer_id(cur, row["customer_id"], row["customer_name"],
                                                       row["customer_phone"], row["customer_address"],
                                                       customer_id_map)

        # If this bill's number collides with a genuinely different bill
        # (see _looks_like_same_bill / scan_import), mint a fresh unique
        # number for it instead of overwriting or skipping the wrong
        # bill. Otherwise keep its original number as-is.
        bill_number = row["bill_number"]
        notes = row["notes"] or ""
        if entry.get("number_collision"):
            bill_number = _next_unique_bill_number(cur)
            notes = (notes + f" [Imported: originally numbered {row['bill_number']}, renumbered to "
                              f"{bill_number} to avoid clashing with an unrelated bill]").strip()
            summary["bills"]["renumbered"] += 1

        if conflict is not None and conflict.resolution == "overwrite":
            cur.execute("DELETE FROM customer_ledger WHERE reference=? OR reference=?",
                        (row["bill_number"], f"Payment for {row['bill_number']}"))
            cur.execute("DELETE FROM bill_items WHERE bill_id=?", (conflict.existing_id,))
            cur.execute("DELETE FROM bills WHERE id=?", (conflict.existing_id,))
            summary["bills"]["updated"] += 1
        else:
            summary["bills"]["added"] += 1

        # .get() with a 'sale' default: an older backup made before the
        # purchase-bill feature existed simply won't have this column at
        # all - treat that as "sale", which is what every bill already
        # was before this column existed (see database.py's own migration
        # comment for the same column).
        bill_type = row.get("bill_type") or "sale"
        if bill_type not in ("sale", "purchase"):
            bill_type = "sale"
        cur.execute("""INSERT INTO bills (bill_number, customer_id, customer_name, customer_phone,
                        customer_address, bill_date, bill_time, freight_charges, discount, subtotal,
                        total, amount_paid, notes, bill_type, created_at, updated_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (bill_number, new_customer_id, _upper(row["customer_name"]), row["customer_phone"],
                     _upper(row["customer_address"]), row["bill_date"], row["bill_time"], row["freight_charges"],
                     row["discount"], row["subtotal"], row["total"], row["amount_paid"], notes,
                     bill_type, row["created_at"], row["updated_at"]))
        new_bill_id = cur.lastrowid

        for it in entry["items"]:
            # Same reasoning as customer_id above: resolve via item_id_map
            # (only populated if 'items' was imported this run) or by
            # looking the item up live by name, never by trusting the raw
            # backup id. bill_items.item_id is nullable (ON DELETE SET
            # NULL), so an unmatched item just becomes NULL - the bill
            # line still imports with its name/qty/price intact.
            new_item_id = _resolve_item_id(cur, it["item_id"], it["item_name"], item_id_map) if it["item_id"] else None
            # cost_at_sale: what the batches this line actually consumed
            # came to, frozen when it was sold. .get() because a backup
            # made before cost layers existed has no such column - and
            # NULL is exactly what the profit queries fall back on.
            cur.execute("""INSERT INTO bill_items (bill_id, item_id, item_name, quantity, price_per_unit,
                            final_price, pack_qty, pack_unit_name, pack_size, cost_at_sale)
                            VALUES (?,?,?,?,?,?,?,?,?,?)""",
                        (new_bill_id, new_item_id, it["item_name"], it["quantity"], it["price_per_unit"],
                         it["final_price"], it.get("pack_qty"), it.get("pack_unit_name") or "",
                         it.get("pack_size"), it.get("cost_at_sale")))

        for lg in entry["ledger"]:
            # customer_ledger.customer_id is NOT NULL - _get_or_create_customer_id()
            # only returns None when the bill had no usable name at all,
            # which should be rare; skip rather than crash if it happens.
            if new_customer_id is None:
                continue
            reference = lg["reference"]
            if entry.get("number_collision"):
                # Point this ledger row at the freshly-minted bill_number
                # instead of the old (colliding) one, so the khata stays
                # correctly linked to the bill it actually belongs to.
                reference = reference.replace(row["bill_number"], bill_number)
            cur.execute("""INSERT INTO customer_ledger (customer_id, transaction_date, transaction_type,
                            reference, debit, credit, notes, created_at) VALUES (?,?,?,?,?,?,?,?)""",
                        (new_customer_id, lg["transaction_date"], lg["transaction_type"], reference,
                         lg["debit"], lg["credit"], lg["notes"], lg["created_at"]))

    # Khata (standalone, already deduped in scan_import - no conflicts to resolve).
    # These rows carry no customer name of their own (only a raw
    # customer_id), so unlike bills, there's nothing to auto-create a
    # customer FROM if it can't be resolved - it's skipped instead.
    for entry in plan["khata"]:
        row = entry["row"]
        new_customer_id = _resolve_customer_id(cur, row["customer_id"], row.get("customer_name", ""),
                                                row.get("customer_phone", ""), customer_id_map)
        if new_customer_id is None:
            # customer_ledger.customer_id is NOT NULL - can't insert an
            # orphaned ledger row, so skip it and count it as skipped
            # rather than silently dropping it with no record.
            summary["khata"]["skipped"] += 1
            continue
        cur.execute("""INSERT INTO customer_ledger (customer_id, transaction_date, transaction_type, reference,
                        debit, credit, notes, created_at) VALUES (?,?,?,?,?,?,?,?)""",
                    (new_customer_id, row["transaction_date"], row["transaction_type"], row["reference"],
                     row["debit"], row["credit"], row["notes"], row["created_at"]))
        summary["khata"]["added"] += 1

    # Inventory history (standalone log, already deduped - no conflicts).
    # inventory_transactions.item_id has no foreign key constraint, so
    # this can't crash the import, but resolving it properly (instead of
    # trusting the raw backup id) keeps the stock-history log pointing at
    # the right item on this machine rather than a coincidentally-matching
    # id or a stale one.
    for entry in plan["inventory_history"]:
        row = entry["row"]
        new_item_id = _resolve_item_id(cur, row["item_id"], row["item_name"], item_id_map) if row["item_id"] else None
        cur.execute("""INSERT INTO inventory_transactions (item_id, item_name, change_type, quantity_change,
                        resulting_quantity, reference, notes, created_at) VALUES (?,?,?,?,?,?,?,?)""",
                    (new_item_id, row["item_name"], row["change_type"], row["quantity_change"],
                     row["resulting_quantity"], row["reference"], row["notes"], row["created_at"]))
        summary["inventory_history"]["added"] += 1

    # Employees, attendance marks, advances and payroll runs. Processed
    # in the order scan_import() built plan["attendance"] in - every
    # "employee" entry before any "mark"/"advance"/"payroll" entry - so
    # employee_id_map is already populated with this run's employees by
    # the time anything needs to resolve one.
    for entry in plan["attendance"]:
        kind = entry["kind"]

        if kind == "employee":
            row, conflict = entry["row"], entry["conflict"]
            if conflict is None:
                cur.execute("""INSERT INTO employees (name, phone, role, pay_type, pay_rate, joined_date,
                                active, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                            (row["name"], row.get("phone") or "", row.get("role") or "",
                             row.get("pay_type") or "monthly", row.get("pay_rate") or 0,
                             row.get("joined_date"), row.get("active", 1), row.get("notes") or "",
                             row.get("created_at"), row.get("updated_at")))
                employee_id_map[entry["backup_id"]] = cur.lastrowid
                summary["attendance"]["added"] += 1
            elif conflict.resolution == "overwrite":
                cur.execute("""UPDATE employees SET role=?, pay_type=?, pay_rate=?, joined_date=?,
                                notes=?, updated_at=? WHERE id=?""",
                            (row.get("role") or "", row.get("pay_type") or "monthly",
                             row.get("pay_rate") or 0, row.get("joined_date"), row.get("notes") or "",
                             db.now_str(), conflict.existing_id))
                employee_id_map[entry["backup_id"]] = conflict.existing_id
                summary["attendance"]["updated"] += 1
            else:
                employee_id_map[entry["backup_id"]] = conflict.existing_id
                summary["attendance"]["skipped"] += 1
            continue

        if kind == "mark":
            row, conflict = entry["row"], entry["conflict"]
            if conflict is not None and conflict.resolution == "skip":
                summary["attendance"]["skipped"] += 1
                continue
            new_emp_id = _get_or_create_employee_id(cur, entry["backup_emp_id"], entry.get("emp_name"),
                                                      entry.get("emp_phone"), employee_id_map)
            if new_emp_id is None:
                summary["attendance"]["skipped"] += 1
                continue
            if conflict is not None and conflict.resolution == "overwrite":
                cur.execute("UPDATE attendance SET status=?, shifts=?, notes=?, marked_at=? WHERE id=?",
                            (row["status"], row.get("shifts") or 1, row.get("notes") or "",
                             row.get("marked_at"), conflict.existing_id))
                summary["attendance"]["updated"] += 1
            else:
                cur.execute("""INSERT OR IGNORE INTO attendance (employee_id, date, status, shifts, notes,
                                marked_at) VALUES (?,?,?,?,?,?)""",
                            (new_emp_id, row["date"], row["status"], row.get("shifts") or 1,
                             row.get("notes") or "", row.get("marked_at")))
                summary["attendance"]["added"] += 1
            continue

        if kind == "advance":
            row = entry["row"]
            new_emp_id = _get_or_create_employee_id(cur, entry["backup_emp_id"], entry.get("emp_name"),
                                                      entry.get("emp_phone"), employee_id_map)
            if new_emp_id is None:
                summary["attendance"]["skipped"] += 1
                continue
            # Always imported as outstanding (settled=0, no payroll_id) -
            # a backup's raw payroll_id is a row id from another database
            # and almost certainly does not point at anything real here;
            # see _get_or_create_employee_id's docstring for the same
            # reasoning applied to raw ids in general.
            cur.execute("""INSERT INTO employee_advances (employee_id, date, amount, notes, settled,
                            payroll_id, created_at) VALUES (?,?,?,?,0,NULL,?)""",
                        (new_emp_id, row["date"], row["amount"], row.get("notes") or "",
                         row.get("created_at")))
            summary["attendance"]["added"] += 1
            continue

        if kind == "payroll":
            row, conflict = entry["row"], entry["conflict"]
            if conflict is not None and conflict.resolution == "skip":
                summary["attendance"]["skipped"] += 1
                continue
            new_emp_id = _get_or_create_employee_id(cur, entry["backup_emp_id"], entry.get("emp_name"),
                                                      entry.get("emp_phone"), employee_id_map)
            if new_emp_id is None:
                summary["attendance"]["skipped"] += 1
                continue
            if conflict is not None and conflict.resolution == "overwrite":
                cur.execute("""UPDATE payroll_runs SET present_days=?, half_days=?, absent_days=?,
                                leave_days=?, gross_pay=?, advances_deducted=?, net_pay=?, status=?,
                                paid_date=?, notes=? WHERE id=?""",
                            (row["present_days"], row["half_days"], row["absent_days"], row["leave_days"],
                             row["gross_pay"], row["advances_deducted"], row["net_pay"], row["status"],
                             row.get("paid_date"), row.get("notes") or "", conflict.existing_id))
                summary["attendance"]["updated"] += 1
            else:
                cur.execute("""INSERT INTO payroll_runs (employee_id, period_month, present_days, half_days,
                                absent_days, leave_days, gross_pay, advances_deducted, net_pay, status,
                                paid_date, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                            (new_emp_id, row["period_month"], row["present_days"], row["half_days"],
                             row["absent_days"], row["leave_days"], row["gross_pay"],
                             row["advances_deducted"], row["net_pay"], row["status"],
                             row.get("paid_date"), row.get("notes") or "", row.get("created_at")))
                summary["attendance"]["added"] += 1
            continue

    conn.commit()
    conn.close()
    return summary
