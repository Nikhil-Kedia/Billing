"""
brand.py - the product's own identity, kept separate from the shop's.

WHY THIS FILE EXISTS

The app was built for one shop and had that shop's name compiled into it:
the window title, the sidebar heading and the sign-in screen all said
"Balaji Store". That is fine for one counter and fatal for a product you
intend to sell, because every retailer who installs it sees somebody
else's shop name on their own till.

So there are now two identities and they are never mixed:

  PRODUCT identity (this file)  - the software. Fixed. Same for every
                                  customer. Appears in the window title
                                  suffix, the About box, the installer,
                                  the log files.

  TENANT identity (Settings)    - the shop using it. Different for every
                                  customer. Appears in the sidebar, on
                                  printed bills, and on the sign-in
                                  screen.

Renaming the product is a one-line change here and nowhere else.
"""

# ---------------------------------------------------------------------
# PRODUCT
# ---------------------------------------------------------------------
# NOTE: "Vikray" (विक्रय, "sale") is a working name chosen so the product
# has *a* neutral identity instead of a client's shop name. Replace this
# one string with your real brand before you sell a licence - nothing
# else in the codebase needs to change.
APP_NAME = "Vikray"
APP_TAGLINE = "Billing & Inventory"
APP_LEGAL_NAME = "Vikray Retail Software"
APP_VERSION = "3.0.3"

# Shown in the About box and the sign-in footer.
APP_DESCRIPTION = (
    "Billing, inventory and khata for Indian retailers and wholesalers. "
    "Works fully offline."
)

SUPPORT_EMAIL = ""      # fill in before distributing
SUPPORT_PHONE = ""
WEBSITE = ""

# ---------------------------------------------------------------------
# AUTO-UPDATE
# ---------------------------------------------------------------------
# The feed is a small JSON file (see app/updater.py). It can live on
# GitHub Releases, your own website, or a LAN folder - the app just
# fetches a JSON from a URL and a file from a URL, so changing where it
# lives later is a one-line change here.
UPDATE_FEED_URL = "https://github.com/Nikhil-Kedia/Billing/releases/latest/download/latest.json"
UPDATE_CHECK_INTERVAL_HOURS = 24  # Throttle background checks to once per day


def window_title(shop_name=""):
    """The text in the Windows title bar and taskbar.

    Shop first, product second: the person at the counter needs to know
    which shop's books are open far more than they need to be reminded
    what the software is called. Matches how Excel, Word and every other
    document-shaped application title their windows.
    """
    shop = (shop_name or "").strip()
    if shop:
        return f"{shop} — {APP_NAME}"
    return f"{APP_NAME} — {APP_TAGLINE}"


def about_text():
    lines = [f"{APP_NAME} {APP_VERSION}", "", APP_DESCRIPTION, ""]
    if SUPPORT_EMAIL:
        lines.append(f"Support: {SUPPORT_EMAIL}")
    if SUPPORT_PHONE:
        lines.append(f"Phone: {SUPPORT_PHONE}")
    if WEBSITE:
        lines.append(WEBSITE)
    return "\n".join(lines).strip()
