"""
updater.py - Auto-update logic for Vikray.

Checks for new versions on GitHub Releases, downloads with SHA-256 verification,
and silently installs via Inno Setup.

All operations are background-safe: no blocking, no threading of their own
(the caller decides), no UI except when an update is actually available.
"""

import os
import json
import hashlib
import subprocess
import urllib.request
import urllib.error
from datetime import datetime, timedelta
import logging
import appdata
import brand

logger = logging.getLogger(__name__)

# Cache the last check in settings so we don't hammer the feed
LAST_CHECK_KEY = "update_last_check"


def get_update_info(force=False):
    """Fetch and parse the latest.json feed.

    Args:
        force: ignore the 24-hour throttle and check now

    Returns:
        dict with version, url, sha256, notes, size, mandatory, min_version
        or None if the feed cannot be reached or already on latest
    """
    import database

    # Throttle unless forced
    if not force:
        last_check = database.get_setting(LAST_CHECK_KEY, "")
        if last_check:
            try:
                last_time = datetime.fromisoformat(last_check)
                if datetime.now() - last_time < timedelta(hours=brand.UPDATE_CHECK_INTERVAL_HOURS):
                    return None
            except (ValueError, TypeError):
                pass

    try:
        logger.info(f"Checking for updates at {brand.UPDATE_FEED_URL}")
        req = urllib.request.Request(
            brand.UPDATE_FEED_URL,
            headers={"User-Agent": f"Vikray/{brand.APP_VERSION}"},
        )
        with urllib.request.urlopen(req, timeout=8) as response:
            feed = json.loads(response.read().decode('utf-8'))

        # Record the check (even when already up to date - this is what
        # throttles background checks to once a day either way).
        database.set_setting(LAST_CHECK_KEY, datetime.now().isoformat())

        # Compare versions: convert "3.1" -> (3, 1) for safe comparison.
        # Never compare version strings directly - "3.10" sorts before
        # "3.9" as text despite being the newer release.
        feed_version = tuple(int(p) for p in str(feed.get('version', '0.0')).split('.'))
        current_version = tuple(int(p) for p in brand.APP_VERSION.split('.'))

        if feed_version > current_version:
            logger.info(f"Update available: {current_version} -> {feed_version}")
            return feed
        else:
            logger.info(f"Already on latest version {brand.APP_VERSION}")
            return None

    except Exception as e:
        # No internet, a bad feed, or GitHub being briefly unreachable are
        # all normal in a shop - log it and stay quiet rather than nag.
        logger.debug(f"Update check failed (normal if offline): {e}")
        return None


def download_installer(info, on_progress=None):
    """Download the installer from the feed's URL.

    Verifies SHA-256 before returning the path.

    Args:
        info: dict from get_update_info()
        on_progress: optional callback(bytes_so_far, total_bytes)

    Returns:
        Path to the verified installer, or None if the download or the
        hash check failed.
    """
    url = info.get('url')
    expected_sha256 = info.get('sha256')
    size = info.get('size', 0)

    if not url or not expected_sha256:
        logger.error("Update feed missing url or sha256")
        return None

    # Download to %LOCALAPPDATA%\BalajiBilling\updates\
    updates_dir = os.path.join(appdata.data_dir(), 'updates')
    os.makedirs(updates_dir, exist_ok=True)

    installer_name = f"Vikray-Setup-{info.get('version')}.exe"
    installer_path = os.path.join(updates_dir, installer_name)
    tmp_path = installer_path + ".part"

    try:
        logger.info(f"Downloading {url}")
        sha256_hash = hashlib.sha256()
        bytes_downloaded = 0

        req = urllib.request.Request(url, headers={"User-Agent": f"Vikray/{brand.APP_VERSION}"})
        with urllib.request.urlopen(req, timeout=30) as response:
            total = size or int(response.headers.get('Content-Length', 0) or 0)
            with open(tmp_path, 'wb') as f:
                while True:
                    chunk = response.read(65536)
                    if not chunk:
                        break
                    f.write(chunk)
                    sha256_hash.update(chunk)
                    bytes_downloaded += len(chunk)
                    if on_progress:
                        on_progress(bytes_downloaded, total)

        # Verify the hash before the file is ever treated as a real
        # installer - this is the security boundary. Without it, anyone
        # who can intercept the download can run code on every till.
        actual_sha256 = sha256_hash.hexdigest()
        if actual_sha256.lower() != str(expected_sha256).lower():
            logger.error(f"SHA-256 mismatch: expected {expected_sha256}, got {actual_sha256}")
            os.remove(tmp_path)
            return None

        os.replace(tmp_path, installer_path)
        logger.info(f"Downloaded and verified: {installer_path}")
        return installer_path

    except Exception as e:
        logger.error(f"Download failed: {e}")
        for p in (tmp_path, installer_path):
            if os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass
        return None


def apply_update(installer_path):
    """Run the installer silently and let the caller exit the app.

    Inno Setup with /SILENT and /RESTARTAPPLICATIONS will:
    - Close the running app (via AppMutex / CloseApplications)
    - Install the new version
    - Relaunch Vikray
    - All without any dialogs

    Args:
        installer_path: path to the .exe from download_installer()

    Returns:
        True if the installer process was launched, False otherwise.
    """
    if not os.path.exists(installer_path):
        logger.error(f"Installer not found: {installer_path}")
        return False

    try:
        log_path = os.path.join(appdata.data_dir(), 'updates', 'update.log')
        cmd = [
            installer_path,
            '/SILENT',
            '/NOCANCEL',
            '/RESTARTAPPLICATIONS',
            f'/LOG={log_path}',
        ]
        logger.info(f"Launching installer: {' '.join(cmd)}")
        subprocess.Popen(cmd, close_fds=True)
        return True
    except Exception as e:
        logger.error(f"Failed to launch installer: {e}")
        return False


def check_schema_version(db_conn):
    """Prevent the app from running against a newer database schema.

    If a newer version of Vikray was installed and then removed, or if
    the database was copied from a newer machine, this guard catches it
    before the app corrupts its data by trying to use tables/columns
    that don't exist.

    Args:
        db_conn: active sqlite3 connection

    Returns:
        tuple (is_valid, error_message)
        (True, None) if schema is compatible
        (False, msg) if schema is too new
    """
    cur = db_conn.cursor()

    # Get or initialize the schema version
    try:
        cur.execute("SELECT value FROM settings WHERE key = 'schema_version'")
        row = cur.fetchone()
        db_schema_version = int(row[0]) if row else 0
    except Exception:
        # No settings table yet, or other issue - treat as v0
        db_schema_version = 0

    # App schema version - bumped whenever we make incompatible changes
    # (new required columns, renamed tables, etc.)
    app_schema_version = 1

    if db_schema_version > app_schema_version:
        return False, (
            f"This database was created with a newer version of Vikray. "
            f"Database schema v{db_schema_version} > app schema v{app_schema_version}. "
            f"Please upgrade to a newer version of Vikray."
        )

    # Initialize or update schema version
    if db_schema_version < app_schema_version:
        try:
            cur.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                ('schema_version', str(app_schema_version))
            )
            db_conn.commit()
        except Exception as e:
            logger.warning(f"Could not update schema_version: {e}")

    return True, None
