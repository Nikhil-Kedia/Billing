"""
auto_backup.py - a once-a-day local snapshot of the database.

Why this exists:

  The README tells the shopkeeper to copy the data folder to a pendrive
  "weekly". In practice nobody does, and this app IS the business record -
  every bill, every customer, every outstanding khata balance. The most
  likely way to lose all of it is not an attacker, it is a dead hard
  drive or a mistaken "Delete All Bills" with no recent backup.

  So the app now takes its own snapshot once a day, automatically, into
  data/auto_backups/, keeping the last two weeks. This is NOT a
  replacement for the pendrive copy - a snapshot on the same disk dies
  with that disk - and the app says so. It is a cheap safety net for the
  far more common cases: a bad import, a mistaken bulk delete, a
  corrupted file.

  It uses SQLite's own backup API rather than copying the file, so the
  snapshot is consistent even if it runs while the database is in use.
"""

import os
import sqlite3
from datetime import datetime

import applog
import appdata
import database as db

BACKUP_DIR = appdata.subdir("auto_backups")

DEFAULT_KEEP = 14


def _keep_count():
    try:
        return max(1, min(90, int(db.get_setting("auto_backup_keep", str(DEFAULT_KEEP)))))
    except (TypeError, ValueError):
        return DEFAULT_KEEP


def is_enabled():
    return db.get_setting("auto_backup_enabled", "1") == "1"


def set_enabled(enabled):
    db.set_setting("auto_backup_enabled", "1" if enabled else "0")


def last_run_date():
    return db.get_setting("auto_backup_last", "")


def is_due():
    if not is_enabled():
        return False
    return last_run_date() != datetime.now().strftime("%Y-%m-%d")


def run_if_due():
    """Called once at startup. Returns the snapshot path, or None."""
    if not is_due():
        return None
    return run_now()


def run_now():
    """Takes a snapshot immediately and prunes old ones.

    Never raises: a backup problem must not stop the shop from billing.
    Failures go to the log and the function returns None.
    """
    try:
        os.makedirs(BACKUP_DIR, exist_ok=True)
        stamp = datetime.now().strftime("%Y-%m-%d")
        dest = os.path.join(BACKUP_DIR, f"balaji_auto_{stamp}.db")

        # Explicit busy_timeout: this connection is opened directly rather
        # than through database.get_connection() (that helper also flips
        # the live database into WAL mode, which is irrelevant to a
        # throwaway destination file), so it would otherwise fall back to
        # sqlite3's bare 5s default - too short to wait out a big bill
        # import running at the same moment as the nightly snapshot.
        source = sqlite3.connect(db.DB_PATH, timeout=15)
        source.execute("PRAGMA busy_timeout = 15000")
        try:
            target = sqlite3.connect(dest, timeout=15)
            try:
                # SQLite's own backup API: safe to run against a live
                # database, unlike copying the file underneath it.
                source.backup(target)
            finally:
                target.close()
        finally:
            source.close()

        db.set_setting("auto_backup_last", stamp)
        _prune()
        applog.info(f"Automatic backup written: {os.path.basename(dest)}")
        db.log_audit("data.auto_backup", f"Daily snapshot {os.path.basename(dest)}")
        return dest
    except Exception as e:
        applog.report_error(e, "automatic backup")
        return None


def _prune():
    """Deletes all but the newest _keep_count() snapshots."""
    try:
        snapshots = sorted(
            f for f in os.listdir(BACKUP_DIR)
            if f.startswith("balaji_auto_") and f.endswith(".db")
        )
        for old in snapshots[:-_keep_count()]:
            try:
                os.remove(os.path.join(BACKUP_DIR, old))
            except OSError:
                pass
    except OSError:
        pass


def list_snapshots():
    """Newest first, for display in Settings."""
    try:
        entries = []
        for name in os.listdir(BACKUP_DIR):
            if name.startswith("balaji_auto_") and name.endswith(".db"):
                path = os.path.join(BACKUP_DIR, name)
                entries.append({
                    "name": name,
                    "path": path,
                    "size": os.path.getsize(path),
                    "date": name[len("balaji_auto_"):-3],
                })
        return sorted(entries, key=lambda e: e["date"], reverse=True)
    except OSError:
        return []
