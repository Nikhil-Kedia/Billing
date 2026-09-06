"""
nova.py - entry point for the rewritten Balaji Billing desktop app
(pywebview + the HTML/CSS/JS UI in ../web, bridged to bridge.Api).

Startup order deliberately mirrors the original main.py (see its own
docstring): logging armed first, then the database, then maintenance on
a background thread so the window itself opens fast, then the window.

Run with:  python nova.py
Double-click a .bbak/.db/.bbakx file and Windows launches this same exe
with that path as argv[1] - see _pending_view_path().
"""

import os
import shutil
import sys
import threading


def resource_path(*parts):
    """Resolves a path to a bundled asset, working BOTH from source and
    from a PyInstaller one-file build.

    - From source: relative to this file's own folder (nova/app/).
    - Frozen (PyInstaller --onefile): PyInstaller unpacks everything into
      a temporary folder and tells us where via sys._MEIPASS - anything
      passed to `datas=` in the .spec file needs to be looked up there,
      never relative to sys.argv[0] (which is just the exe's own path).
    """
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, *parts)


# So `import database`, `import bridge`, etc. work regardless of the
# working directory the app happens to be launched from (e.g. a Windows
# file association launches with an arbitrary cwd).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import applog          # noqa: E402
import appdata         # noqa: E402
import database         # noqa: E402
import security         # noqa: E402
import brand             # noqa: E402


def _pending_view_path():
    """Looks at the launch arguments for a backup/archive file path -
    this is how Windows tells the app which file was double-clicked
    (see file_assoc.py in the original app)."""
    for arg in sys.argv[1:]:
        if arg.lower().endswith((".bbak", ".db", ".bbakx")) and os.path.isfile(arg):
            return arg
    return None


def _run_maintenance():
    """Housekeeping that must never be able to stop the app opening -
    run on a background thread so the window still appears immediately."""
    try:
        database.prune_audit_log(keep_days=365)
    except Exception as e:
        applog.report_error(e, "audit log pruning")
    try:
        import auto_backup
        auto_backup.run_if_due()
    except Exception as e:
        applog.report_error(e, "automatic backup")
    try:
        # Phase 2/3 auto-update: a quiet, throttled (24h) check against
        # the GitHub feed. bridge.py owns the shared state so the
        # Settings screen and this background check agree on what was
        # found - see bridge.check_for_updates_background().
        import bridge
        bridge.check_for_updates_background()
    except Exception as e:
        applog.report_error(e, "update check")


def _web_index():
    """Finds web/index.html, whether running from this repo's source
    layout (nova/app/nova.py + nova/web/index.html) or from a frozen
    one-file build that bundled the web/ folder alongside this script."""
    candidates = [
        resource_path("web", "index.html"),                                    # bundled alongside nova.py
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "index.html"),  # source layout
    ]
    for c in candidates:
        c = os.path.abspath(c)
        if os.path.isfile(c):
            return c
    # Nothing found - fail loudly with a path a developer can act on,
    # rather than pywebview's own opaque "file not found" further down.
    raise FileNotFoundError(
        "Could not find web/index.html. Looked in:\n" + "\n".join(os.path.abspath(c) for c in candidates))


#: Also named in build/installer.iss (AppMutex), so the installer can tell
#: the app is running and offer to close it instead of failing mid-copy.
SINGLE_INSTANCE_MUTEX = "VikrayBillingSingleInstance"


def _claim_single_instance():
    """True if this is the only copy running.

    Two windows on one SQLite file is how a till ends up with a half-written
    bill, so the second launch bows out and brings the first window forward
    instead. Returns True on any non-Windows platform (development).
    """
    if os.name != "nt":
        return True
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateMutexW.restype = wintypes.HANDLE
        handle = k32.CreateMutexW(None, wintypes.BOOL(True), SINGLE_INSTANCE_MUTEX)
        ERROR_ALREADY_EXISTS = 183
        if not handle or ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
            # Bring the window that is already open to the front.
            try:
                u32 = ctypes.WinDLL("user32", use_last_error=True)
                hwnd = u32.FindWindowW(None, None)
                shop = database.get_setting("store_name", "")
                target = u32.FindWindowW(None, brand.window_title(shop))
                if target:
                    u32.ShowWindow(target, 9)      # SW_RESTORE
                    u32.SetForegroundWindow(target)
            except Exception:
                pass
            return False
        # Keep a reference for the process lifetime so the mutex is held.
        globals()["_INSTANCE_MUTEX"] = handle
        return True
    except Exception:
        return True     # never let the guard itself stop the app opening


