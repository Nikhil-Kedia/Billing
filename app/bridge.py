"""
bridge.py - the Api class exposed to the pywebview JS frontend as
`window.pywebview.api`.

This module is the ONLY thing in this rewrite that is new/hand-written on
top of the original app's data layer - everything it calls (database.py,
validation.py, security.py, pdf_generator.py, backup_restore.py,
inventory_io.py, auto_backup.py, whatsapp_sender.py, brand.py, appdata.py,
safe_paths.py, applog.py) is copied from the original Tkinter app
UNCHANGED, so every business rule (bill numbering, stock math, ledger
bookkeeping, validation limits, permission model, backup exclusions) is
exactly what a shop's existing data already expects.

CONTRACT WITH THE UI (see /home/claude/nova/web/js/api.js)
------------------------------------------------------------
Every public method (i.e. everything not starting with `_`) is wrapped by
the `@api_method` decorator below, which:
  - always returns {"ok": True, "data": <json-safe value>} on success,
  - always returns {"ok": False, "error": <plain-English message>,
    "title": <short title>} on failure - NEVER a raw traceback,
  - always sends the real exception to the log file via applog, so a
    support conversation can find out what actually happened even though
    the user only ever sees the friendly sentence.

PERMISSIONS - what is (and isn't) gated, and why
------------------------------------------------------------
`security.py`'s own docs and the behavioural spec extracted from the
original GUI (specs 02/03/05) say plainly that a few permissions that
*exist* in security.py were never actually wired up in the old Tkinter
screens - `PERM_DELETE_CUSTOMER` (customers_tab.py never calls
security.require for it) and `PERM_LEDGER_PAYMENT` (khata_tab.py never
calls it either, and never wrote an audit-log entry for a manual
payment). "Respect security.py permissions exactly as the old GUI did"
therefore means reproducing that looseness deliberately, not silently
"fixing" it into something stricter that would surprise an existing
Owner/Staff setup:

    delete_customer      -> NOT gated (matches the old bug/behaviour)
    add_ledger_payment   -> NOT gated, NOT audit-logged (same)

Everything else below IS gated, using the label that appears in
`security.PERMISSION_LABELS` so a denial message reads exactly the way
`security.require()` already writes it:

    update_bill                          PERM_EDIT_BILL
    delete_bill                          PERM_DELETE_BILL
    add_item / update_item / delete_item /
      adjust_stock                       PERM_MANAGE_INVENTORY
    reset_all_stock                      PERM_RESET_INVENTORY
    clear_inventory_transactions         PERM_CLEAR_STOCK_HISTORY
    customer_kpis / customer_products /
      customer_product_history           PERM_VIEW_ANALYTICS   (the
                                          "Customer Insights" screen -
                                          customer_bills is also used by
                                          the plain Customers screen, so
                                          it is left ungated, same as the
                                          old nav table: only
                                          `customer_analytics` itself
                                          carries a permission)
    set_setting                          PERM_MANAGE_SETTINGS
    backup_now                           PERM_BACKUP_DATA
    restore_backup / import_items /
      export_items                       PERM_IMPORT_DATA (the plain
                                          inventory CSV export isn't its
                                          own permission in security.py;
                                          treated the same as import
                                          since the Settings screen's own
                                          "Only the store owner can..."
                                          copy gates both identically)
    create_user / update_user /
      delete_user                        PERM_MANAGE_USERS
    audit_log                            PERM_VIEW_AUDIT_LOG
    create_bill, everything read-only    ungated (day-to-day counter
                                          work - creating bills,
                                          searching, opening a PDF,
                                          sending WhatsApp)

When `database.is_auth_enabled()` is False, `security.has_permission()`
always returns True regardless of the above, so none of this changes
anything for a shop that has never turned sign-in on.
"""

import io
import os
import sys
import sqlite3
import subprocess
import functools
import calendar
import csv
import threading
import time
from datetime import datetime, date, timedelta
from decimal import Decimal

import applog
import appdata
import brand
import database as db
import validation
from validation import ValidationError
import security
import safe_paths
import auto_backup
import backup_restore as br
import backup_crypto
import inventory_io
import updater


def pdf_generator():
    """The PDF engine, loaded the first time a bill is actually printed.

    reportlab (and the Pillow it pulls in) costs about a second to import
    and is only needed at save time, so it stays out of the cold start -
    the same deferral the original app used. It also means a problem in
    the PDF stack degrades to "this bill's PDF failed" instead of an app
    that refuses to open at all.
    """
    import pdf_generator as _pdf
    return _pdf

# webview is only importable inside the real desktop app / the selftest's
# stub - never at plain `python -c "import bridge"` time on a dev box
# without pywebview installed, which is why nova.py's own import of this
# module happens after pywebview is confirmed available. See selftest.py
# for how a headless test provides a fake `webview` module.
import webview


# ---------------------------------------------------------------------
# JSON safety / the {ok, data} | {ok, error, title} envelope
# ---------------------------------------------------------------------

def _json_safe(value):
    """Recursively coerces a Python value into something json.dumps (and
    therefore pywebview's JS bridge) can carry without surprises:
    sqlite3.Row -> dict, Decimal -> float, tuples -> lists, etc."""
    if isinstance(value, sqlite3.Row):
        return {k: _json_safe(value[k]) for k in value.keys()}
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(v) for v in value]
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def ok(data=None):
    return {"ok": True, "data": _json_safe(data)}


def bad(message, title=None):
    return {"ok": False, "error": str(message), "title": title or "Something went wrong"}


# Exceptions whose .args[0] is ALREADY a plain-English sentence safe to
# show verbatim - these never need a log-file reference code, they need
# to reach the user as-is (this is the whole point of validation.py and
# security.py's own message design).
_FRIENDLY_EXCEPTIONS = (
    ValidationError,
    security.PermissionDenied,
    ValueError,
    inventory_io.ImportError_,
    backup_crypto.BackupCryptoError,
)


def api_method(fn):
    """Wraps every Api method: success -> {ok:True, data}; failure ->
    {ok:False, error, title}, and NEVER lets a traceback reach the UI."""
    @functools.wraps(fn)
    def wrapper(self, *args, **kwargs):
        try:
            result = fn(self, *args, **kwargs)
            return ok(result)
        except _FRIENDLY_EXCEPTIONS as e:
            applog.warn(f"{fn.__name__}: {e}")
            title = "Not allowed" if isinstance(e, security.PermissionDenied) else "Check the details"
            return bad(str(e), title)
        except sqlite3.Error as e:
            # Archive viewing mode opens the database read-only at the
            # SQLite level (see database.open_archive), so any write -
            # including one from a screen that has not been taught about
            # archives yet - lands here. Translating it once, at the one
            # place every call passes through, means nothing has to be
            # kept in step with a list of blocked methods.
            if db.is_read_only() and "readonly" in str(e).lower():
                return bad(
                    "This is an archived copy of past trading, opened for reading.\n\n"
                    "Nothing in it can be changed. Open the app itself to make changes.",
                    "Archived snapshot")
            msg = applog.friendly_db_error(e, "That could not be saved. Please try again.", fn.__name__)
            return bad(msg, "Something went wrong")
        except Exception as e:
            ref = applog.report_error(e, fn.__name__)
            return bad(
                f"Something went wrong and this action could not be completed.\n\n"
                f"If this keeps happening, quote reference {ref}.",
                "Something went wrong",
            )
    return wrapper


# ---------------------------------------------------------------------
# small OS helpers - Windows-first, with a graceful fallback so the
# bridge is still importable/testable on macOS/Linux dev machines
# ---------------------------------------------------------------------

def _open_file(path):
    """Best-effort "open with the OS default handler". Never raises -
    failing to auto-open a PDF must not fail the action that produced it."""
    try:
        if sys.platform.startswith("win"):
            os.startfile(path)  # noqa: F821 (Windows-only attribute)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
    except Exception as e:
        applog.warn(f"Could not auto-open {path}: {e}")


def _print_file(path):
    """os.startfile(path, 'print') on Windows; elsewhere there is no
    equivalent "print with the default handler" verb, so this falls back
    to just opening the file so the user can print it themselves."""
    if sys.platform.startswith("win"):
        try:
            os.startfile(path, "print")  # noqa: F821
            return
        except Exception as e:
            applog.warn(f"os.startfile print failed for {path}: {e}")
    _open_file(path)


def _reveal_file(path):
    """Shows the file selected in the OS file manager, falling back to
    just opening its containing folder."""
    folder = os.path.dirname(path)
    try:
        if sys.platform.startswith("win"):
            subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
            return
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", path])
            return
    except Exception as e:
        applog.warn(f"Could not reveal {path}: {e}")
    _open_file(folder)


def _open_folder(path):
    os.makedirs(path, exist_ok=True)
    _open_file(path)


def _public_user(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row.get("display_name") or row["username"],
        "role": row["role"],
    }


def _all_settings():
    """database.py only exposes get_setting(key) one at a time - there is
    no bulk read. Rather than add one to the copied, unmodified module,
    this reads the small key/value table directly with its own
    connection, exactly the way every other database.py function does."""
    conn = db.get_connection()
    try:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        return {r["key"]: r["value"] for r in rows}
    finally:
        conn.close()


# ---------------------------------------------------------------------
# Auto-update (Phase 2/3) - shared state between the quiet background
# check nova.py runs on startup and the Settings screen, so both agree
# on what was found without the UI ever making its own network call.
# ---------------------------------------------------------------------

_update_lock = threading.Lock()
_update_state = {
    "info": None,             # the feed dict once an update is known, else None
    "downloading": False,
    "downloaded": 0,
    "total": 0,
    "installer_path": None,
    "error": None,
}


def check_for_updates_background():
    """Called once from nova.py's startup maintenance thread. Populates
    _update_state so the UI can show a quiet notice without a network
    call of its own. updater.get_update_info() already throttles itself
    to once every UPDATE_CHECK_INTERVAL_HOURS unless forced, and fails
    silently when offline - never let this stop the app opening."""
    try:
        info = updater.get_update_info()
        if info:
            with _update_lock:
                _update_state["info"] = info
    except Exception as e:
        applog.report_error(e, "background update check")


# ---------------------------------------------------------------------
# The Api class
# ---------------------------------------------------------------------

