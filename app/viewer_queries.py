"""
viewer_queries.py - read-only analytics queries for backup_viewer.py.

Mirrors the logic in database.py's ANALYTICS / CUSTOMER ANALYTICS
sections, but adapted to run against an arbitrary backup/archive SQLite
connection instead of the live app's database, and to identify a
customer by (name, phone) - always present directly on every bill row -
rather than by customer_id, which isn't reliable in a backup file: it may
have no customers table at all (archive files never include one), may
have been merged from several imports, or may simply be from a different
machine's row numbering.

Every function takes the read-only connection as its first argument.
"""


def _table_exists(conn, name):
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


def _column_exists(conn, table, column):
    return any(row["name"] == column
              for row in conn.execute(f"PRAGMA table_info({table})").fetchall())


def _sale_only_clause(conn, prefix=""):
    """"AND <prefix>bill_type = 'sale'", or "" for a backup taken before
    that column existed.

    Every bill in a file that old IS a sale - the column simply hadn't
    been invented yet - so omitting the clause there is exactly correct,
    not a compromise. Querying it directly on such a file would instead
    raise "no such column" and take the whole viewer down.
    """
    if not _column_exists(conn, "bills", "bill_type"):
        return ""
    return f" AND {prefix}bill_type = 'sale'"


def bills_date_range(conn):
    """Earliest and latest bill_date in the file, or (None, None) if there
    are no bills at all. Used to auto-size the Dashboard/Analytics view
    to whatever this specific file actually contains."""
    row = conn.execute("SELECT MIN(bill_date) as lo, MAX(bill_date) as hi FROM bills").fetchone()
    if not row or row["lo"] is None:
        return None, None
    return row["lo"], row["hi"]


# ---------------- store-wide (Dashboard tab) ----------------

def sales_summary(conn, date_from=None, date_to=None):
    # A purchase bill is stock coming in, not revenue, and must not
    # inflate what this shop sold - see _sale_only_clause.
    query = ("SELECT COUNT(*) as bill_count, COALESCE(SUM(total),0) as total_sales, "
             "COALESCE(SUM(freight_charges),0) as total_freight FROM bills "
             "WHERE 1=1" + _sale_only_clause(conn))
    params = []
    if date_from:
        query += " AND bill_date >= ?"
        params.append(date_from)
    if date_to:
        query += " AND bill_date <= ?"
        params.append(date_to)
    return dict(conn.execute(query, params).fetchone())


def top_selling_items(conn, limit=6, date_from=None, date_to=None):
    if not _table_exists(conn, "bill_items"):
        return []
    query = ("""
        SELECT bi.item_name, SUM(bi.quantity) as total_qty, SUM(bi.final_price) as total_revenue
        FROM bill_items bi JOIN bills b ON bi.bill_id = b.id WHERE 1=1
    """ + _sale_only_clause(conn, "b."))
    params = []
    if date_from:
        query += " AND b.bill_date >= ?"
        params.append(date_from)
    if date_to:
        query += " AND b.bill_date <= ?"
        params.append(date_to)
    query += " GROUP BY bi.item_name ORDER BY total_revenue DESC LIMIT ?"
    params.append(limit)
    return [dict(r) for r in conn.execute(query, params).fetchall()]


def sales_by_date(conn, date_from=None, date_to=None):
    query = "SELECT bill_date, SUM(total) as day_total FROM bills WHERE 1=1" + _sale_only_clause(conn)
    params = []
    if date_from:
        query += " AND bill_date >= ?"
        params.append(date_from)
    if date_to:
        query += " AND bill_date <= ?"
        params.append(date_to)
    query += " GROUP BY bill_date ORDER BY bill_date"
    return [dict(r) for r in conn.execute(query, params).fetchall()]


def top_customers(conn, limit=6, date_from=None, date_to=None):
    query = ("SELECT customer_name, COUNT(*) as bill_count, SUM(total) as total_spent FROM bills "
            "WHERE 1=1" + _sale_only_clause(conn))
    params = []
    if date_from:
        query += " AND bill_date >= ?"
        params.append(date_from)
    if date_to:
        query += " AND bill_date <= ?"
        params.append(date_to)
    query += " GROUP BY customer_name ORDER BY total_spent DESC LIMIT ?"
    params.append(limit)
    return [dict(r) for r in conn.execute(query, params).fetchall()]