def _fatal(message, detail=""):
    """Last-resort error the user can actually read.

    A windowed build has no console, so an unhandled startup failure would
    otherwise just be a window that never appears.
    """
    applog.info(f"Fatal startup error: {message} {detail}")
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(
                None, f"{message}\n\n{detail}".strip(),
                f"{brand.APP_NAME} could not start", 0x10)
            return
        except Exception:
            pass
    print(f"{message}\n{detail}", file=sys.stderr)


def _prune_old(folder, days=30):
    """Deletes files in a scratch folder that nothing is waiting on.
    Best-effort: a file Windows still has open is skipped, not fatal."""
    import time
    cutoff = time.time() - days * 86400
    try:
        for name in os.listdir(folder):
            p = os.path.join(folder, name)
            try:
                if os.path.isfile(p) and os.path.getmtime(p) < cutoff:
                    os.remove(p)
            except OSError:
                pass
    except OSError:
        pass


def _open_as_archive(path):
    """Prepares an archive file for viewing and locks the app read-only.

    Three steps, in this order and for these reasons:

      1. COPY it. The file lives on a pendrive that can be pulled out,
         and it is the owner's only record of that day - the app must not
         hold a handle on the original, let alone write to it. Everything
         from here on happens to a copy in the app's own folder.
      2. MIGRATE the copy. An archive written months ago will be missing
         whatever columns and tables have been added since, and every
         screen would fail on it. init_db() brings the copy up to date -
         which is safe precisely because it is a copy.
      3. LOCK it. database.open_archive() flips every connection from
         here on to ?mode=ro, so nothing in the app can write to it even
         by accident. See database.get_connection().

    Returns True when the app should run in archive mode.
    """
    try:
        copy_dir = appdata.subdir("archive-view")
        # Working copies of archives opened in the past are of no use to
        # anyone once the window is closed. Left alone they would sit in
        # the app's folder for ever, one per archive ever double-clicked.
        _prune_old(copy_dir, days=30)
        # One copy per source file, reused: opening the same archive twice
        # should not leave a folder full of near-identical databases.
        stamp = "%08x" % (abs(hash(os.path.abspath(path))) & 0xFFFFFFFF)
        copy_path = os.path.join(copy_dir, f"view-{stamp}.db")
        shutil.copyfile(path, copy_path)
        for sidecar in ("-wal", "-shm"):
            stale = copy_path + sidecar
            if os.path.exists(stale):
                os.remove(stale)

        database.DB_PATH = copy_path
        database.DB_DIR = copy_dir
        database.init_db()                     # migrate the COPY, never the original
        database.open_archive(copy_path, source_path=path)
        applog.info(f"Opened archive read-only: {path}")
        return True
    except Exception as e:
        applog.report_error(e, "open_archive")
        _fatal("That archive could not be opened.",
               "The file may be damaged, or it may not be a Vikray archive.\n\n"
               f"File: {path}\n\nDetail: {type(e).__name__}: {e}")
        return False


