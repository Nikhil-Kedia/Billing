"""
security.py - authentication, password hashing, roles/permissions,
login rate-limiting and the audit trail for the Balaji Billing System.

Design notes (why it looks like this):

  - This is a single-machine desktop app. There is no server to enforce
    anything, so "server-side authorization" here means: every privileged
    action is checked in ONE place (require()/has_permission() below)
    rather than being enforced only by hiding a button. Hiding the button
    is cosmetic; the check inside the action is what actually stops it.

  - Passwords are stored as PBKDF2-HMAC-SHA256 with a per-user random
    salt and a high iteration count (see PBKDF2_ITERATIONS). PBKDF2 is
    used rather than bcrypt/argon2 deliberately: it ships in Python's
    standard library, so the app gains a real password KDF without
    adding a compiled dependency that has to survive PyInstaller.
    The stored format carries its own iteration count, so the cost can
    be raised later and old hashes transparently upgrade on next login
    (see needs_rehash()).

  - Login attempts are throttled and the counter lives in the DATABASE,
    not in memory. An in-memory counter would be reset by simply closing
    and reopening the app, which makes it decorative rather than a
    control.

  - Roles are deliberately only two (Owner / Staff). More roles in a
    two-or-three-person shop just means permissions nobody understands.
"""

import base64
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta

# ---------------- PASSWORD HASHING ----------------

PBKDF2_ITERATIONS = 600_000   # OWASP-recommended floor for PBKDF2-HMAC-SHA256
SALT_BYTES = 16
KEY_BYTES = 32
HASH_SCHEME = "pbkdf2_sha256"

MIN_PASSWORD_LENGTH_OWNER = 8
MIN_PASSWORD_LENGTH_STAFF = 6

# Deliberately tiny: this is a shop-floor app, not a public website. The
# point is to stop the handful of passwords that would be guessed first,
# not to ship a dictionary.
_BANNED_PASSWORDS = {
    "password", "password1", "12345678", "123456", "1234567", "1234567890",
    "qwerty", "abc123", "iloveyou", "admin", "admin123", "letmein",
    "welcome", "billing", "balaji", "balaji123", "store", "store123",
    "00000000", "11111111", "987654321",
}


def hash_password(password, iterations=PBKDF2_ITERATIONS):
    """Returns a self-describing hash string:
        pbkdf2_sha256$<iterations>$<salt_b64>$<hash_b64>
    The salt is fresh and random for every call, so two users with the
    same password never share a hash."""
    if not isinstance(password, str) or not password:
        raise ValueError("Password must be a non-empty string.")
    salt = secrets.token_bytes(SALT_BYTES)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=KEY_BYTES)
    return "{}${}${}${}".format(
        HASH_SCHEME,
        iterations,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(dk).decode("ascii"),
    )


def verify_password(password, stored):
    """Constant-time verification. Returns False for anything malformed
    rather than raising, so a corrupted row can't crash the login screen
    (it just refuses the login, which is the safe direction)."""
    if not password or not stored:
        return False
    try:
        scheme, iter_s, salt_b64, hash_b64 = stored.split("$")
        if scheme != HASH_SCHEME:
            return False
        iterations = int(iter_s)
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
    except (ValueError, TypeError):
        return False
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=len(expected))
    return hmac.compare_digest(dk, expected)


def needs_rehash(stored, iterations=PBKDF2_ITERATIONS):
    """True when a stored hash was made with a weaker cost than we now
    use, so it can be silently upgraded the next time that user logs in
    (we only have the plaintext at that moment)."""
    try:
        scheme, iter_s, _salt, _hash = stored.split("$")
        return scheme != HASH_SCHEME or int(iter_s) < iterations
    except (ValueError, AttributeError):
        return True


def validate_password_strength(password, role):
    """Returns (ok, message). Kept intentionally mild - an unusable rule
    just gets written on a sticky note attached to the monitor, which is
    worse than a slightly shorter password."""
    minimum = MIN_PASSWORD_LENGTH_OWNER if role == ROLE_OWNER else MIN_PASSWORD_LENGTH_STAFF
    if not password or len(password) < minimum:
        return False, f"Password must be at least {minimum} characters long."
    if password.lower() in _BANNED_PASSWORDS:
        return False, "That password is too easy to guess. Please choose a different one."
    if password.isdigit() and len(set(password)) <= 2:
        return False, "That password is too simple. Please choose a different one."
    return True, ""


# ---------------- ROLES & PERMISSIONS ----------------

ROLE_OWNER = "owner"
ROLE_STAFF = "staff"
ROLES = (ROLE_OWNER, ROLE_STAFF)

ROLE_LABELS = {
    ROLE_OWNER: "Owner (full access)",
    ROLE_STAFF: "Staff (billing & lookup only)",
}

# Every privileged capability in the app. Anything NOT listed here is
# available to everyone who is logged in (creating bills, searching,
# opening a PDF, sending WhatsApp - the day-to-day work).
PERM_DELETE_BILL = "delete_bill"
PERM_DELETE_ALL_BILLS = "delete_all_bills"
PERM_EDIT_BILL = "edit_bill"
PERM_MANAGE_INVENTORY = "manage_inventory"
PERM_RESET_INVENTORY = "reset_inventory"
PERM_DELETE_CUSTOMER = "delete_customer"
PERM_VIEW_ANALYTICS = "view_analytics"
PERM_MANAGE_SETTINGS = "manage_settings"
PERM_BACKUP_DATA = "backup_data"
PERM_IMPORT_DATA = "import_data"
PERM_ARCHIVE_BILLS = "archive_bills"
PERM_MANAGE_USERS = "manage_users"
PERM_VIEW_AUDIT_LOG = "view_audit_log"
PERM_CLEAR_STOCK_HISTORY = "clear_stock_history"
PERM_LEDGER_PAYMENT = "ledger_payment"

