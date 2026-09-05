"""
bump_version.py <version> - Phase 5 helper for RELEASE.bat.

Rewrites the one line in app/brand.py and the one #define in
build/installer.iss that carry the version number, so RELEASE.bat never
hand-edits either file and the two can never drift apart. Nothing else
in the codebase names a version - see brand.py's own docstring for why.
"""
import re
import sys
from pathlib import Path


def fail(msg):
    print(f"  [X] {msg}")
    sys.exit(1)


def main():
    if len(sys.argv) != 2:
        fail("Usage: bump_version.py <version>")

    version = sys.argv[1]
    if not re.match(r'^\d+\.\d+(\.\d+)?$', version):
        fail(f'Version must look like 3.1 or 3.1.2 - got "{version}"')

    root = Path(__file__).resolve().parent.parent

    brand_path = root / "app" / "brand.py"
    text = brand_path.read_text(encoding="utf-8")
    new_text, n = re.subn(r'APP_VERSION = "[^"]*"', f'APP_VERSION = "{version}"', text, count=1)
    if n != 1:
        fail(f"Could not find APP_VERSION in {brand_path}")
    brand_path.write_text(new_text, encoding="utf-8")

    iss_path = root / "build" / "installer.iss"
    text = iss_path.read_text(encoding="utf-8")
    new_text, n = re.subn(r'#define AppVersion\s+"[^"]*"',
                           f'#define AppVersion     "{version}"', text, count=1)
    if n != 1:
        fail(f"Could not find #define AppVersion in {iss_path}")
    iss_path.write_text(new_text, encoding="utf-8")

    print(f"  Version set to {version} in brand.py and installer.iss")


if __name__ == "__main__":
    main()
