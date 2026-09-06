#!/usr/bin/env python3
"""
selftest.py - exercises every bridge.Api method against a disposable
COPY of a seeded database (never the original data/balaji_billing.seed.db),
with a stubbed `webview` module so this runs headless (no pywebview, no
real desktop window, no GUI toolkit needed at all).

Run with:  python3 selftest.py
Leave this file in place - it is a permanent regression check for the
bridge, not a one-off script.
"""

import os
import shutil
import sys
import tempfile
import types

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(APP_DIR, "data")
SEED_DB = os.path.join(DATA_DIR, "balaji_billing.seed.db")
WORKING_DB = os.path.join(DATA_DIR, "balaji_billing.db")

PASS, FAIL = [], []


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print(f"PASS  {name}" + (f"  ({detail})" if detail else ""))
    else:
        FAIL.append((name, detail))
        print(f"FAIL  {name}" + (f"  -- {detail}" if detail else ""))


def call(api, method, *args, **kwargs):
    """Calls an Api method and returns (ok, data_or_error)."""
    fn = getattr(api, method)
    res = fn(*args, **kwargs)
    return res.get("ok"), (res.get("data") if res.get("ok") else res.get("error"))


# ---------------------------------------------------------------------
# 1. Reset the working DB from the seed copy - a fresh, known starting
#    point every run, and the seed file itself is NEVER written to.
# ---------------------------------------------------------------------
if not os.path.isfile(SEED_DB):
    print(f"FATAL: seed database not found at {SEED_DB}")
    sys.exit(2)
os.makedirs(DATA_DIR, exist_ok=True)
shutil.copy2(SEED_DB, WORKING_DB)
print(f"Working DB reset from seed: {WORKING_DB}")


# ---------------------------------------------------------------------
# 2. Stub `webview` BEFORE importing bridge.py, which imports it at
#    module level (exactly as the real pywebview app would provide it).
# ---------------------------------------------------------------------
class _FakeWindow:
    def __init__(self):
        self.open_result = None   # what the "Open" dialog should return next
        self.save_result = None   # what the "Save" dialog should return next

    def create_file_dialog(self, dialog_type, save_filename=None, file_types=()):
        if dialog_type == fake_webview.SAVE_DIALOG:
            if self.save_result:
                return self.save_result
            return os.path.join(tempfile.gettempdir(), save_filename or "out.tmp")
        return [self.open_result] if self.open_result else None


fake_webview = types.ModuleType("webview")
fake_webview.OPEN_DIALOG = "open"
fake_webview.SAVE_DIALOG = "save"
fake_window = _FakeWindow()
fake_webview.windows = [fake_window]
sys.modules["webview"] = fake_webview

import bridge  # noqa: E402  (must come after the webview stub above)
import database as db  # noqa: E402

# Migrate the working copy exactly as nova.py does on every real start.
#
# Without this the suite ran the CURRENT bridge against a seed database
# frozen at whatever schema it was captured with, so every feature added
# since - cost price, attendance, cost layers - failed here with "table
# has no column named ..." while working perfectly in the app. That is
# the worst kind of test: red for a reason that isn't a bug, which
# trains you to ignore it.
#
# Running it here is also the more faithful test: an old database being
# opened by a new build IS the upgrade path every existing shop takes,
# and now the suite exercises it on every run.
db.init_db()

api = bridge.Api()

print(f"bridge.py loaded OK; database at {db.DB_PATH}")

# ---------------------------------------------------------------------
# 3. Read-only methods
# ---------------------------------------------------------------------
ok, data = call(api, "bootstrap")
check("bootstrap", ok and "settings" in data and "app" in data, data if not ok else "")

ok, data = call(api, "quick_search", "raj")
check("quick_search", ok and isinstance(data, list), data if not ok else f"{len(data)} hits")

for rng in ("today", "week", "month", "all"):
    ok, data = call(api, "dashboard", rng)
    good = ok and "kpis" in data and "daily" in data and "heatmap" in data and "ageing" in data
    check(f"dashboard({rng!r})", good, data if not ok else f"revenue={data['kpis']['revenue']}")

