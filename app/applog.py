"""
applog.py - application logging, and the one helper that decides what a
user is allowed to see when something goes wrong.

The problem this solves:

  The app used to do `messagebox.showerror("Error", str(e))` in about a
  dozen places. Python exception text routinely contains the full path
  of the file it happened in, SQL fragments, and sometimes the row data
  itself. Putting that in a dialog on a shop counter machine hands a
  passer-by a map of the installation, and hands the shopkeeper a
  sentence they cannot act on.

  So: the user gets a short, plain-language sentence plus a reference
  code. The full traceback goes to a rotating log file that stays on the
  machine. The reference code is what ties the two together, so a
  genuine support question is still answerable.
"""

import logging
import os
import secrets
import sys
import traceback
from logging.handlers import RotatingFileHandler

APP_DIR = os.path.dirname(os.path.abspath(__file__))
# Imported lazily inside _log_dir() so that a failure to resolve the
# data folder can never stop logging from being importable.
def _log_dir():
    try:
        import appdata
        return appdata.subdir("logs")
    except Exception:
        return os.path.join(APP_DIR, "data", "logs")


LOG_DIR = _log_dir()
LOG_PATH = os.path.join(LOG_DIR, "balaji_billing.log")

MAX_LOG_BYTES = 2 * 1024 * 1024
LOG_BACKUPS = 5

_logger = None


def get_logger():
    """Rotating file logger. Never writes to stdout in the packaged app -
    a windowed PyInstaller build has no console, and writing to a missing
    stdout raises."""
    global _logger
    if _logger is not None:
        return _logger

    logger = logging.getLogger("balaji")
    logger.setLevel(logging.INFO)
    logger.propagate = False

    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        handler = RotatingFileHandler(
            LOG_PATH, maxBytes=MAX_LOG_BYTES, backupCount=LOG_BACKUPS, encoding="utf-8"
        )
        handler.setFormatter(logging.Formatter(
            "%(asctime)s | %(levelname)-7s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
        ))
        logger.addHandler(handler)
    except Exception:
        # Logging must never be the reason the app fails to start, e.g.
        # if the folder is read-only. Fall back to a silent no-op sink.
        logger.addHandler(logging.NullHandler())

    # A console copy is only useful while developing from source.
    if not getattr(sys, "frozen", False):
        stream = logging.StreamHandler()
        stream.setFormatter(logging.Formatter("%(levelname)s: %(message)s"))
        logger.addHandler(stream)

    _logger = logger
    return logger


def info(message):
    get_logger().info(message)


def warn(message):
    get_logger().warning(message)


def error(message):
    get_logger().error(message)


def report_error(exc, context=""):
    """Logs the full exception and returns a short reference code to show
    the user. The code is random, not derived from the error, so it
    cannot itself leak anything about what went wrong."""
    ref = secrets.token_hex(3).upper()
    detail = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    get_logger().error("[%s] %s\n%s", ref, context or "Unhandled error", detail)
    return ref


def safe_message(exc, friendly, context=""):
    """The standard replacement for `str(e)` in a dialog.

    `friendly` is what the user reads and can act on. The reference code
    lets a developer find the real cause in data/logs/ afterwards.
    """
    ref = report_error(exc, context)
    return f"{friendly}\n\nIf this keeps happening, quote reference {ref} (details are saved in the app's log file)."


def install_global_handler():
    """Last-resort net so an unexpected crash is recorded rather than
    vanishing - in a windowed build there is no console for a traceback
    to be printed to, so without this the app simply disappears."""
    def _hook(exc_type, exc_value, exc_tb):
        if issubclass(exc_type, KeyboardInterrupt):
            sys.__excepthook__(exc_type, exc_value, exc_tb)
            return
        detail = "".join(traceback.format_exception(exc_type, exc_value, exc_tb))
        get_logger().critical("Unhandled exception\n%s", detail)

    sys.excepthook = _hook


def friendly_db_error(exc, fallback, context=""):
    """Turns a database exception into something a shopkeeper can act on.

    The common ones here are UNIQUE-constraint violations, which SQLite
    reports as e.g. "UNIQUE constraint failed: items.name". That text
    names the schema and means nothing to the person reading it; the
    sentence they need is "an item with this name already exists".
    Anything unrecognised falls back to a generic message plus a
    reference code, with the real error going only to the log file.
    """
    text = str(exc)
    if "UNIQUE constraint failed" in text:
        if "items.name" in text:
            return "An item with this name already exists.\n\nPlease use a different product name."
        if "items.item_code" in text:
            return "An item with this code already exists.\n\nPlease use a different item code."
        if "bills.bill_number" in text:
            return "A bill with this number already exists."
        if "users.username" in text:
            return "That username is already taken.\n\nPlease choose a different one."
        return "This entry already exists.\n\nPlease change it and try again."
    if "NOT NULL constraint failed" in text:
        return "A required field was left empty. Please fill in every required field."
    if "database is locked" in text:
        return ("The database is busy - another copy of this app may be open.\n\n"
                "Close any other windows of the app and try again.")
    if "no such table" in text or "no such column" in text:
        return ("This file doesn't have the data this action needs.\n\n"
                "It may be from a different or older version of the app.")
    return safe_message(exc, fallback, context)