def main():
    applog.install_global_handler()
    applog.info(f"{brand.APP_NAME} starting.")

    # A double-clicked archive opens the WHOLE app against that file
    # instead of the shop's live data - dashboard, bill history, customer
    # insights, all of it, showing the day that was archived. The original
    # app answered this with a separate cut-down Tk viewer; reusing the
    # real app is both less code and a better answer, because every screen
    # the owner already knows works on the archive too.
    #
    # See _open_as_archive() for how it is made safe.
    view_path = _pending_view_path()
    archive_mode = bool(view_path) and _open_as_archive(view_path)

    if not archive_mode:
        database.init_db()

    # Phase 6a: refuse to run against a database newer than this build
    # knows about, rather than silently corrupting it. Must run before
    # anything else touches the database.
    import updater
    db_conn = database.get_connection()
    is_valid, error_msg = updater.check_schema_version(db_conn)
    db_conn.close()
    if not is_valid:
        _fatal("Database version mismatch", error_msg)
        return

    # An archive is opened to look at, and more than one can reasonably be
    # open at once - so the single-instance lock and the nightly
    # maintenance (auto-backup, update check) are both skipped. Neither
    # has anything to do with a file on a pendrive, and the backup job in
    # particular must never run against one.
    if not archive_mode:
        if not _claim_single_instance():
            applog.info("Another copy is already running; this one is closing.")
            return

        # Maintenance runs in the background so the window opens fast - see
        # the module docstring and the original main.py it mirrors.
        threading.Thread(target=_run_maintenance, daemon=True).start()

    try:
        import webview
    except Exception as e:
        _fatal("The window component could not be loaded.",
               "Reinstalling the app usually fixes this.\n\nDetail: " + str(e))
        return
    # Anything bridge.py pulls in (reportlab, openpyxl, cryptography …) is a
    # chance for a packaging mistake to surface as a raw traceback in a popup.
    # Catch it here and say something a shopkeeper can act on instead.
    try:
        import bridge
    except Exception as e:
        _fatal("A part of the application is missing from this install.",
               "Reinstalling usually fixes it. If it keeps happening, send this line:\n\n"
               + f"{type(e).__name__}: {e}")
        return

    api = bridge.Api()

    shop_name = database.get_setting("store_name", "")
    title = brand.window_title(shop_name)
    if archive_mode:
        # The window's own title says what it is, so an archive and the
        # live app are never confused on a taskbar.
        title = f"{title} — ARCHIVE (read only): {os.path.basename(view_path)}"

    # maximized: the shop runs this on a full-size monitor all day and
    # expects it to fill the screen the moment it opens, the way the old
    # app did - not a 1360x860 window sitting in the middle that has to
    # be dragged bigger on every start. The width/height stay as the
    # restore-down size for when the window IS un-maximised.
    window_kwargs = dict(
        js_api=api,
        width=1360, height=860,
        min_size=(1100, 680),
        maximized=True,
    )
    icon_path = next((p for p in (resource_path("assets", "icon.ico"),
                                  resource_path("web", "icon.ico"),
                                  os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                               "..", "assets", "icon.ico"))
                      if os.path.isfile(p)), "")
    if icon_path:
        # Not every pywebview version/platform accepts `icon=`; this is
        # cosmetic, so a failure here must never stop the window opening.
        window_kwargs["icon"] = icon_path

    # Older pywebview builds accept neither `icon=` nor `maximized=`, and
    # both are cosmetic - drop them one at a time rather than letting an
    # unknown keyword stop the window opening at all.
    window = None
    for drop in ((), ("icon",), ("icon", "maximized")):
        kwargs = {k: v for k, v in window_kwargs.items() if k not in drop}
        try:
            window = webview.create_window(title, _web_index(), **kwargs)
            break
        except TypeError:
            continue
    if window is None:
        _fatal("The window could not be created.",
               "This build of the window component did not accept the window settings.")
        return

    try:
        # http_server=True matters more than it looks: the UI is built from
        # ES modules (`<script type="module">`), and Chromium refuses to load
        # those over file:// on CORS grounds - the window would simply come
        # up blank. pywebview's own local HTTP server serves web/ over
        # 127.0.0.1 instead, which modules are happy with.
        webview.start(gui="edgechromium", debug=False, http_server=True)
    except Exception as e:
        _fatal("The interface could not be displayed.",
               "This usually means the Microsoft Edge WebView2 runtime is missing.\n"
               "Install it free from:\n"
               "https://developer.microsoft.com/microsoft-edge/webview2/\n\n"
               "Detail: " + str(e))
        return
    applog.info(f"{brand.APP_NAME} closed.")


if __name__ == "__main__":
    main()