ok, data = call(api, "items_snapshot")
check("items_snapshot", ok and isinstance(data, list) and len(data) > 0, data if not ok else f"{len(data)} items")
first_item = data[0] if ok and data else None

ok, data = call(api, "customers_snapshot")
check("customers_snapshot", ok and isinstance(data, list) and len(data) > 0, data if not ok else f"{len(data)} customers")
first_customer = data[0] if ok and data else None

ok, data = call(api, "customer_balance", first_customer["id"])
check("customer_balance", ok and isinstance(data, (int, float)), data if not ok else data)

ok, data = call(api, "next_bill_number")
check("next_bill_number", ok and isinstance(data, str) and len(data) == 8, data if not ok else data)

ok, data = call(api, "stock_levels", [first_item["id"]])
check("stock_levels", ok and str(first_item["id"]) in data, data if not ok else data)

ok, data = call(api, "get_bills", "")
check("get_bills", ok and isinstance(data, list) and len(data) > 0, data if not ok else f"{len(data)} bills")
first_bill_id = data[0]["id"] if ok and data else None

ok, data = call(api, "get_bill", first_bill_id)
check("get_bill", ok and data.get("items"), data if not ok else f"bill {data['bill_number']}, {len(data['items'])} lines")

ok, data = call(api, "get_items", "")
check("get_items (alias get_all_items)", ok and isinstance(data, list) and len(data) > 0, data if not ok else f"{len(data)} items")

ok, data = call(api, "inventory_transactions", "")
check("inventory_transactions", ok and isinstance(data, list), data if not ok else f"{len(data)} rows")

ok, data = call(api, "get_customers", "")
check("get_customers (alias customers_overview)", ok and all("balance" in c for c in data), data if not ok else f"{len(data)} customers")

ok, data = call(api, "customers_with_dues")
check("customers_with_dues", ok and isinstance(data, list), data if not ok else f"{len(data)} with dues")

ok, data = call(api, "customer_ledger", first_customer["id"])
check("customer_ledger", ok and isinstance(data, list), data if not ok else f"{len(data)} entries")

ok, data = call(api, "customer_kpis", first_customer["id"])
check("customer_kpis", ok and "total_revenue" in data and "balance" in data, data if not ok else data)

ok, data = call(api, "customer_bills", first_customer["id"])
check("customer_bills", ok and isinstance(data, list), data if not ok else f"{len(data)} bills")

ok, data = call(api, "customer_products", first_customer["id"])
check("customer_products", ok and isinstance(data, list), data if not ok else f"{len(data)} products")
if ok and data:
    ok2, data2 = call(api, "customer_product_history", first_customer["id"], data[0]["item_name"])
    check("customer_product_history", ok2 and isinstance(data2, list), data2 if not ok2 else f"{len(data2)} rows")
else:
    check("customer_product_history", True, "skipped - customer has no product history to query")

ok, data = call(api, "get_settings")
check("get_settings", ok and "store_name" in data, data if not ok else list(data.keys()))

ok, data = call(api, "list_users")
check("list_users", ok and isinstance(data, list), data if not ok else f"{len(data)} users")

ok, data = call(api, "audit_log", "")
check("audit_log", ok and isinstance(data, list), data if not ok else f"{len(data)} rows")

ok, data = call(api, "data_dir")
check("data_dir", ok and isinstance(data, str) and os.path.isdir(data), data)

ok, data = call(api, "pdf_list")
check("pdf_list", ok and isinstance(data, list), data if not ok else f"{len(data)} bills listed")

ok, data = call(api, "open_folder", "data")
check("open_folder", ok, data if not ok else "")

ok, data = call(api, "reveal", first_bill_id)
check("reveal", ok, data if not ok else "")

ok, data = call(api, "open_pdf", first_bill_id)
check("open_pdf", ok, data if not ok else "")

ok, data = call(api, "print_bill", first_bill_id)
check("print_bill", ok, data if not ok else "")