class Api:
    """Every public method here is what `api.<name>(...)` calls from the
    JS side (see web/js/api.js's Proxy)."""

    # ------------------------------------------------------------ boot
    @api_method
    def bootstrap(self):
        settings = _all_settings()
        authed_user = _public_user(db.get_user(security.current.user_id)) \
            if security.current.is_authenticated else None
        return {
            "settings": settings,
            "user": authed_user,
            "track_stock": db.track_stock(),
            "track_khata": db.track_khata(),
            "app": {"name": brand.APP_NAME, "version": brand.APP_VERSION},
            "data_dir": appdata.data_dir(),
            "needs_auth": db.is_auth_enabled() and not security.current.is_authenticated,
            "can": self._permissions(),
            # True when this copy of the data has landed on a machine it
            # has never been used on - see security.device_fingerprint().
            # The sign-in screen turns this into a "Set up this device"
            # option so a pendrive copy is not a locked box.
            "can_claim_device": db.can_claim_device(),
            "owner_exists": db.count_owners() > 0,
            # Sign-in is switched ON but there is no owner account to
            # satisfy it. is_auth_enabled() treats that as "not really set
            # up" so the shop is not locked out of its own data - but it
            # must be said out loud rather than silently leaving the app
            # open, so the UI prompts for an owner account.
            "auth_needs_owner": (db.get_setting("auth_enabled", "0") == "1"
                                 and db.count_owners() == 0),
            # Opened by double-clicking an archive file: the whole app is
            # showing a past day and can change none of it.
            "archive": ({"path": db.archive_source_path(),
                          "name": os.path.basename(db.archive_source_path())}
                        if db.is_read_only() else None),
        }

    @staticmethod
    def _permissions():
        """What this user may do, answered by security.py itself.

        The UI must never work this out from a role string: with sign-in
        switched off there IS no signed-in user, so a "role == owner" test
        in a screen greys out buttons the backend would happily allow -
        which is exactly how Delete Bill ended up permanently disabled.
        security.has_permission() already returns True for everything when
        authentication is off, so asking it is both simpler and correct.

        This gates appearance only. Every privileged method still calls
        security.require() for itself - a disabled button is a courtesy,
        not a security boundary.
        """
        return {value: security.has_permission(value)
                for name, value in vars(security).items()
                if name.startswith("PERM_") and isinstance(value, str)}

    @api_method
    def quick_search(self, term):
        term = (term or "").strip()
        if not term:
            return []
        t = term.lower()
        customers = [c for c in db.customers_snapshot()["list"] if t in c["name"].lower()][:4]
        items = [i for i in db.items_snapshot()["list"]
                 if t in i["name"].lower() or t in (i.get("item_code") or "").lower()][:4]
        bills = db.get_all_bills(search=term)[:3]
        out = []
        out += [{"kind": "customer", "id": c["id"], "label": c["name"], "sub": c.get("phone") or ""}
                for c in customers]
        out += [{"kind": "item", "id": i["id"], "label": i["name"], "sub": i.get("item_code") or ""}
                for i in items]
        out += [{"kind": "bill", "id": b["id"], "label": "Bill " + b["bill_number"], "sub": b["customer_name"]}
                for b in bills]
        return out

    # ------------------------------------------------------------ dashboard
    @api_method
    def dashboard(self, range="month", month=None):
        return self._dashboard(range, month)

    @api_method
    def bill_date_bounds(self):
        """Earliest/latest bill dates on file, as 'YYYY-MM-DD' strings (or
        None if there are no bills yet) - lets the dashboard's month
        navigator know how far back it may step."""
        first, last = db.get_bill_date_bounds()
        return {"first": first, "last": last}

    def _dashboard_window(self, range_key, month=None):
        """(from, to, prev_from, prev_to, resolved_month) as ISO strings.

        Lifted out of _dashboard() so the Earnings screen resolves a
        range name to the very same dates. Two screens that both say
        "Month" and mean different months would make every profit figure
        on one of them look wrong.
        """
        if range_key not in ("today", "week", "month", "all"):
            range_key = "month"
        today = date.today()
        resolved_month = None

        if range_key == "today":
            cur_from = cur_to = today
        elif range_key == "week":
            cur_from, cur_to = today - timedelta(days=6), today
        elif range_key == "month":
            # Which calendar month to show - defaults to the current one,
            # but the dashboard's month navigator can ask for any month
            # between the very first bill on file and the current month.
            # Never trust the caller's string blindly: an invalid or
            # out-of-range value quietly falls back to the current month
            # rather than raising, exactly like the old range_key fallback
            # above - a stale month remembered client-side must never break
            # the screen.
            max_month = today.strftime("%Y-%m")
            first, _ = db.get_bill_date_bounds()
            min_month = first[:7] if first else max_month
            m = month if (isinstance(month, str) and len(month) == 7 and month[4] == "-"
                          and month[:4].isdigit() and month[5:].isdigit()) else max_month
            if m > max_month:
                m = max_month
            if m < min_month:
                m = min_month
            year, mon = int(m[:4]), int(m[5:7])
            cur_from = date(year, mon, 1)
            cur_to = date(year, mon, calendar.monthrange(year, mon)[1])
            if cur_to > today:
                cur_to = today
            resolved_month = m
        else:  # "all"
            first, last = db.get_bill_date_bounds()
            cur_from = date.fromisoformat(first) if first else today
            cur_to = today

        cur_from_s, cur_to_s = cur_from.isoformat(), cur_to.isoformat()

        prev_from_s = prev_to_s = None
        if range_key != "all":
            span = (cur_to - cur_from).days + 1
            prev_to = cur_from - timedelta(days=1)
            prev_from = prev_to - timedelta(days=span - 1)
            prev_from_s, prev_to_s = prev_from.isoformat(), prev_to.isoformat()

        return cur_from_s, cur_to_s, prev_from_s, prev_to_s, resolved_month

    def _dashboard(self, range_key, month=None):
        cur_from_s, cur_to_s, prev_from_s, prev_to_s, resolved_month = \
            self._dashboard_window(range_key, month)

        summary = db.get_sales_summary(cur_from_s, cur_to_s)
        prev_summary = db.get_sales_summary(prev_from_s, prev_to_s) if prev_from_s else None

        revenue = summary["total_sales"] or 0
        bills_n = summary["bill_count"] or 0
        avg = (revenue / bills_n) if bills_n else 0

        def pct(cur, prev):
            if not prev:
                return None
            return (cur - prev) / prev * 100.0

        revenue_delta = pct(revenue, prev_summary["total_sales"]) if prev_summary else None
        bills_delta = pct(bills_n, prev_summary["bill_count"]) if prev_summary else None
        prev_avg = None
        if prev_summary and prev_summary["bill_count"]:
            prev_avg = prev_summary["total_sales"] / prev_summary["bill_count"]
        avg_delta = pct(avg, prev_avg) if prev_avg else None

        outstanding_rows = db.get_customers_with_dues(limit=1_000_000)
        outstanding = sum(r["balance"] for r in outstanding_rows)
        low_stock = len(db.get_low_stock_items())

        daily = [{"date": r["bill_date"], "revenue": r["revenue"], "bills": r["bills"]}
                 for r in db.get_daily_performance(cur_from_s, cur_to_s)]
        if security.has_permission(security.PERM_VIEW_PROFIT):
            profit_by_date = {r["bill_date"]: r["profit"] for r in db.get_daily_profit(cur_from_s, cur_to_s)}
            for d in daily:
                d["profit"] = profit_by_date.get(d["date"], 0)

        top = db.get_top_products(limit=8, date_from=cur_from_s, date_to=cur_to_s)
        top_products = [{"name": r["item_name"], "qty": r["total_qty"], "revenue": r["total_revenue"]}
                         for r in top]

        weekday = db.get_revenue_by_weekday(cur_from_s, cur_to_s)
        matrix = db.get_day_hour_matrix(cur_from_s, cur_to_s)
        cc = db.get_cash_vs_credit(cur_from_s, cur_to_s)
        ageing = [{"bucket": r["label"], "amount": r["amount"]} for r in db.get_receivables_ageing()]
        acquisition = db.get_customer_acquisition(
            cur_from_s, cur_to_s, granularity="month" if range_key in ("month", "all") else "day")

        kpis = {
            "revenue": revenue, "revenue_delta": revenue_delta,
            "bills": bills_n, "bills_delta": bills_delta,
            "avg": avg, "avg_delta": avg_delta,
            "outstanding": outstanding, "outstanding_accounts": len(outstanding_rows),
            "low_stock": low_stock,
        }
        # Profit never leaves the server for a staff account - not just
        # hidden by the UI, not present in the payload at all.
        if security.has_permission(security.PERM_VIEW_PROFIT):
            profit_summary = db.get_profit_summary(cur_from_s, cur_to_s)
            prev_profit = db.get_profit_summary(prev_from_s, prev_to_s) if prev_from_s else None
            kpis["profit"] = profit_summary["profit"] or 0
            kpis["profit_delta"] = pct(kpis["profit"], prev_profit["profit"]) if prev_profit else None

        return {
            "kpis": kpis,
            "daily": daily,
            "top_products": top_products,
            "weekday": weekday,
            "heatmap": matrix["grid"],
            "cash_credit": {"collected": cc["collected"], "credit": cc["on_credit"]},
            "ageing": ageing,
            "acquisition": [{"label": r["period"], "count": r["new_customers"] + r["returning_customers"]}
                             for r in acquisition],
            # so the UI can confirm exactly what period was actually used -
            # e.g. after an out-of-range month got clamped server-side.
            "period": {"from": cur_from_s, "to": cur_to_s, "month": resolved_month},
        }

    # ------------------------------------------------------------ custom report (dashboard's chart builder)
    # x/y vocabulary shared with the JS side (see views/dashboard.js) - kept
    # as plain dicts here rather than an enum so a new grouping/measure is a
    # one-line addition on both ends.
    _REPORT_X = {
        "date":            "Date",
        "month":           "Month",
        "weekday":         "Day of week",
        "hour":            "Hour of day",
        "customer":        "Customer",
        "product":         "Product",
        "category":        "Product category",
        "payment_status":  "Payment status",
        "bill_type":       "Bill type",
    }
    _REPORT_Y = {
        "revenue":     "Revenue",
        "bills":       "Bill count",
        "items_sold":  "Items sold",
        "quantity":    "Quantity",
        "avg_bill":    "Average bill value",
        "collected":   "Amount collected",
        "outstanding": "Outstanding",
        "profit":      "Profit",
    }
    _REPORT_ITEM_LEVEL_X = ("product", "category")   # grouping lives in bill_items, not bills
    _REPORT_ITEM_MEASURES = ("items_sold", "quantity")  # need bill_items even for a bill-level grouping
    _REPORT_WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    def _report_bill_rows(self, conn, x, y, date_from, date_to, limit):
        """Every x that groups by something the `bills` row itself carries
        (a date part, the customer, payment status, or bill type)."""
        params = []
        where = "WHERE 1=1"
        # bill_type='bill type' is the one grouping that must NOT pre-filter
        # to sale-only - that would leave it with a single group and defeat
        # the point of the axis. Every other grouping follows the same
        # sale-only rule as the rest of the dashboard (see database.py's
        # own note above get_daily_performance et al.). Profit is the one
        # MEASURE that is never meaningful for a purchase line (its
        # price_per_unit is what was paid, not charged) - even when
        # grouping by bill_type itself, profit always stays sale-only, so
        # picking "Profit" while grouped by "Bill type" just shows one
        # Sale bar rather than a nonsense Purchase number.
        if x != "bill_type" or y == "profit":
            where += " AND b.bill_type = 'sale'"
        if date_from:
            where += " AND b.bill_date >= ?"; params.append(date_from)
        if date_to:
            where += " AND b.bill_date <= ?"; params.append(date_to)

        if x == "date":
            group_expr = "b.bill_date"
        elif x == "month":
            group_expr = "substr(b.bill_date, 1, 7)"
        elif x == "weekday":
            group_expr = "CAST(strftime('%w', b.bill_date) AS INTEGER)"
        elif x == "hour":
            group_expr = "CAST(substr(b.bill_time, 1, 2) AS INTEGER)"
            where += " AND b.bill_time IS NOT NULL AND b.bill_time != ''"
        elif x == "customer":
            group_expr = "b.customer_name"
        elif x == "payment_status":
            # Exactly history.js's statusOf() thresholds (0.009 tolerance
            # for float rounding), so a bill lands in the same bucket here
            # as it does on the Bill History screen.
            group_expr = ("CASE WHEN b.amount_paid - b.total >= -0.009 THEN 'Paid' "
                          "WHEN b.amount_paid <= 0.009 THEN 'Credit' "
                          "ELSE 'Partial' END")
        elif x == "bill_type":
            group_expr = "CASE WHEN b.bill_type = 'purchase' THEN 'Purchase' ELSE 'Sale' END"
        else:
            raise ValidationError("Unknown grouping.")

        if y == "profit":
            query = (f"SELECT {group_expr} AS label, "
                     f"COALESCE(SUM({db.SQL_LINE_PROFIT}),0) AS value "
                     f"FROM bills b JOIN bill_items bi ON bi.bill_id = b.id "
                     f"LEFT JOIN items i ON i.id = bi.item_id {where} GROUP BY label")
        elif y in self._REPORT_ITEM_MEASURES:
            agg = "SUM(bi.quantity)" if y == "quantity" else "COUNT(bi.id)"
            query = (f"SELECT {group_expr} AS label, COALESCE({agg},0) AS value "
                     f"FROM bills b JOIN bill_items bi ON bi.bill_id = b.id {where} GROUP BY label")
        else:
            if y == "revenue":
                agg = "SUM(b.total)"
            elif y == "bills":
                agg = "COUNT(*)"
            elif y == "avg_bill":
                agg = "SUM(b.total) * 1.0 / COUNT(*)"
            elif y == "collected":
                agg = "SUM(b.amount_paid)"
            elif y == "outstanding":
                agg = "SUM(CASE WHEN b.total - b.amount_paid > 0 THEN b.total - b.amount_paid ELSE 0 END)"
            else:
                raise ValidationError("Unknown measure.")
            query = f"SELECT {group_expr} AS label, COALESCE({agg},0) AS value FROM bills b {where} GROUP BY label"

        # High-cardinality groupings (customer) are ranked and capped by
        # Top N. Everything else has a small, fixed domain - returned in
        # label order (chronological for date/month, alphabetical for the
        # rest) rather than left to whatever order GROUP BY happens to
        # produce; weekday/hour are re-ordered again in _report_shape.
        if x == "customer":
            query += " ORDER BY value DESC LIMIT ?"
            params = params + [limit]
        else:
            query += " ORDER BY label"
        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]

    def _report_item_rows(self, conn, x, y, date_from, date_to, limit):
        """x = product or product category: the grouping itself lives on
        bill_items, one row per line sold rather than per bill."""
        params = []
        where = "WHERE b.bill_type = 'sale'"
        if date_from:
            where += " AND b.bill_date >= ?"; params.append(date_from)
        if date_to:
            where += " AND b.bill_date <= ?"; params.append(date_to)

        joins = "FROM bill_items bi JOIN bills b ON bi.bill_id = b.id"
        if x == "category":
            joins += " LEFT JOIN items i ON i.id = bi.item_id"
            group_expr = "COALESCE(NULLIF(i.category, ''), 'Uncategorised')"
        else:
            if y == "profit":
                joins += " LEFT JOIN items i ON i.id = bi.item_id"
            group_expr = "bi.item_name"

        if y == "profit":
            agg = f"SUM({db.SQL_LINE_PROFIT})"
        elif y == "revenue":
            agg = "SUM(bi.final_price)"
        elif y == "bills":
            agg = "COUNT(DISTINCT bi.bill_id)"
        elif y == "quantity":
            agg = "SUM(bi.quantity)"
        elif y == "items_sold":
            agg = "COUNT(bi.id)"
        elif y == "avg_bill":
            agg = "SUM(bi.final_price) * 1.0 / COUNT(DISTINCT bi.bill_id)"
        elif y == "collected":
            # Payment isn't recorded per line, so a bill's collected amount
            # is allocated across its lines in proportion to each line's
            # share of the bill total - the same idea get_cash_vs_credit
            # applies at the whole-bill level, just spread across items.
            agg = "SUM(bi.final_price * b.amount_paid / NULLIF(b.total,0))"
        elif y == "outstanding":
            agg = ("SUM(bi.final_price * "
                  "(CASE WHEN b.total - b.amount_paid > 0 THEN b.total - b.amount_paid ELSE 0 END) "
                  "/ NULLIF(b.total,0))")
        else:
            raise ValidationError("Unknown measure.")

        query = (f"SELECT {group_expr} AS label, COALESCE({agg},0) AS value "
                 f"{joins} {where} GROUP BY label ORDER BY value DESC LIMIT ?")
        params = params + [limit]
        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]

    def _report_shape(self, x, raw):
        """Fixed-domain groupings (weekday/hour) are zero-filled and put in
        a fixed, readable order; everything else is returned as-is (already
        ordered by the query above)."""
        if x == "weekday":
            by_dow = {r["label"]: r["value"] for r in raw if r["label"] is not None}
            out = []
            for i, name in enumerate(self._REPORT_WEEKDAY_NAMES):
                sqlite_dow = (i + 1) % 7          # Mon(0) -> 1 ... Sun(6) -> 0, same rotation as the weekday chart
                out.append({"label": name, "value": by_dow.get(sqlite_dow, 0) or 0})
            return out
        if x == "hour":
            by_hour = {r["label"]: r["value"] for r in raw if r["label"] is not None}
            return [{"label": f"{h:02d}:00", "value": by_hour.get(h, 0) or 0} for h in range(24)]
        out = []
        for r in raw:
            label = r["label"]
            label = "Unknown" if label is None or label == "" else str(label)
            out.append({"label": label, "value": r["value"] or 0})
        return out

    def _run_custom_report(self, spec):
        spec = spec or {}
        x, y = spec.get("x"), spec.get("y")
        if x not in self._REPORT_X:
            raise ValidationError("Please choose what to group by.")
        if y not in self._REPORT_Y:
            raise ValidationError("Please choose what to measure.")
        if y == "profit":
            security.require(security.PERM_VIEW_PROFIT)
        try:
            limit = int(spec.get("limit") or 10)
        except (TypeError, ValueError):
            limit = 10
        limit = max(1, min(50, limit))
        date_from = (spec.get("date_from") or "").strip() or None
        date_to = (spec.get("date_to") or "").strip() or None

        conn = db.get_connection()
        try:
            if x in self._REPORT_ITEM_LEVEL_X:
                raw = self._report_item_rows(conn, x, y, date_from, date_to, limit)
            else:
                raw = self._report_bill_rows(conn, x, y, date_from, date_to, limit)
        finally:
            conn.close()

        rows = self._report_shape(x, raw)
        total = sum(r["value"] for r in rows)
        return {
            "rows": rows,
            "x_label": self._REPORT_X[x],
            "y_label": self._REPORT_Y[y],
            "total": total,
        }

    @api_method
    def custom_report(self, spec):
        return self._run_custom_report(spec)

    @api_method
    def export_custom_report(self, spec):
        result = self._run_custom_report(spec)
        path = self._pick_save_file("custom_report.csv", ("CSV File (*.csv)",))
        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow([result["x_label"], result["y_label"]])
            for r in result["rows"]:
                w.writerow([r["label"], r["value"]])
            w.writerow([])
            w.writerow(["Total", "", result["total"]])
        db.log_audit("dashboard.export_custom_report",
                     f"{(spec or {}).get('x')} vs {(spec or {}).get('y')} -> {os.path.basename(path)}")
        return path

    # ------------------------------------------------------------ employee attendance & payroll
    # The whole module is gated on one permission - see
    # security.PERM_MANAGE_ATTENDANCE. It is never granted to staff (not
    # in security._STAFF_PERMISSIONS), so app.can.manage_attendance is
    # False for anyone but the owner and the nav item / screen simply
    # doesn't appear for them - the same "UI never re-derives
    # permissions" pattern as everything else in this file.

    @staticmethod
    def _valid_month(value, field_name="Month"):
        text = (value or "").strip()
        if len(text) == 7 and text[4] == "-" and text[:4].isdigit() and text[5:].isdigit():
            return text
        raise ValidationError(f"{field_name} must look like 2026-09.")

    def _read_employee_form(self, data):
        name = validation.clean_text(data.get("name"), 120, "Employee name", allow_empty=False)
        phone = validation.phone(data.get("phone"))
        role = validation.clean_text(data.get("role"), 60, "Role")
        pay_type = (data.get("pay_type") or "monthly").strip().lower()
        if pay_type not in ("monthly", "daily", "shift"):
            raise ValidationError("Pay type must be monthly, daily or per-shift.")
        pay_rate = validation.money(data.get("pay_rate") or 0, "Pay rate", allow_negative=False)
        joined = validation.bill_date(data.get("joined_date"), "Joined date") if data.get("joined_date") else None
        notes = validation.notes(data.get("notes"))
        return name, phone, role, pay_type, pay_rate, joined, notes

    @api_method
    def employees_list(self, include_inactive=False):
        security.require(security.PERM_MANAGE_ATTENDANCE)
        return db.get_employees(include_inactive=bool(include_inactive))

    @api_method
    def add_employee(self, data):
        security.require(security.PERM_MANAGE_ATTENDANCE)
        name, phone, role, pay_type, pay_rate, joined, notes = self._read_employee_form(data or {})
        employee_id = db.add_employee(name, phone, role, pay_type, pay_rate, joined, notes)
        db.log_audit("attendance.add_employee", f"{name} ({pay_type}, {employee_id})")
        return employee_id

    @api_method
    def update_employee(self, employee_id, data):
        security.require(security.PERM_MANAGE_ATTENDANCE)
        existing = db.get_employee(employee_id)
        if not existing:
            raise ValidationError("This employee could not be found. They may have been removed.")
        name, phone, role, pay_type, pay_rate, joined, notes = self._read_employee_form(data or {})
        db.update_employee(employee_id, name, phone, role, pay_type, pay_rate,
                            joined or existing.get("joined_date"), notes)
        db.log_audit("attendance.update_employee", f"{name} ({employee_id})")
        return True

    @api_method
    def set_employee_active(self, employee_id, active):
        security.require(security.PERM_MANAGE_ATTENDANCE)
        db.set_employee_active(employee_id, bool(active))
        db.log_audit("attendance.set_employee_active", f"{employee_id} -> {bool(active)}")
        return True

    @api_method
    def attendance_month(self, period_month):
        security.require(security.PERM_MANAGE_ATTENDANCE)
        period_month = self._valid_month(period_month)
        return db.get_attendance_month(period_month)

    @api_method
    def mark_attendance(self, employee_id, date_str, status, shifts=None):
        security.require(security.PERM_MANAGE_ATTENDANCE)
        date_str = validation.bill_date(date_str)
        if status not in ("present", "absent", "half", "leave", "clear"):
            raise ValidationError("Unknown attendance status.")
        shift_val = None
        if shifts is not None:
            shift_val = validation.quantity(shifts, "Shifts", allow_zero=True)
        db.mark_attendance(employee_id, date_str, status, shift_val)
        return True

    @api_method
    def mark_attendance_session(self, employee_id, date_str, session, status):
        """Marks one half of one day - 'am' or 'pm'. This is what the
        grid uses; mark_attendance() above still sets a whole day at
        once."""
        security.require(security.PERM_MANAGE_ATTENDANCE)
        date_str = validation.bill_date(date_str)
        if session not in ("am", "pm"):
            raise ValidationError("Attendance can only be marked for the morning or the evening.")
        if status not in ("present", "absent", "leave", "clear"):
            raise ValidationError("Unknown attendance status.")
        try:
            return db.mark_attendance_session(employee_id, date_str, session, status)
        except ValueError as e:
            raise ValidationError(str(e))

    @api_method
    def add_advance(self, employee_id, date_str, amount, notes=""):
        security.require(security.PERM_MANAGE_ATTENDANCE)
        if not db.get_employee(employee_id):
            raise ValidationError("This employee could not be found.")
        date_str = validation.bill_date(date_str)
        amount = validation.money(amount, "Advance amount")
        if amount <= 0:
            raise ValidationError("Advance amount must be more than zero.")
        notes = validation.notes(notes)
        advance_id = db.add_advance(employee_id, date_str, amount, notes)
        db.log_audit("attendance.add_advance", f"employee {employee_id}: Rs.{amount}")
        return advance_id

    @api_method
    def list_advances(self, employee_id=None, unsettled_only=False):
        security.require(security.PERM_MANAGE_ATTENDANCE)
        return db.get_advances(employee_id, bool(unsettled_only))

    @api_method
    def delete_advance(self, advance_id):
        security.require(security.PERM_MANAGE_ATTENDANCE)
        db.delete_advance(advance_id)
        db.log_audit("attendance.delete_advance", str(advance_id))
        return True

    @api_method
    def payroll_preview(self, employee_id, period_month):
        security.require(security.PERM_MANAGE_ATTENDANCE)
        period_month = self._valid_month(period_month)
        calc = db.compute_payroll(employee_id, period_month)
        if calc is None:
            raise ValidationError("This employee could not be found.")
        return calc

    @api_method
    def finalize_payroll(self, employee_id, period_month):
        security.require(security.PERM_MANAGE_ATTENDANCE)
        period_month = self._valid_month(period_month)
        existing = [p for p in db.get_payroll_runs(period_month, employee_id) if p["status"] == "paid"]
        if existing:
            raise ValidationError(
                "This month is already marked paid for this employee.\n\n"
                "Nothing to recalculate - a paid payroll run is locked so the record stays reliable."
            )
        payroll_id = db.finalize_payroll(employee_id, period_month)
        if payroll_id is None:
            raise ValidationError("This employee could not be found.")
        db.log_audit("attendance.finalize_payroll", f"employee {employee_id}, {period_month}")
        return payroll_id

    @api_method
    def mark_payroll_paid(self, payroll_id):
        security.require(security.PERM_MANAGE_ATTENDANCE)
        db.mark_payroll_paid(payroll_id)
        db.log_audit("attendance.mark_payroll_paid", str(payroll_id))
        return True

    @api_method
    def payroll_runs(self, period_month=None, employee_id=None):
        security.require(security.PERM_MANAGE_ATTENDANCE)
        return db.get_payroll_runs(period_month, employee_id)

    # ------------------------------------------------------------ snapshots
    @api_method
    def items_snapshot(self):
        return db.items_snapshot()["list"]

    @api_method
    def customers_snapshot(self):
        return db.customers_snapshot()["list"]

    @api_method
    def customer_balance(self, customer_id):
        return db.get_customer_balance(customer_id)

    @api_method
    def next_bill_number(self):
        return db.get_next_bill_number()

    @api_method
    def stock_levels(self, item_ids):
        raw = db.get_stock_levels(item_ids or [])
        return {str(k): v["quantity"] for k, v in raw.items()}

    # ------------------------------------------------------------ bills
    @api_method
    def create_bill(self, payload):
        return self._save_bill(payload or {}, editing=False)

    @api_method
    def update_bill(self, payload):
        return self._save_bill(payload or {}, editing=True)

    def _resolve_customer(self, customer_id, name, phone, address):
        """"STRICT CUSTOMER TRACKING" - exactly the logic the original
        bill editor used at save time (spec 02-billing.md §5.5): update
        an existing strict match, or create a brand-new customer. Never
        trusts the caller's customer_id blindly - it is only honoured if
        that customer's own name still matches what was typed."""
        match = None
        if customer_id:
            existing = db.get_customer(customer_id)
            if existing and existing["name"].strip().lower() == name.strip().lower():
                match = existing
        if match is None:
            candidates = [c for c in db.get_all_customers()
                          if c["name"].strip().lower() == name.strip().lower()]
            if len(candidates) == 1:
                match = candidates[0]
            elif len(candidates) > 1:
                match = next((c for c in candidates if str(c.get("phone") or "") == phone), None)
                if match is None:
                    match = next((c for c in candidates
                                  if str(c.get("address") or "").strip().lower() == address.strip().lower()),
                                 None)
        if match:
            db.update_customer(match["id"], name, phone, address, match.get("notes") or "")
            return match["id"]
        return db.add_customer(name, phone, address)

    def _save_bill(self, payload, editing):
        bill_id = payload.get("bill_id")

        if editing:
            if not security.has_permission(security.PERM_EDIT_BILL):
                db.log_audit("bill.edit", "Blocked - insufficient permission", outcome="denied")
            security.require(security.PERM_EDIT_BILL)
            if not bill_id:
                raise ValidationError("This bill could not be found. It may have been deleted.")

        name = validation.customer_name(payload.get("customer_name"))
        phone = validation.phone(payload.get("customer_phone"), required=False)
        address = validation.address(payload.get("customer_address"))
        notes = validation.notes(payload.get("notes"))
        bill_date = validation.bill_date(payload.get("bill_date"))
        bill_time = validation.bill_time(payload.get("bill_time"))
        freight = validation.money(payload.get("freight_charges") or 0, "Addition")
        discount = validation.money(payload.get("discount") or 0, "Less")

        items = []
        for raw in (payload.get("items") or []):
            iname = validation.item_name(raw.get("item_name"))
            qty = validation.quantity(raw.get("quantity"), f"Quantity for '{iname}'")
            price = validation.money(raw.get("price_per_unit"), f"Price for '{iname}'", allow_negative=False)
            items.append({
                "item_id": raw.get("item_id") or None,
                "item_name": iname,
                "quantity": qty,
                "price_per_unit": price,
                # Recomputed server-side rather than trusted from the
                # client - final_price must always equal qty * price.
                "final_price": round(qty * price, 2),
                "pack_qty": raw.get("pack_qty"),
                "pack_unit_name": raw.get("pack_unit_name") or "",
                "pack_size": raw.get("pack_size"),
            })
        if not items:
            raise ValidationError("Please add at least one valid item to the bill.")
        validation.validate_item_count(len(items))

        subtotal = round(sum(it["final_price"] for it in items), 2)
        amount_paid = validation.money(payload.get("amount_paid") or 0, "Amount paid")
        total = validation.validate_bill_totals(subtotal, freight, discount, amount_paid)

        bill_type = payload.get("bill_type") if payload.get("bill_type") in ("sale", "purchase") else "sale"

        customer_id = self._resolve_customer(payload.get("customer_id"), name, phone, address)

        if editing:
            db.update_bill(bill_id, customer_id, name, phone, address, bill_date, bill_time,
                            freight, discount, amount_paid, items, notes=notes, bill_type=bill_type)
            bill = db.get_bill(bill_id)
            bill_number = bill["bill_number"]
            db.log_audit("bill.edit", f"Bill {bill_number} ({name}) edited - new total Rs. {total:.2f}")
        else:
            bill_id, bill_number = db.create_bill(
                customer_id, name, phone, address, bill_date, bill_time,
                freight, discount, amount_paid, items, notes=notes, bill_type=bill_type)
            bill = db.get_bill(bill_id)
            label = "Purchase bill" if bill_type == "purchase" else "Bill"
            db.log_audit("bill.create",
                         f"{label} {bill_number} ({name}) created - Rs. {total:.2f}, {len(items)} item(s)")

        pdf_path, pdf_error = None, None
        try:
            pdf_path = pdf_generator().generate_bill_pdf(bill)
        except Exception as e:
            applog.report_error(e, "generate_bill_pdf")
            pdf_error = (f"Bill {bill_number} was saved successfully, but its PDF could not be created. "
                         f"The bill is safe - you can open it again from Bill History and print from there.")

        if pdf_path:
            _open_file(pdf_path)

        return {"bill_id": bill_id, "bill_number": bill_number, "pdf_path": pdf_path, "pdf_error": pdf_error}

    @api_method
    def get_bills(self, search="", date_from=None, date_to=None):
        return db.get_all_bills(search=search or None, date_from=date_from, date_to=date_to)

    @api_method
    def get_bill(self, bill_id):
        bill = db.get_bill(bill_id)
        if not bill:
            raise ValidationError("This bill could not be found. It may have been deleted.")
        return bill

    @api_method
    def delete_bill(self, bill_id, restock=True):
        bill = db.get_bill(bill_id)
        if not security.has_permission(security.PERM_DELETE_BILL):
            db.log_audit("bill.delete", "Blocked - insufficient permission", outcome="denied")
        security.require(security.PERM_DELETE_BILL)
        db.delete_bill(bill_id, restock=restock)
        if bill:
            db.log_audit("bill.delete", f"Bill {bill['bill_number']} ({bill['customer_name']}) deleted")
        return True

    def _bill_pdf_path(self, bill):
        return safe_paths.bill_pdf_path(pdf_generator().OUTPUT_DIR, bill["bill_number"])

    def _ensure_pdf(self, bill):
        path = self._bill_pdf_path(bill)
        if not os.path.isfile(path):
            path = pdf_generator().generate_bill_pdf(bill)
        return path

    @api_method
    def open_pdf(self, bill_id):
        bill = db.get_bill(bill_id)
        if not bill:
            raise ValidationError("This bill could not be found.")
        path = self._ensure_pdf(bill)
        _open_file(path)
        return True

    @api_method
    def print_bill(self, bill_id):
        bill = db.get_bill(bill_id)
        if not bill:
            raise ValidationError("This bill could not be found.")
        path = self._ensure_pdf(bill)
        _print_file(path)
        return True

    @api_method
    def send_whatsapp(self, bill_id, phone):
        bill = db.get_bill(bill_id)
        if not bill:
            raise ValidationError("This bill could not be found.")
        number = validation.whatsapp_number(phone)
        path = self._ensure_pdf(bill)
        try:
            import whatsapp_sender  # lazy: needs selenium + a real Chrome, optional dependency
        except Exception as e:
            raise ValueError(
                "Sending on WhatsApp needs Google Chrome and the 'selenium' package installed on "
                "this computer. Please install the app's optional WhatsApp dependency and try again."
            ) from e
        store_name = db.get_setting("store_name", "Balaji Store")
        caption = f"Your bill from {store_name} — Bill No: {bill['bill_number']}"
        sent, message = whatsapp_sender.send_pdf_via_whatsapp(number, path, caption)
        if not sent:
            raise ValueError(message)
        return message

    @api_method
    def reveal(self, bill_id):
        bill = db.get_bill(bill_id)
        if not bill:
            raise ValidationError("This bill could not be found.")
        path = self._ensure_pdf(bill)
        _reveal_file(path)
        return True

    # ------------------------------------------------------------ items / inventory
    def _read_item_form(self, data, existing=None):
        code = validation.item_code(data.get("item_code"))
        name = validation.item_name(data.get("name"))
        category = validation.category(data.get("category"))
        unit = validation.unit(data.get("unit")) or "pcs"
        price = validation.money(data.get("price"), "Price")
        threshold = validation.quantity(data.get("low_stock_threshold") or 0, "Low stock alert", allow_zero=True)
        pack_size = validation.pack_size(data.get("pack_size"))
        pack_unit = validation.unit(data.get("pack_unit_name")) if pack_size else ""
        # Opening/quantity is only ever taken from the form on a brand-new
        # item; editing an item never changes its quantity here (that is
        # the dedicated Adjust Stock action) - see database.py's own
        # comment on update_item about why this must stay a separate call.
        if "quantity" in data and data.get("quantity") is not None:
            quantity = validation.quantity(data.get("quantity"), "Opening stock", allow_zero=True)
        elif existing is not None:
            quantity = existing["quantity"]
        else:
            quantity = 0
        # Cost price is owner-only data (security.PERM_VIEW_PROFIT). A
        # staff account has PERM_MANAGE_INVENTORY (it can add/edit items
        # day to day) but never this one, so cost_price=None here tells
        # database.update_item()/add_item() to leave whatever cost price
        # already exists untouched rather than accepting whatever a
        # crafted request might send.
        if security.has_permission(security.PERM_VIEW_PROFIT) and "cost_price" in data:
            cost_price = validation.money(data.get("cost_price") or 0, "Cost price")
        elif existing is not None:
            cost_price = None
        else:
            cost_price = 0
        return code, name, category, unit, price, quantity, threshold, pack_size, pack_unit, cost_price

    @api_method
    def add_item(self, data):
        security.require(security.PERM_MANAGE_INVENTORY)
        code, name, category, unit, price, quantity, threshold, pack_size, pack_unit, cost_price = \
            self._read_item_form(data or {})
        item_id = db.add_item(code or None, name, category, unit, price, quantity, threshold,
                              pack_size, pack_unit, cost_price or 0)
        return item_id

    @api_method
    def update_item(self, item_id, data):
        security.require(security.PERM_MANAGE_INVENTORY)
        existing = db.get_item(item_id)
        if not existing:
            raise ValidationError("This item could not be found. It may have been deleted.")
        code, name, category, unit, price, quantity, threshold, pack_size, pack_unit, cost_price = \
            self._read_item_form(data or {}, existing=existing)
        db.update_item(item_id, code or None, name, category, unit, price, quantity, threshold,
                       pack_size, pack_unit, cost_price)
        return True

    @api_method
    def delete_item(self, item_id):
        security.require(security.PERM_MANAGE_INVENTORY)
        db.delete_item(item_id)
        return True

    @api_method
    def adjust_stock(self, item_id, delta, change_type="Manual Adjustment", notes=""):
        security.require(security.PERM_MANAGE_INVENTORY)
        try:
            delta = float(delta)
        except (TypeError, ValueError):
            raise ValidationError("Quantity must be a number.")
        if delta != delta or abs(delta) > validation.MAX_QUANTITY:
            raise ValidationError("That quantity looks too large. Please check for an extra digit.")
        if delta == 0:
            raise ValidationError("Enter a quantity greater than zero.")
        notes = validation.notes(notes)
        db.adjust_item_stock(item_id, round(delta, 3), change_type or "Manual Adjustment", notes=notes)
        return True

    @api_method
    def get_items(self, search=""):
        items = db.get_all_items(search=search or None)
        if not security.has_permission(security.PERM_VIEW_PROFIT):
            for it in items:
                it.pop("cost_price", None)
        return items

    # UI historically calls this the same thing two different ways.
    get_all_items = get_items

    @api_method
    def item_cost_layers(self, item_id):
        """What this item is holding, batch by batch - "40 left at 95,
        120 left at 88" - plus the money that adds up to. Owner-only:
        this is cost data, same gate as the Cost column itself."""
        security.require(security.PERM_VIEW_PROFIT)
        layers = db.get_item_cost_layers(item_id)
        value = sum((l["remaining"] or 0) * (l["cost_price"] or 0) for l in layers)
        units = sum((l["remaining"] or 0) for l in layers)
        return {
            "layers": layers,
            "units": round(units, 3),
            "value": round(value, 2),
            # The blended cost of what is actually on the shelf - the
            # honest single number to quote when there are several.
            "avg_cost": round(value / units, 4) if units > 1e-9 else 0,
        }

    @api_method
    def stock_valuation(self):
        security.require(security.PERM_VIEW_PROFIT)
        return db.get_stock_valuation()

    @api_method
    def reset_all_stock(self):
        if not security.has_permission(security.PERM_RESET_INVENTORY):
            db.log_audit("inventory.reset", "Blocked - insufficient permission", outcome="denied")
        security.require(security.PERM_RESET_INVENTORY)
        db.reset_all_item_quantities()
        db.log_audit("inventory.reset", "All stock quantities set to 0")
        return True

    @api_method
    def inventory_transactions(self, search=""):
        return db.get_inventory_transactions(search=search or None)

    @api_method
    def clear_inventory_transactions(self):
        if not security.has_permission(security.PERM_CLEAR_STOCK_HISTORY):
            db.log_audit("stock_history.clear", "Blocked - insufficient permission", outcome="denied")
        security.require(security.PERM_CLEAR_STOCK_HISTORY)
        count = len(db.get_inventory_transactions(limit=10_000_000))
        db.clear_inventory_transactions()
        db.log_audit("stock_history.clear", f"{count} stock history records deleted")
        return True

    # ------------------------------------------------------------ customers
    @api_method
    def get_customers(self, search=""):
        rows = db.get_all_customers(search=search or None)

        # The Customers screen shows lifetime value, bill count and last
        # purchase per row. Doing that with one query per customer would be
        # N+1 round-trips on a 400-name list, so the aggregates come back in
        # a single grouped read and are merged in here.
        # Purchases are excluded on purpose: bill_type='sale' only, matching
        # every other revenue figure in the app.
        stats = {}
        try:
            conn = db.get_connection()
            try:
                for r in conn.execute(
                    "SELECT customer_id, COUNT(*) AS bill_count, "
                    "       COALESCE(SUM(total), 0) AS total_revenue, "
                    "       MAX(bill_date) AS last_purchase "
                    "FROM bills "
                    "WHERE customer_id IS NOT NULL AND bill_type = 'sale' "
                    "GROUP BY customer_id"
                ):
                    stats[r["customer_id"]] = dict(r)
            finally:
                conn.close()
        except Exception as e:
            # Aggregates are decoration; the list itself must still open.
            applog.report_error(e, "customer aggregates")

        for r in rows:
            s = stats.get(r["id"], {})
            r["balance"] = db.get_customer_balance(r["id"])
            r["bill_count"] = s.get("bill_count", 0)
            r["total_revenue"] = s.get("total_revenue", 0.0)
            r["last_purchase"] = s.get("last_purchase")
        return rows

    # UI historically calls this the same thing two different ways.
    customers_overview = get_customers

    @api_method
    def add_customer(self, data):
        data = data or {}
        name = validation.customer_name(data.get("name"))
        phone = validation.phone(data.get("phone"), required=False)
        address = validation.address(data.get("address"))
        notes = validation.notes(data.get("notes"))
        return db.add_customer(name, phone, address, notes)

    @api_method
    def update_customer(self, customer_id, data):
        data = data or {}
        existing = db.get_customer(customer_id)
        if not existing:
            raise ValidationError("This customer could not be found. It may have been deleted.")
        name = validation.customer_name(data.get("name"))
        phone = validation.phone(data.get("phone"), required=False)
        address = validation.address(data.get("address"))
        notes = validation.notes(data["notes"]) if "notes" in data else (existing.get("notes") or "")
        bills_updated = db.update_customer(customer_id, name, phone, address, notes)
        renamed = (existing.get("name") or "").strip().upper() != (name or "").strip().upper()
        if renamed:
            db.log_audit("customer.rename",
                          f"'{existing.get('name')}' renamed to '{name}' "
                          f"({bills_updated} bill(s) updated to match)")
        return {"bills_updated": bills_updated, "renamed": renamed}

    @api_method
    def delete_customer(self, customer_id):
        # NOT permission-gated - see the module docstring: the original
        # GUI's customers_tab.py never enforced PERM_DELETE_CUSTOMER
        # either, and this rewrite preserves that exact behaviour rather
        # than quietly tightening it for an existing Owner/Staff setup.
        db.delete_customer(customer_id)
        return True

    @api_method
    def merge_customers(self, source_id, target_id):
        """Folds one duplicate customer into another. Deliberately gated
        where plain delete_customer is not: a merge rewrites the customer
        name stored on real bills, which is a heavier thing than removing
        a record nobody has billed yet."""
        security.require(security.PERM_DELETE_CUSTOMER)
        try:
            summary = db.merge_customers(int(source_id), int(target_id))
        except ValueError as e:
            raise ValidationError(str(e))
        db.log_audit("customer.merge",
                      f"Merged '{summary['merged_name']}' into '{summary['kept_name']}' "
                      f"({summary['bills_moved']} bill(s), {summary['ledger_moved']} khata entr(ies) moved)")
        return summary

    @api_method
    def customers_with_dues(self):
        return db.get_customers_with_dues(limit=1_000_000)

    @api_method
    def customer_ledger(self, customer_id):
        return db.get_customer_ledger(customer_id)

    @api_method
    def add_ledger_payment(self, customer_id, amount, notes=""):
        # NOT permission-gated, NOT audit-logged - see the module
        # docstring: khata_tab.py never enforced PERM_LEDGER_PAYMENT or
        # logged a manual payment either, in the original app.
        amount = validation.money(amount, "Amount")
        if amount <= 0:
            raise ValidationError("Amount must be more than zero.")
        notes = validation.notes(notes)
        # reference="Manual Payment" matches the original khata_tab.py's
        # hardcoded reference for this action (spec 03-catalogue-people.md
        # §4.4) - dropping it would show a blank Reference/Notes column
        # for every manual payment instead of "Manual Payment | <notes>".
        db.add_ledger_payment(customer_id, amount, reference="Manual Payment", notes=notes)
        return True

    @api_method
    def customer_kpis(self, customer_id):
        security.require(security.PERM_VIEW_ANALYTICS)
        k = db.get_customer_kpis(customer_id)
        return {
            "total_revenue": k["total_spent"],
            "bill_count": k["total_bills"],
            "avg_order": k["avg_order_value"],
            "last_purchase": k["last_purchase_date"],
            "balance": db.get_customer_balance(customer_id),
        }

    @api_method
    def customer_bills(self, customer_id):
        return db.get_customer_bills(customer_id)

    @api_method
    def customer_products(self, customer_id):
        security.require(security.PERM_VIEW_ANALYTICS)
        agg = {}
        for b in db.get_customer_bills(customer_id):
            for li in db.get_bill_items(b["id"]):
                a = agg.setdefault(li["item_name"], {"item_name": li["item_name"], "times": 0,
                                                       "qty": 0.0, "amount": 0.0})
                a["times"] += 1
                a["qty"] += li["quantity"]
                a["amount"] += li["final_price"]
        return sorted(agg.values(), key=lambda a: a["amount"], reverse=True)

    @api_method
    def customer_product_history(self, customer_id, item_name):
        security.require(security.PERM_VIEW_ANALYTICS)
        return db.get_customer_product_history(customer_id, item_name)

    # ------------------------------------------------------------ earnings
    # The profit workspace. Everything here is owner-only and says so in
    # one place: _earn_guard(). The date window is resolved by the SAME
    # code the dashboard uses (_resolve_window), so "Month" means the
    # same month on both screens - two screens quoting different profits
    # for the same word would undo the point of having this one.

    @staticmethod
    def _earn_guard():
        security.require(security.PERM_VIEW_PROFIT)

    def _resolve_window(self, range_key, month=None, date_from=None, date_to=None):
        """(from, to) as 'YYYY-MM-DD' strings, or (None, None) for all time.

        An explicit from/to wins - the drill-downs pass the window they
        were opened with, so a bill list can never quietly cover a
        different period than the total it came from.
        """
        if date_from or date_to:
            return (date_from or None), (date_to or None)
        window = self._dashboard_window(range_key, month)
        return window[0], window[1]

    @api_method
    def earnings(self, range="month", month=None):
        """Everything the Earnings overview needs, in one call: the
        headline, the daily trend, and the three rankings. One round trip
        rather than five, because they are always shown together and a
        half-loaded screen of money figures invites the wrong
        conclusion."""
        self._earn_guard()
        date_from, date_to = self._resolve_window(range, month)
        summary = db.earnings_summary(date_from, date_to)

        # Same-length previous window, so the headline can say whether
        # profit is up or down without the reader doing arithmetic.
        prev = None
        if date_from and date_to:
            try:
                f = date.fromisoformat(date_from)
                t = date.fromisoformat(date_to)
                span = (t - f).days + 1
                p_to = f - timedelta(days=1)
                p_from = p_to - timedelta(days=span - 1)
                prev = db.earnings_summary(p_from.isoformat(), p_to.isoformat())
            except ValueError:
                prev = None

        def pct(cur, before):
            if before in (None, 0):
                return None
            try:
                return round((cur - before) / abs(before) * 100, 1)
            except (TypeError, ZeroDivisionError):
                return None

        return {
            "range": range,
            "month": month,
            "date_from": date_from,
            "date_to": date_to,
            "summary": summary,
            "delta": {
                "profit": pct(summary.get("profit") or 0, (prev or {}).get("profit")),
                "revenue": pct(summary.get("revenue") or 0, (prev or {}).get("revenue")),
            } if prev else {},
            "daily": db.earnings_daily(date_from, date_to),
            "items": db.earnings_by_item(date_from, date_to, limit=100),
            "customers": db.earnings_by_customer(date_from, date_to, limit=100),
            "categories": db.earnings_by_category(date_from, date_to, limit=40),
        }

    @api_method
    def earnings_bills(self, range="month", month=None, item_name=None, customer_name=None,
                        date_from=None, date_to=None, limit=500):
        """The middle of the drill-down: the bills behind one item, one
        customer, or the whole period."""
        self._earn_guard()
        f, t = self._resolve_window(range, month, date_from, date_to)
        return {
            "date_from": f, "date_to": t,
            "item_name": item_name or None,
            "customer_name": customer_name or None,
            "bills": db.earnings_by_bill(f, t, limit=limit,
                                          item_name=item_name or None,
                                          customer_name=customer_name or None),
        }

    @api_method
    def bill_profit(self, bill_id):
        """The bottom of the drill-down: one bill, line by line, with the
        cost that was actually applied when its profit was worked out -
        not the item's cost price as it stands today. See
        database.bill_profit_detail()."""
        self._earn_guard()
        detail = db.bill_profit_detail(bill_id)
        if not detail:
            raise ValidationError("That bill could not be found. It may have been deleted.")
        return detail

    @api_method
    def earnings_checks(self, range="month", month=None, date_from=None, date_to=None):
        """Lines that look like a billing or costing mistake."""
        self._earn_guard()
        f, t = self._resolve_window(range, month, date_from, date_to)
        return db.earnings_checks(f, t)

    @api_method
    def earnings_export(self, range="month", month=None, view="items"):
        """Writes the current view to CSV. The owner asked for this
        screen partly to hunt for mistakes, and a spreadsheet is where
        that kind of hunting actually finishes."""
        self._earn_guard()
        f, t = self._resolve_window(range, month)
        if view == "customers":
            rows = db.earnings_by_customer(f, t, limit=100000)
            head = ["Customer", "Bills", "Revenue", "Cost", "Profit", "Margin %"]
            body = [[r["label"], r["bills"], r["revenue"], r["cost"], r["profit"], r["margin"]]
                    for r in rows]
            default = "profit_by_customer.csv"
        elif view == "bills":
            rows = db.earnings_by_bill(f, t, limit=100000)
            head = ["Bill", "Date", "Customer", "Revenue", "Cost", "Profit", "Margin %"]
            body = [[r["bill_number"], r["bill_date"], r["customer_name"],
                     r["revenue"], r["cost"], r["profit"], r["margin"]] for r in rows]
            default = "profit_by_bill.csv"
        else:
            rows = db.earnings_by_item(f, t, limit=100000)
            head = ["Item", "Quantity", "Bills", "Revenue", "Cost", "Profit", "Margin %"]
            body = [[r["label"], r["quantity"], r["bills"], r["revenue"], r["cost"],
                     r["profit"], r["margin"]] for r in rows]
            default = "profit_by_item.csv"

        path = self._pick_save_file(default, ("CSV File (*.csv)",))
        with io.open(path, "w", encoding="utf-8-sig", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(head)
            w.writerows(body)
        db.log_audit("earnings.export", f"{len(body)} rows exported to {os.path.basename(path)}")
        return path

    # ------------------------------------------------------------ settings
    @api_method
    def get_settings(self):
        return _all_settings()

    @api_method
    def set_setting(self, key, value):
        # PERM_MANAGE_SETTINGS is owner-only by construction (it isn't in
        # _STAFF_PERMISSIONS), so security.require() above already keeps
        # this to the owner (or to anyone at all while sign-in is off) -
        # no extra check is needed for auth_enabled specifically.
        security.require(security.PERM_MANAGE_SETTINGS)
        key = validation.clean_text(key, 60, "Setting name", allow_empty=False)
        value = validation.setting_value(value)
        db.set_setting(key, value)
        return True

    @api_method
    def backup_now(self):
        security.require(security.PERM_BACKUP_DATA)
        backups_dir = appdata.subdir("backups")
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"balaji_backup_{stamp}.bbak"
        dest = os.path.join(backups_dir, filename)
        br.export_data(dest, br.CATEGORIES)
        db.log_audit("data.backup", f"Backup saved to {filename}")
        return {"path": dest, "last": datetime.now().strftime("%Y-%m-%d %H:%M")}

    def _pick_open_file(self, file_types):
        window = webview.windows[0]
        result = window.create_file_dialog(webview.OPEN_DIALOG, file_types=file_types)
        if not result:
            raise ValidationError("No file was chosen.")
        return result[0] if isinstance(result, (list, tuple)) else result

    def _pick_save_file(self, default_name, file_types):
        window = webview.windows[0]
        result = window.create_file_dialog(webview.SAVE_DIALOG, save_filename=default_name,
                                           file_types=file_types)
        if not result:
            raise ValidationError("No location was chosen.")
        return result[0] if isinstance(result, (list, tuple)) else result

    @api_method
    def restore_backup(self):
        security.require(security.PERM_IMPORT_DATA)
        path = self._pick_open_file(("Backup files (*.bbak;*.db;*.sqlite;*.sqlite3;*.bbakx)", "All files (*.*)"))
        safe_paths.validate_backup_file(path)
        src, temp = br.open_import_source(path)
        try:
            plan, conflicts = br.scan_import(src, br.CATEGORIES)
            for c in conflicts:
                # "Skip" is the safe default the original Import wizard
                # pre-selects for every conflict row; this headless bridge
                # has no per-row review UI yet, so it applies that same
                # default rather than guessing "overwrite".
                c.resolution = "skip"
            summary = br.apply_import(plan)
        finally:
            br.cleanup_import_source(temp)
        db.bump("items", "customers", "bills", "attendance")
        parts = [f"{cat}: +{s['added']} added, {s['updated']} updated, {s['skipped']} skipped"
                 for cat, s in summary.items() if s["added"] or s["updated"] or s["skipped"]]
        db.log_audit("data.import", f"Imported from {os.path.basename(path)}: " + "; ".join(parts))
        return summary

    @api_method
    def export_items(self):
        security.require(security.PERM_IMPORT_DATA)
        path = self._pick_save_file("inventory_export.xlsx",
                                    ("Excel Workbook (*.xlsx)", "CSV File (*.csv)"))
        count = inventory_io.export_items(path)
        db.log_audit("inventory.export", f"{count} items exported")
        return path

    @api_method
    def import_items(self):
        security.require(security.PERM_IMPORT_DATA)
        path = self._pick_open_file(("Spreadsheet (*.xlsx;*.xlsm;*.csv)", "All files (*.*)"))
        rows = inventory_io.read_rows(path)
        plan, conflicts = inventory_io.scan(rows)
        for c in conflicts:
            c.resolution = "skip"  # same safe default as restore_backup, see there
        counts = inventory_io.apply(plan)
        db.log_audit("inventory.import",
                     f"{counts['added']} added, {counts['updated']} updated, "
                     f"{counts['skipped']} skipped from {os.path.basename(path)}")
        return counts

    @api_method
    def list_users(self):
        return db.list_users()

    @api_method
    def create_user(self, data):
        security.require(security.PERM_MANAGE_USERS)
        data = data or {}
        username = validation.clean_text(data.get("username"), 40, "Username", allow_empty=False)
        if not all(c.isalnum() or c in "._-" for c in username):
            raise ValidationError("Username can only contain letters, numbers, and . _ -")
        role = data.get("role") or security.ROLE_STAFF
        if role not in security.ROLES:
            raise ValidationError("Unknown role.")
        password = data.get("password") or ""
        good, msg = security.validate_password_strength(password, role)
        if not good:
            raise ValidationError(msg)
        display_name = validation.clean_text(data.get("display_name"), 120, "Display name")
        try:
            user_id = db.create_user(username, password, role, display_name=display_name)
        except ValueError as e:
            raise ValidationError(str(e))
        db.log_audit("user.create", f"Created {role} account '{username}'")
        return user_id

    @api_method
    def update_user(self, user_id, data):
        security.require(security.PERM_MANAGE_USERS)
        data = data or {}
        display_name = data.get("display_name")
        if display_name is not None:
            display_name = validation.clean_text(display_name, 120, "Display name")
        role = data.get("role")
        if role is not None and role not in security.ROLES:
            raise ValidationError("Unknown role.")
        is_active = data.get("is_active")
        try:
            db.update_user(user_id, display_name=display_name, role=role, is_active=is_active)
        except ValueError as e:
            raise ValidationError(str(e))
        db.log_audit("user.update", f"Updated account #{user_id}")
        return True

    @api_method
    def delete_user(self, user_id):
        security.require(security.PERM_MANAGE_USERS)
        user = db.get_user(user_id)
        try:
            db.delete_user(user_id)
        except ValueError as e:
            raise ValidationError(str(e))
        if user:
            db.log_audit("user.delete", f"Deleted account '{user['username']}'")
        return True

    @api_method
    def audit_log(self, search=""):
        security.require(security.PERM_VIEW_AUDIT_LOG)
        return db.get_audit_log(search=search or None)

    @api_method
    def data_dir(self):
        return appdata.data_dir()

    @api_method
    def open_folder(self, which):
        which = (which or "data").lower()
        if which in ("pdfs", "bills"):
            path = pdf_generator().OUTPUT_DIR
        elif which == "backups":
            path = appdata.subdir("backups")
        else:
            path = appdata.data_dir()
        _open_folder(path)
        return True

    # ------------------------------------------------------------ archiving
    # Taking a day's trade off to a pendrive and out of the live file.
    # The dangerous half of this is the deletion, so the rules are in
    # backup_restore.archive_and_purge(): write, read the file back from
    # disk, count the bills in it, and only then remove anything. Stock is
    # never touched - see purge_archived_bills().

    ARCHIVE_DIR_KEY = "archive_dir"

    @api_method
    def archive_settings(self):
        """Where archives go, and whether that place is currently there.

        A pendrive that is not plugged in is the normal case, not an
        error - the screen just needs to know so it can say so instead of
        failing at the moment the owner presses the button.
        """
        folder = db.get_setting(self.ARCHIVE_DIR_KEY, "") or ""
        return {
            "folder": folder,
            "exists": bool(folder) and os.path.isdir(folder),
            "last_archived": db.get_setting("archive_last", "") or "",
        }

    @api_method
    def choose_archive_folder(self):
        """Asks for the folder once. After this the button just works."""
        security.require(security.PERM_BACKUP_DATA)
        window = webview.windows[0]
        result = window.create_file_dialog(webview.FOLDER_DIALOG)
        if not result:
            raise ValidationError("No folder was chosen.")
        folder = result[0] if isinstance(result, (list, tuple)) else result
        if not os.path.isdir(folder):
            raise ValidationError("That folder could not be found.")
        db.set_setting(self.ARCHIVE_DIR_KEY, folder)
        db.log_audit("archive.folder", f"Archive location set to {folder}")
        return {"folder": folder}

    @api_method
    def archive_preview(self, date_from=None, date_to=None):
        """What archiving right now would take, and what it would find
        already sitting at the destination. Everything the confirmation
        needs in order to be specific rather than reassuring."""
        security.require(security.PERM_BACKUP_DATA)
        d_from = validation.bill_date(date_from) if date_from else date.today().isoformat()
        d_to = validation.bill_date(date_to) if date_to else d_from
        if d_to < d_from:
            d_from, d_to = d_to, d_from

        conn = db.get_connection()
        row = conn.execute("""
            SELECT COUNT(*) AS bills,
                   COALESCE(SUM(CASE WHEN bill_type='sale' THEN 1 ELSE 0 END), 0) AS sales,
                   COALESCE(SUM(CASE WHEN bill_type='purchase' THEN 1 ELSE 0 END), 0) AS purchases,
                   COALESCE(SUM(CASE WHEN bill_type='sale' THEN total ELSE 0 END), 0) AS sales_value
            FROM bills WHERE bill_date >= ? AND bill_date <= ?
        """, (d_from, d_to)).fetchone()
        conn.close()

        folder = db.get_setting(self.ARCHIVE_DIR_KEY, "") or ""
        filename = br.archive_filename(d_from, d_to)
        dest = os.path.join(folder, filename) if folder else ""
        existing = None
        if dest and os.path.isfile(dest):
            # Say what is already in that file, so "add to it" is an
            # informed choice rather than a leap.
            try:
                c2 = br._read_only_conn(dest)
                n = c2.execute("SELECT COUNT(*) AS n FROM bills").fetchone()["n"]
                dates = c2.execute("SELECT MIN(bill_date) AS a, MAX(bill_date) AS b FROM bills").fetchone()
                c2.close()
                existing = {"bills": n, "from": dates["a"], "to": dates["b"],
                            "size_kb": round(os.path.getsize(dest) / 1024, 1)}
            except Exception:
                existing = {"bills": None}

        return {
            "date_from": d_from, "date_to": d_to,
            "bills": row["bills"], "sales": row["sales"], "purchases": row["purchases"],
            "sales_value": row["sales_value"],
            "folder": folder, "folder_exists": bool(folder) and os.path.isdir(folder),
            "filename": filename, "path": dest, "existing": existing,
        }

    @api_method
    def archive_run(self, date_from=None, date_to=None, mode="append", purge=True):
        """Archives a date range and, once the file has been verified,
        removes those bills from the live data.

        mode:
          append  - add to the file already there (the safe default:
                    re-archiving a day it already holds adds nothing)
          replace - start that file again from scratch
          new     - write alongside it under a numbered name

        Stock is never affected. See backup_restore.purge_archived_bills.
        """
        security.require(security.PERM_BACKUP_DATA)
        if db.is_read_only():
            raise ValidationError("This is an archived snapshot. It cannot archive anything itself.")

        folder = db.get_setting(self.ARCHIVE_DIR_KEY, "") or ""
        if not folder:
            raise ValidationError("Choose where archives should be saved first.")
        if not os.path.isdir(folder):
            raise ValidationError(
                f"The archive location is not available right now:\n{folder}\n\n"
                "If it is a pendrive, plug it in and try again — or choose a different location.")

        d_from = validation.bill_date(date_from) if date_from else date.today().isoformat()
        d_to = validation.bill_date(date_to) if date_to else d_from
        if d_to < d_from:
            d_from, d_to = d_to, d_from

        dest = os.path.join(folder, br.archive_filename(d_from, d_to))
        if mode == "replace" and os.path.isfile(dest):
            # Kept, not deleted. Replacing an archive is the one action
            # here that could lose something, and a file named .bak-1 is
            # a cheap apology next to a day of trade that no longer
            # exists anywhere.
            backup = dest + ".replaced-" + datetime.now().strftime("%Y%m%d%H%M%S")
            os.replace(dest, backup)
            db.log_audit("archive.replace", f"Previous archive kept as {os.path.basename(backup)}")
        elif mode == "new":
            stem, ext = os.path.splitext(dest)
            n = 2
            while os.path.isfile(f"{stem} ({n}){ext}"):
                n += 1
            dest = f"{stem} ({n}){ext}"

        summary = br.archive_and_purge(dest, d_from, d_to, purge=bool(purge))
        if summary.get("nothing_to_do"):
            raise ValidationError(f"There are no bills dated {d_from}"
                                  + ("" if d_from == d_to else f" to {d_to}") + " to archive.")
        if not summary.get("verified"):
            db.log_audit("archive.failed", f"{d_from}..{d_to}: {summary.get('error')}",
                          outcome="denied")
            raise ValidationError(
                "The archive could not be confirmed, so nothing has been removed "
                "from the app.\n\n" + (summary.get("error") or ""))

        db.set_setting("archive_last", db.now_str())
        db.log_audit("archive.run",
                      f"{summary['archived']} bill(s) for {d_from}..{d_to} archived to "
                      f"{os.path.basename(dest)}; {summary['purged']} removed from the app")
        summary["path"] = dest
        summary["date_from"], summary["date_to"] = d_from, d_to
        return summary

    @api_method
    def open_archive_folder(self):
        folder = db.get_setting(self.ARCHIVE_DIR_KEY, "") or ""
        if not folder or not os.path.isdir(folder):
            raise ValidationError("No archive location is set, or it is not available right now.")
        _open_folder(folder)
        return True

    # ------------------------------------------------------------ auth
    @api_method
    def sign_in(self, username, password):
        user, message = db.authenticate(username or "", password or "")
        if not user:
            raise ValidationError(message)
        security.current.enabled = True
        security.current.start(user["id"], user["username"], user["role"],
                               user.get("display_name") or user["username"])
        return _public_user(user)

    @api_method
    def auth_state(self):
        return {
            "enabled": db.is_auth_enabled(),
            "authenticated": security.current.is_authenticated,
            "user": _public_user(db.get_user(security.current.user_id))
                    if security.current.is_authenticated else None,
            "can_claim_device": db.can_claim_device(),
            "owner_exists": db.count_owners() > 0,
        }

    @api_method
    def claim_device(self, data):
        """Creates an owner account on a machine this database has not
        been used on before, and signs in as it.

        This is the way out of a lockout that has nothing to do with
        forgetting a password: the shop's data file was carried to
        another computer - a new machine, a repaired one, a pendrive copy
        - where the accounts that exist were made somewhere else and
        cannot be reached. Without this the owner is shut out of their own
        books by a feature meant to protect them.

        db.can_claim_device() is what decides, and it is checked HERE, not
        just hidden in the UI - on the machine this database belongs to,
        with an owner account present, this raises. So the counter staff
        cannot reach it, which is the only escalation that would matter.

        Existing accounts are left alone: the old owner login still works
        if whoever has it turns up.
        """
        if not db.can_claim_device():
            raise ValidationError(
                "This computer is already set up for this shop's data.\n\n"
                "Sign in with an existing account, or ask the owner to add one for you "
                "from Settings > Users.")

        data = data or {}
        username = validation.clean_text(data.get("username"), 40, "Username", allow_empty=False)
        if not all(ch.isalnum() or ch in "._-" for ch in username):
            raise ValidationError("Username can only contain letters, numbers, and . _ -")
        password = data.get("password") or ""
        good, msg = security.validate_password_strength(password, security.ROLE_OWNER)
        if not good:
            raise ValidationError(msg)
        if password != (data.get("confirm") or password):
            raise ValidationError("The two passwords do not match.")
        display_name = validation.clean_text(data.get("display_name"), 120, "Display name")

        # A recovery code is generated here and shown once. The whole
        # reason this method exists is somebody being locked out, so the
        # account it creates ships with its own way back in.
        recovery_code = security.generate_recovery_code()
        try:
            user_id = db.create_user(username, password, security.ROLE_OWNER,
                                      display_name=display_name, recovery_code=recovery_code)
        except ValueError as e:
            raise ValidationError(str(e))

        db.bind_auth_device()
        db.log_audit("device.claim",
                      f"Owner account '{username}' created to set up this computer",
                      as_username=username, as_role=security.ROLE_OWNER)

        user = db.get_user(user_id)
        security.current.enabled = db.is_auth_enabled()
        security.current.start(user["id"], user["username"], user["role"],
                               user.get("display_name") or user["username"])
        return {"user": _public_user(user), "recovery_code": recovery_code}

    @api_method
    def reset_with_recovery_code(self, username, code, new_password):
        """The other way back in: the one-time code shown when an owner
        account was created. Already implemented in the data layer since
        the first version of sign-in, but never reachable from any screen
        - so in practice nobody could use it. The sign-in form offers it
        now."""
        username = (username or "").strip()
        if not username or not (code or "").strip():
            raise ValidationError("Enter your username and the recovery code.")
        user = db.get_user_by_username(username)
        role = (user or {}).get("role") or security.ROLE_STAFF
        good, msg = security.validate_password_strength(new_password or "", role)
        if not good:
            raise ValidationError(msg)
        # Consumes the code on success, so a written-down one cannot be
        # used twice by whoever finds the paper.
        recovered = db.verify_recovery_code(username, code)
        if not recovered:
            raise ValidationError(
                "That username and recovery code do not match.\n\n"
                "The code is the one shown once when the account was created. "
                "If it has been used already, it no longer works.")
        db.set_user_password(recovered["id"], new_password)
        db.log_audit("recovery.reset", "Password reset with a recovery code",
                      as_username=username)
        return True

    @api_method
    def sign_out(self):
        if security.current.is_authenticated:
            db.log_audit("logout", "Signed out")
        security.current.end()
        return True

    # ------------------------------------------------------------ updates
    # Phase 3: the user-facing side of app/updater.py. `check_for_updates`
    # is the manual "Check for updates" button (always bypasses the 24h
    # throttle); `get_update_status` is what the UI reads on load, which
    # only reports what the background check already found and never
    # makes a network call itself.

    @api_method
    def get_update_status(self):
        with _update_lock:
            info = _update_state["info"]
        return {
            "info": info,
            "last_check": db.get_setting(updater.LAST_CHECK_KEY, ""),
            "version": brand.APP_VERSION,
        }

    @api_method
    def check_for_updates(self, force=True):
        info = updater.get_update_info(force=bool(force))
        with _update_lock:
            _update_state["info"] = info
        return info

    @api_method
    def start_update_download(self):
        with _update_lock:
            info = _update_state["info"]
            if not info:
                raise ValidationError("No update is available to download.")
            if _update_state["downloading"]:
                return True
            _update_state["downloading"] = True
            _update_state["downloaded"] = 0
            _update_state["total"] = info.get("size", 0)
            _update_state["error"] = None
            _update_state["installer_path"] = None

        def _worker():
            def on_progress(done, total):
                with _update_lock:
                    _update_state["downloaded"] = done
                    if total:
                        _update_state["total"] = total
            path = updater.download_installer(info, on_progress=on_progress)
            with _update_lock:
                _update_state["downloading"] = False
                if path:
                    _update_state["installer_path"] = path
                else:
                    _update_state["error"] = (
                        "The download could not be verified and was discarded. "
                        "Check the internet connection and try again."
                    )

        threading.Thread(target=_worker, daemon=True).start()
        return True

    @api_method
    def get_update_progress(self):
        with _update_lock:
            return {
                "downloading": _update_state["downloading"],
                "downloaded": _update_state["downloaded"],
                "total": _update_state["total"],
                "ready": _update_state["installer_path"] is not None,
                "error": _update_state["error"],
            }

    @api_method
    def install_update(self):
        with _update_lock:
            path = _update_state["installer_path"]
        if not path:
            raise ValidationError("The update has not finished downloading yet.")
        db.log_audit("app.update", f"Installing update: {os.path.basename(path)}")
        started = updater.apply_update(path)
        if not started:
            raise ValidationError("The installer could not be started. Try downloading it again.")

        # Give this call a moment to return its response to the UI before
        # exiting - the installer is waiting on our AppMutex to close and
        # then relaunches Vikray on its own (see build/installer.iss).
        def _quit():
            time.sleep(1.2)
            os._exit(0)
        threading.Thread(target=_quit, daemon=True).start()
        return True

    @api_method
    def dismiss_update_notice(self):
        """'Later' - quiet for this run. The 24h throttle (stored in
        settings, not here) is what actually controls when the next
        background check happens, so this never has to touch it."""
        with _update_lock:
            _update_state["info"] = None
        return True