def low_stock_items(conn):
    """Only meaningful if the file has an items table with stock levels
    (a plain Archive-Today's-Bills file never does - only a fuller
    'Backup Data' export with Items ticked would)."""
    if not _table_exists(conn, "items"):
        return []
    return [dict(r) for r in conn.execute(
        "SELECT * FROM items WHERE quantity <= low_stock_threshold ORDER BY quantity ASC"
    ).fetchall()]


# ---------------- per-customer (Analytics tab) ----------------

def customer_list(conn):
    """Distinct customers found in the file, identified by (name, phone),
    built directly from the bills table - every bill carries its
    customer's name/phone on the row itself, so this works whether or not
    a separate customers table is even present in the file.

    A purchase bill's "customer" is really the supplier the stock came
    from, so it is excluded here too - otherwise a supplier who never
    bought anything would show up in a list titled Customers.
    """
    rows = conn.execute("""
        SELECT customer_name, customer_phone, COUNT(*) as bill_count, MAX(bill_date) as last_purchase
        FROM bills WHERE 1=1""" + _sale_only_clause(conn) + """
        GROUP BY customer_name, customer_phone ORDER BY customer_name
    """).fetchall()
    return [dict(r) for r in rows]


def customer_kpis(conn, name, phone):
    row = conn.execute("""
        SELECT COUNT(id) as total_bills, COALESCE(SUM(total),0) as total_spent,
               MAX(bill_date) as last_purchase_date
        FROM bills WHERE customer_name=? AND customer_phone=?""" + _sale_only_clause(conn) + """
    """, (name, phone)).fetchone()
    kpis = dict(row)
    kpis["avg_order_value"] = kpis["total_spent"] / kpis["total_bills"] if kpis["total_bills"] else 0
    return kpis


def customer_bills(conn, name, phone):
    return [dict(r) for r in conn.execute(
        "SELECT * FROM bills WHERE customer_name=? AND customer_phone=?"
        + _sale_only_clause(conn) + " ORDER BY id DESC", (name, phone)
    ).fetchall()]


def customer_purchased_items(conn, name, phone):
    if not _table_exists(conn, "bill_items"):
        return []
    rows = conn.execute("""
        SELECT DISTINCT bi.item_name FROM bill_items bi JOIN bills b ON bi.bill_id = b.id
        WHERE b.customer_name=? AND b.customer_phone=?""" + _sale_only_clause(conn, "b.") + """
        ORDER BY bi.item_name
    """, (name, phone)).fetchall()
    return [r["item_name"] for r in rows]


def customer_product_history(conn, name, phone, item_name):
    rows = conn.execute("""
        SELECT b.bill_date, b.bill_number, bi.quantity, bi.price_per_unit, bi.final_price
        FROM bill_items bi JOIN bills b ON bi.bill_id = b.id
        WHERE b.customer_name=? AND b.customer_phone=? AND bi.item_name=?""" + _sale_only_clause(conn, "b.") + """
        ORDER BY b.id DESC
    """, (name, phone, item_name)).fetchall()
    return [dict(r) for r in rows]


def customer_ledger_for_customer(conn, name, phone):
    """Ledger/khata entries linked to this customer's bills, matched by
    reference (bill_number, or 'Payment for <bill_number>') rather than
    by customer_id - customer_id isn't trustworthy in a backup/merged
    file, but every ledger row tied to a bill always references that
    bill's number (see database.py's create_bill / payment recording)."""
    if not _table_exists(conn, "customer_ledger"):
        return []
    bill_numbers = [r["bill_number"] for r in conn.execute(
        "SELECT bill_number FROM bills WHERE customer_name=? AND customer_phone=?", (name, phone)
    ).fetchall()]
    if not bill_numbers:
        return []
    refs = bill_numbers + [f"Payment for {bn}" for bn in bill_numbers]
    placeholders = ",".join("?" * len(refs))
    rows = conn.execute(
        f"SELECT * FROM customer_ledger WHERE reference IN ({placeholders}) "
        f"ORDER BY date(transaction_date) ASC, id ASC", refs
    ).fetchall()
    return [dict(r) for r in rows]