ok, data = call(api, "send_whatsapp", first_bill_id, "9876543210")
# selenium is intentionally not installed in this test environment - a
# clean, friendly failure (not a crash) is the correct/expected result.
check("send_whatsapp (expected friendly failure - selenium not installed)",
      ok is False and isinstance(data, str) and len(data) > 0, data)


# ---------------------------------------------------------------------
# 4. create_bill / update_bill / delete_bill round-trip - the part that
#    must actually mutate the DB correctly (stock + ledger effects).
# ---------------------------------------------------------------------
item = first_item
before_qty = db.get_item(item["id"])["quantity"]
before_bill_count = len(db.get_all_bills())

new_customer_name = "Selftest Customer"
qty_sold = 3.0
payload = {
    "bill_id": None,
    "customer_id": None,
    "customer_name": new_customer_name,
    "customer_phone": "9123456780",
    "customer_address": "Test Lane, Balangir",
    "bill_date": "", "bill_time": "",
    "items": [{
        "item_id": item["id"], "item_name": item["name"],
        "quantity": qty_sold, "price_per_unit": item["price"],
        "final_price": round(qty_sold * item["price"], 2),
    }],
    "freight_charges": 10, "discount": 5,
    "amount_paid": 20,       # deliberately less than total -> a khata debit
    "notes": "selftest bill", "bill_type": "sale",
}
ok, data = call(api, "create_bill", payload)
create_ok = ok and data.get("bill_id") and data.get("bill_number")
check("create_bill", create_ok, data if not ok else data)

if create_ok:
    bill_id = data["bill_id"]
    bill_number = data["bill_number"]

    check("create_bill: pdf generated (or a reported pdf_error, never silently missing)",
          data.get("pdf_path") is not None or data.get("pdf_error") is not None, data)

    after_qty = db.get_item(item["id"])["quantity"]
    check("create_bill: stock deducted by the sold quantity",
          abs((before_qty - qty_sold) - after_qty) < 1e-6,
          f"before={before_qty} sold={qty_sold} after={after_qty}")

    check("create_bill: appears in bills table",
          len(db.get_all_bills()) == before_bill_count + 1,
          f"{before_bill_count} -> {len(db.get_all_bills())}")

    saved = db.get_bill(bill_id)
    expected_total = round(payload["items"][0]["final_price"] + 10 - 5, 2)
    check("create_bill: saved bill has the right total",
          abs(saved["total"] - expected_total) < 1e-6,
          f"expected {expected_total}, got {saved['total']}")
    check("create_bill: customer name stored upper-case (matches _upper())",
          saved["customer_name"] == new_customer_name.upper(), saved["customer_name"])

    new_customers = [c for c in db.get_all_customers() if c["name"] == new_customer_name.upper()]
    check("create_bill: auto-created the new customer (strict-match upsert)",
          len(new_customers) == 1, [c["name"] for c in new_customers])
    cust_id = new_customers[0]["id"] if new_customers else None

    if cust_id:
        ledger = db.get_customer_ledger(cust_id)
        debit_rows = [r for r in ledger if r["transaction_type"] == "Invoice" and r["reference"] == bill_number]
        credit_rows = [r for r in ledger if r["transaction_type"] == "Payment"
                       and r["reference"] == f"Payment for {bill_number}"]
        check("create_bill: wrote an Invoice ledger row for the total",
              len(debit_rows) == 1 and abs(debit_rows[0]["debit"] - expected_total) < 1e-6,
              debit_rows)
        check("create_bill: wrote a Payment ledger row for the amount actually paid",
              len(credit_rows) == 1 and abs(credit_rows[0]["credit"] - 20) < 1e-6,
              credit_rows)

    # ---- update_bill: change the quantity, re-check stock + ledger ----
    new_qty_sold = 5.0
    update_payload = dict(payload)
    update_payload["bill_id"] = bill_id
    update_payload["customer_id"] = cust_id
    update_payload["items"] = [{
        "item_id": item["id"], "item_name": item["name"],
        "quantity": new_qty_sold, "price_per_unit": item["price"],
        "final_price": round(new_qty_sold * item["price"], 2),
    }]
    update_payload["amount_paid"] = round(new_qty_sold * item["price"] + 10 - 5, 2)  # paid in full this time

    ok, data = call(api, "update_bill", update_payload)
    check("update_bill", ok and data.get("bill_number") == bill_number, data if not ok else data)

    after_update_qty = db.get_item(item["id"])["quantity"]
    check("update_bill: stock reflects the NEW quantity, not old+new",
          abs((before_qty - new_qty_sold) - after_update_qty) < 1e-6,
          f"before={before_qty} new_sold={new_qty_sold} after={after_update_qty}")

    if cust_id:
        ledger2 = db.get_customer_ledger(cust_id)
        pay_rows2 = [r for r in ledger2 if r["transaction_type"] == "Payment"
                     and r["reference"] == f"Payment for {bill_number}"]
        check("update_bill: ledger rows were replaced, not duplicated",
              len(pay_rows2) == 1, pay_rows2)

    # ---- delete_bill: stock restored, ledger cleared ----
    ok, data = call(api, "delete_bill", bill_id, True)
    check("delete_bill", ok, data if not ok else "")
    after_delete_qty = db.get_item(item["id"])["quantity"]
    check("delete_bill: stock restored to the pre-bill level",
          abs(after_delete_qty - before_qty) < 1e-6,
          f"before={before_qty} after_delete={after_delete_qty}")
    if cust_id:
        ledger3 = db.get_customer_ledger(cust_id)
        remaining = [r for r in ledger3 if bill_number in (r["reference"] or "")]
        check("delete_bill: ledger rows for this bill are gone", len(remaining) == 0, remaining)


