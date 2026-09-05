"""
appdata.py - decides where the business's data actually lives.

NOVA REWRITE NOTE (bridge.py / nova.py)
----------------------------------------
This file is copied UNCHANGED from the original Tkinter app on purpose:
the frozen-build data location (%LOCALAPPDATA%\\BalajiBilling\\data) and
APP_NAME ("BalajiBilling") must stay byte-for-byte identical, or an
installed copy of the new pywebview build will not find the shop's
existing database at all and will silently start from empty.

The one-time migration below (_migrate_if_needed) already covers the
requirement "if the new location is empty, also look for a database in
the old project folder": LEGACY_DATA_DIR is this file's own folder's
`data` subdirectory, which for both the original app AND this rewrite is
wherever the running program's modules sit (dev checkout or previous
install's program directory) - exactly "the old project folder". Nothing
below needed to change to satisfy that; it is preserved verbatim so the
migration keeps working for an install of the OLD app being replaced by
this rewrite, not just future rebuilds of the rewrite itself.

THE BUG THIS FIXES
------------------
The built application stored its database, its bill PDFs and its saved
WhatsApp login inside its own program folder:

    dist/BalajiBilling/_internal/data/balaji_billing.db

build_exe.bat rebuilds with `PyInstaller --noconfirm`, and --noconfirm
DELETES dist/BalajiBilling before writing the new build. So every time
the app was rebuilt - to pick up any code change at all - the entire
business record was destroyed without a word: every bill, every
customer, every khata balance, every generated PDF.

That had already begun to happen here: the copy in the program folder
held 4 bills and 413 items while the copy in the source folder held 6
bills and 403 items. Two diverging databases, and no way to tell which
one was "the" one.

THE FIX
-------
When running as the built .exe, data now lives in the standard Windows
per-user location:

    %LOCALAPPDATA%\\BalajiBilling\\data

That folder is outside the program directory, so rebuilding the app
cannot touch it. On the first run after this change, anything found in
the old location is COPIED (never moved, never deleted) into the new
one, so the old copy remains untouched as a fallback.

Running from source (`python main.py` / run.bat) is deliberately left
alone and still uses the project's own `data` folder, exactly as before -
that is the developer's scratch copy, and silently redirecting it would
have made the shop's real data appear in a checkout.
"""

import os
import shutil
import sys

APP_NAME = "BalajiBilling"

# Where this file sits. For a frozen build this is the program folder.
_HERE = os.path.dirname(os.path.abspath(__file__))

# The location used before this change - still read for the one-time copy.
LEGACY_DATA_DIR = os.path.join(_HERE, "data")


def is_frozen():
    """True when running as the PyInstaller-built .exe."""
    return getattr(sys, "frozen", False)


def _user_data_root():
    """%LOCALAPPDATA%\\BalajiBilling, with sane fallbacks.

    LOCALAPPDATA rather than APPDATA: this data is machine-local business
    data, not something that should follow a roaming Windows profile
    around a network.
    """
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
    if not base:
        base = os.path.expanduser("~")
    return os.path.join(base, APP_NAME)


def data_dir():
    """The one place the whole app asks for its data folder.

    Creates it if missing, and performs the one-time migration from the
    old in-program-folder location.
    """
    if not is_frozen():
        os.makedirs(LEGACY_DATA_DIR, exist_ok=True)
        return LEGACY_DATA_DIR

    target = os.path.join(_user_data_root(), "data")
    os.makedirs(target, exist_ok=True)
    _migrate_if_needed(target)
    return target


def _migrate_if_needed(target):
    """Copies a pre-existing database out of the program folder, once.

    Guarded on the target database not existing, so this can never
    overwrite live data with an older copy. Everything is copied, not
    moved: if anything goes wrong the original is still sitting exactly
    where it was.
    """
    target_db = os.path.join(target, "balaji_billing.db")
    legacy_db = os.path.join(LEGACY_DATA_DIR, "balaji_billing.db")

    if os.path.exists(target_db) or not os.path.exists(legacy_db):
        return

    try:
        for name in os.listdir(LEGACY_DATA_DIR):
            src = os.path.join(LEGACY_DATA_DIR, name)
            dst = os.path.join(target, name)
            if os.path.exists(dst):
                continue
            if os.path.isdir(src):
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)

        # A breadcrumb in the old folder, so anyone who goes looking for
        # the database where it used to be is told where it went.
        with open(os.path.join(LEGACY_DATA_DIR, "MOVED - READ ME.txt"), "w",
                  encoding="utf-8") as note:
            note.write(
                "The Balaji Billing data folder has moved.\r\n\r\n"
                "It now lives at:\r\n"
                "    " + target + "\r\n\r\n"
                "Why: this folder is inside the program directory, which is deleted "
                "and rebuilt every time build_exe.bat runs - so keeping the database "
                "here meant every rebuild erased all bills, customers and stock.\r\n\r\n"
                "The files here are the old copy, left untouched as a safety net. "
                "The app no longer reads them. You can delete this folder once you "
                "are satisfied the app is working with your data.\r\n")
    except Exception:
        # If the copy fails the app still starts, with an empty database
        # in the new location; the old one is untouched and recoverable.
        pass


def subdir(*parts):
    """A folder inside the data directory, created on demand."""
    path = os.path.join(data_dir(), *parts)
    os.makedirs(path, exist_ok=True)
    return path


def describe():
    """Human-readable location, for the Settings screen and the README."""
    return data_dir()
