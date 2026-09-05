"""
make_feed.py <version> [notes] - Phase 5 helper for RELEASE.bat.

Hashes the freshly-built installer and (re)writes latest.json at the
repo root, in exactly the shape app/updater.py expects. This file is
what becomes the GitHub release asset every device's feed points at -
see brand.py's UPDATE_FEED_URL, which always resolves to whichever
release GitHub currently considers "latest".
"""
import hashlib
import json
import sys
from datetime import date
from pathlib import Path

# The oldest version that can discover this update at all. Versions
# before 3.0 have no updater.py, so they can never reach this feed -
# this floor only matters again if a future release makes a breaking
# change (e.g. to the database) that an in-place update can't bridge.
# Edit latest.json by hand after this script runs if a specific
# release needs to raise it.
DEFAULT_MIN_VERSION = "3.0"


def fail(msg):
    print(f"  [X] {msg}")
    sys.exit(1)


def main():
    if len(sys.argv) < 2:
        fail("Usage: make_feed.py <version> [notes]")

    version = sys.argv[1]
    notes = sys.argv[2] if len(sys.argv) > 2 else "See the release notes on GitHub."

    root = Path(__file__).resolve().parent.parent
    installer = root / "installer" / f"Vikray-Setup-{version}.exe"

    if not installer.exists():
        fail(f"Installer not found: {installer}")

    h = hashlib.sha256()
    size = 0
    with open(installer, "rb") as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
            size += len(chunk)

    feed = {
        "version": version,
        "released": date.today().isoformat(),
        "url": f"https://github.com/Nikhil-Kedia/Billing/releases/download/v{version}/Vikray-Setup-{version}.exe",
        "sha256": h.hexdigest(),
        "size": size,
        "notes": notes,
        "min_version": DEFAULT_MIN_VERSION,
        "mandatory": False,
    }

    feed_path = root / "latest.json"
    feed_path.write_text(json.dumps(feed, indent=2) + "\n", encoding="utf-8")
    print(f"  latest.json written: version {version}, {size:,} bytes, "
          f"sha256 {h.hexdigest()[:16]}...")


if __name__ == "__main__":
    main()