# ---------------------------------------------------------------------
# 5. Inventory writes
# ---------------------------------------------------------------------
ok, data = call(api, "add_item", {
    "item_code": "STZZZ", "name": "Selftest Widget", "category": "Test",
    "unit": "pcs", "price": 12.5, "low_stock_threshold": 5, "quantity": 40,
})
check("add_item", ok and isinstance(data, int), data if not ok else f"id={data}")
new_item_id = data if ok else None

if new_item_id:
    ok, data = call(api, "update_item", new_item_id, {
        "item_code": "STZZZ", "name": "Selftest Widget", "category": "Test",
        "unit": "pcs", "price": 15.0, "low_stock_threshold": 5,
    })
    check("update_item (quantity left unchanged)", ok, data if not ok else "")
    unchanged = db.get_item(new_item_id)
    check("update_item: quantity really was left unchanged",
          abs(unchanged["quantity"] - 40) < 1e-6, unchanged["quantity"])

    ok, data = call(api, "adjust_stock", new_item_id, 10, "Restock", "selftest restock")
    check("adjust_stock (+10)", ok, data if not ok else "")
    after_adjust = db.get_item(new_item_id)["quantity"]
    check("adjust_stock: quantity increased by 10", abs(after_adjust - 50) < 1e-6, after_adjust)

    ok, data = call(api, "delete_item", new_item_id)
    check("delete_item", ok and db.get_item(new_item_id) is None, data if not ok else "")

ok, data = call(api, "reset_all_stock")
check("reset_all_stock", ok, data if not ok else "")
check("reset_all_stock: every item now at zero",
      all(i["quantity"] == 0 for i in db.get_all_items()),
      [i["quantity"] for i in db.get_all_items()])

count_before_clear = len(db.get_inventory_transactions(limit=10_000_000))
ok, data = call(api, "clear_inventory_transactions")
check("clear_inventory_transactions", ok and count_before_clear > 0, f"cleared {count_before_clear} rows")
check("clear_inventory_transactions: table really is empty",
      len(db.get_inventory_transactions()) == 0, len(db.get_inventory_transactions()))