# Owner gets everything by definition (see has_permission), so only the
# Staff grant list needs writing out. Staff can run the shop counter:
# make bills, edit a mistake they just made, look customers up, take a
# payment against the khata. They cannot destroy or export history.
_STAFF_PERMISSIONS = frozenset({
    PERM_EDIT_BILL,
    PERM_MANAGE_INVENTORY,
    PERM_LEDGER_PAYMENT,
})

PERMISSION_LABELS = {
    PERM_DELETE_BILL: "delete a bill",
    PERM_DELETE_ALL_BILLS: "delete all bills",
    PERM_EDIT_BILL: "edit a saved bill",
    PERM_MANAGE_INVENTORY: "add or edit inventory items",
    PERM_RESET_INVENTORY: "reset all stock quantities",
    PERM_DELETE_CUSTOMER: "delete a customer",
    PERM_VIEW_ANALYTICS: "view sales analytics",
    PERM_MANAGE_SETTINGS: "change store settings",
    PERM_BACKUP_DATA: "back up data",
    PERM_IMPORT_DATA: "import data",
    PERM_ARCHIVE_BILLS: "archive bills",
    PERM_MANAGE_USERS: "manage user accounts",
    PERM_VIEW_AUDIT_LOG: "view the activity log",
    PERM_CLEAR_STOCK_HISTORY: "clear the stock history log",
    PERM_LEDGER_PAYMENT: "record a khata payment",
}


class PermissionDenied(Exception):
    """Raised by require(). Carries a message already safe to show a user."""


# ---------------- CURRENT SESSION ----------------

class Session:
    """The logged-in user for this run of the app.

    Deliberately a single module-level object rather than something
    passed around: there is exactly one user at the keyboard, and
    threading it through every widget constructor would just create
    places to forget it (and therefore places to skip the check).
    """

    def __init__(self):
        self.user_id = None
        self.username = None
        self.role = None
        self.display_name = None
        self.login_time = None
        self.last_activity = None
        self.enabled = False   # set True once auth is switched on

    @property
    def is_authenticated(self):
        return self.user_id is not None

    @property
    def is_owner(self):
        return self.role == ROLE_OWNER

    def start(self, user_id, username, role, display_name=""):
        self.user_id = user_id
        self.username = username
        self.role = role
        self.display_name = display_name or username
        self.login_time = datetime.now()
        self.last_activity = datetime.now()

    def touch(self):
        self.last_activity = datetime.now()

    def end(self):
        self.user_id = None
        self.username = None
        self.role = None
        self.display_name = None
        self.login_time = None
        self.last_activity = None

    def idle_seconds(self):
        if self.last_activity is None:
            return 0
        return (datetime.now() - self.last_activity).total_seconds()


current = Session()


def has_permission(permission):
    """The single source of truth for 'is this allowed'.

    When authentication is switched off the app behaves exactly as it did
    before it existed - everything allowed - so turning the feature on and
    off never leaves the app in a half-locked state.
    """
    if not current.enabled:
        return True
    if not current.is_authenticated:
        return False
    if current.role == ROLE_OWNER:
        return True
    return permission in _STAFF_PERMISSIONS


def require(permission):
    """Call at the top of any privileged action. Raises PermissionDenied
    with a message that is already safe to put in a dialog.

    This is the authorization check that actually matters - graying out a
    button is only a hint, and a keyboard shortcut or a code path added
    later can bypass the hint but not this.
    """
    if has_permission(permission):
        return True
    what = PERMISSION_LABELS.get(permission, "do that")
    raise PermissionDenied(
        f"You do not have permission to {what}.\n\n"
        f"You are signed in as {current.display_name or 'Staff'} "
        f"({ROLE_LABELS.get(current.role, 'Staff')}).\n"
        f"Ask the owner to sign in for this."
    )


# ---------------- LOGIN RATE LIMITING ----------------

MAX_FAILED_ATTEMPTS = 5
LOCKOUT_MINUTES = 5
# After repeated lockouts the wait grows, so a patient guesser gets
# slower rather than simply waiting out a fixed penalty forever.
LOCKOUT_ESCALATION = [5, 5, 15, 30, 60]


def lockout_duration(lockout_count):
    idx = min(max(lockout_count, 0), len(LOCKOUT_ESCALATION) - 1)
    return timedelta(minutes=LOCKOUT_ESCALATION[idx])


def format_remaining(delta):
    total = int(max(0, delta.total_seconds()))
    if total >= 60:
        mins = (total + 59) // 60
        return f"{mins} minute{'s' if mins != 1 else ''}"
    return f"{total} second{'s' if total != 1 else ''}"


# ---------------- MISC ----------------

def new_token(nbytes=32):
    """Cryptographically strong random token, used for the one-time
    recovery code shown when an Owner account is created."""
    return secrets.token_urlsafe(nbytes)


def generate_recovery_code():
    """A human-transcribable recovery code, e.g. 'K7QP-2MRX-9FTA-4WHD'.
    Uses a Crockford-ish alphabet with the characters that get misread by
    people (0/O, 1/I/L, U) removed, so a code copied off a screen onto
    paper and typed back in a month later actually works."""
    alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
    groups = ["".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(4)]
    return "-".join(groups)


def normalize_recovery_code(code):
    """Accepts the code however it was typed - spaces, lowercase, missing
    dashes - and returns the canonical form for comparison."""
    cleaned = "".join(c for c in (code or "").upper() if c.isalnum())
    return "-".join(cleaned[i:i + 4] for i in range(0, len(cleaned), 4))