# ---------------------------------------------------------------------
# 6. Customer writes
# ---------------------------------------------------------------------
ok, data = call(api, "add_customer", {"name": "Test Buyer", "phone": "9000000001", "address": "Nowhere"})
check("add_customer", ok and isinstance(data, int), data if not ok else f"id={data}")
new_cust_id = data if ok else None

if new_cust_id:
    ok, data = call(api, "update_customer", new_cust_id, {
        "name": "Test Buyer Updated", "phone": "9000000002", "address": "Somewhere", "notes": "note"})
    check("update_customer", ok, data if not ok else "")
    updated = db.get_customer(new_cust_id)
    check("update_customer: fields actually changed",
          updated["name"] == "TEST BUYER UPDATED" and updated["phone"] == "9000000002", updated)

    ok, data = call(api, "add_ledger_payment", new_cust_id, 100, "advance payment")
    check("add_ledger_payment", ok, data if not ok else "")
    bal = db.get_customer_balance(new_cust_id)
    check("add_ledger_payment: balance reflects the credit",
          abs(bal - (-100)) < 1e-6, bal)

    ok, data = call(api, "delete_customer", new_cust_id)
    check("delete_customer", ok and db.get_customer(new_cust_id) is None, data if not ok else "")


# ---------------------------------------------------------------------
# 7. Settings + users
# ---------------------------------------------------------------------
ok, data = call(api, "set_setting", "store_contact", "+91 90000 00000")
check("set_setting", ok and db.get_setting("store_contact") == "+91 90000 00000", data if not ok else "")

ok, data = call(api, "create_user", {
    # role=staff, not owner: db.delete_user() refuses to delete the last
    # remaining owner account (a real safety rule, not a bug) - using
    # staff here lets the delete_user round-trip below actually exercise
    # a normal delete instead of always hitting that guard.
    "username": "selftest_staff", "display_name": "Selftest Staff",
    "role": "staff", "password": "supersecret1",
})
check("create_user", ok and isinstance(data, int), data if not ok else data)
new_user_id = data if ok else None

if new_user_id:
    ok, data = call(api, "update_user", new_user_id, {"display_name": "Renamed Owner"})
    check("update_user", ok, data if not ok else "")
    ok, data = call(api, "delete_user", new_user_id)
    check("delete_user", ok, data if not ok else "")

ok, data = call(api, "auth_state")
check("auth_state", ok and "enabled" in data, data if not ok else data)

ok, data = call(api, "sign_out")
check("sign_out", ok, data if not ok else "")


# ---------------------------------------------------------------------
# 8. Backup / restore / import / export round trips (via the stubbed
#    file-dialog window)
# ---------------------------------------------------------------------
ok, data = call(api, "backup_now")
check("backup_now", ok and data.get("path") and os.path.isfile(data["path"]), data if not ok else data)
backup_path = data.get("path") if ok else None

if backup_path:
    fake_window.open_result = backup_path
    ok, data = call(api, "restore_backup")
    check("restore_backup", ok and isinstance(data, dict), data if not ok else data)

tmp_xlsx = os.path.join(tempfile.gettempdir(), "selftest_export.xlsx")
fake_window.save_result = tmp_xlsx
ok, data = call(api, "export_items")
check("export_items", ok and os.path.isfile(tmp_xlsx), data if not ok else data)

if ok:
    fake_window.open_result = tmp_xlsx
    ok, data = call(api, "import_items")
    check("import_items", ok and isinstance(data, dict) and "added" in data, data if not ok else data)
    # every item that was just exported already exists -> everything
    # should come back as "skipped" (the safe default), nothing added.
    check("import_items: re-importing an unmodified export adds nothing new",
          ok and data.get("added", -1) == 0, data)


# ---------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------
print("\n" + "=" * 70)
print(f"selftest: {len(PASS)} passed, {len(FAIL)} failed, {len(PASS) + len(FAIL)} total")
if FAIL:
    print("Failed checks:")
    for name, detail in FAIL:
        print(f"  - {name}: {detail}")
print("=" * 70)
sys.exit(1 if FAIL else 0)
