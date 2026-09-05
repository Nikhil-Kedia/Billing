"""
validation.py - one place where every piece of text or number typed by a
user (or read out of an imported backup file) is checked and cleaned
before it reaches the database, a PDF, or a filename.

Why this module exists:

  - The app previously accepted whatever was typed. A date typed as
    "tommorow" was stored verbatim and then silently broke Bill History
    filters, the archive-by-date workflow and the sales chart - none of
    which fail loudly, they just quietly return the wrong numbers.
  - A quantity or price could be negative, so a bill could be saved that
    ADDED stock and reduced the day's takings.
  - Text fields had no length limit, so a paste accident could put a
    100 KB blob into a customer's name and into every PDF after it.
  - Nothing stripped control characters, which corrupt both the PDF
    layout and the CSV/SQLite exports.

Everything here returns cleaned values or raises ValidationError with a
message that is already safe and readable to show in a dialog - callers
never build their own error text from an exception.
"""

import re
import unicodedata
from datetime import datetime

# ---------------- LIMITS ----------------

MAX_NAME_LENGTH = 120
MAX_PHONE_LENGTH = 20
MAX_ADDRESS_LENGTH = 300
MAX_NOTES_LENGTH = 500
MAX_CATEGORY_LENGTH = 60
MAX_UNIT_LENGTH = 20
MAX_ITEM_CODE_LENGTH = 40
MAX_SETTING_LENGTH = 500

# Ceilings exist to catch typos (a fat-fingered extra zero), not to limit
# real business. A single line item worth more than 10 crore, or a
# quantity above a million units, is a mistake in a shop this size.
MAX_MONEY = 100_000_000.0
MAX_QUANTITY = 1_000_000.0
MAX_ITEMS_PER_BILL = 200

DATE_FORMAT = "%Y-%m-%d"
TIME_FORMATS = ("%H:%M", "%H:%M:%S")


class ValidationError(Exception):
    """Message is always safe to display directly to the user."""


# ---------------- TEXT ----------------

def clean_text(value, max_length, field_name="This field", allow_empty=True):
    """Normalizes, strips control characters, collapses whitespace and
    enforces a length limit.

    Control characters are removed rather than escaped because there is
    no legitimate reason for one to appear in a customer name or an item
    description, and leaving them in breaks the PDF renderer, the
    Treeview lists and any later CSV export.
    """
    if value is None:
        value = ""
    if not isinstance(value, str):
        value = str(value)

    # NFKC folds look-alike/compatibility forms so that two names which
    # display identically also compare and de-duplicate identically.
    value = unicodedata.normalize("NFKC", value)

    # Drop every Unicode "Other" category (control, format, surrogate,
    # unassigned, private-use) except ordinary whitespace. This also
    # removes bidirectional-override characters, which can make a stored
    # name render in a misleading order.
    value = "".join(
        ch for ch in value
        if ch in ("\t", "\n", " ") or unicodedata.category(ch)[0] != "C"
    )

    value = re.sub(r"\s+", " ", value).strip()

    if not value and not allow_empty:
        raise ValidationError(f"{field_name} is required.")
    if len(value) > max_length:
        raise ValidationError(
            f"{field_name} is too long ({len(value)} characters). "
            f"Please keep it under {max_length}."
        )
    return value


def customer_name(value, required=True):
    name = clean_text(value, MAX_NAME_LENGTH, "Customer name", allow_empty=not required)
    if required and not name:
        raise ValidationError("Customer name is required.")
    return name


def item_name(value, required=True):
    name = clean_text(value, MAX_NAME_LENGTH, "Product name", allow_empty=not required)
    if required and not name:
        raise ValidationError("Product name is required.")
    return name


def address(value):
    return clean_text(value, MAX_ADDRESS_LENGTH, "Address")


def notes(value):
    return clean_text(value, MAX_NOTES_LENGTH, "Notes")


def item_code(value):
    code = clean_text(value, MAX_ITEM_CODE_LENGTH, "Item code")
    if code and not re.fullmatch(r"[A-Za-z0-9 ._/\-]+", code):
        raise ValidationError(
            "Item code can only contain letters, numbers, spaces and . _ - /"
        )
    return code


def unit(value):
    return clean_text(value, MAX_UNIT_LENGTH, "Unit")


def category(value):
    return clean_text(value, MAX_CATEGORY_LENGTH, "Category")


def setting_value(value):
    return clean_text(value, MAX_SETTING_LENGTH, "This setting")


# ---------------- PHONE ----------------

def phone(value, required=False):
    """Keeps the digits (and a single leading +) and rejects anything that
    can't be a real number. Stored in the same shape it was typed, so
    existing records and the WhatsApp sender both keep working - this only
    refuses input that was never valid."""
    raw = clean_text(value, MAX_PHONE_LENGTH, "Phone number")
    if not raw:
        if required:
            raise ValidationError("Phone number is required.")
        return ""

    compact = re.sub(r"[\s\-()]", "", raw)
    if not re.fullmatch(r"\+?\d{6,15}", compact):
        raise ValidationError(
            "Phone number doesn't look right.\n\n"
            "Enter digits only, for example 9876543210, or with a country "
            "code like +919876543210."
        )
    return compact


def whatsapp_number(value):
    """Digits only, with the Indian country code added for a bare 10-digit
    number - the same rule the WhatsApp sender already used, moved here so
    the number is validated before Chrome is ever launched."""
    digits = "".join(c for c in (value or "") if c.isdigit())
    if len(digits) == 10:
        digits = "91" + digits
    if not 10 <= len(digits) <= 15:
        raise ValidationError(
            "That phone number can't be used for WhatsApp.\n\n"
            "It needs to be a 10-digit number, or a full number with its "
            "country code."
        )
    return digits


# ---------------- NUMBERS ----------------

def _to_float(value, field_name):
    if value is None or (isinstance(value, str) and not value.strip()):
        return 0.0
    if isinstance(value, (int, float)):
        candidate = float(value)
    else:
        # Accept "1,250.50" as typed on an Indian keypad, but nothing else.
        text = str(value).strip().replace(",", "")
        try:
            candidate = float(text)
        except ValueError:
            raise ValidationError(f"{field_name} must be a number.")
    if candidate != candidate or candidate in (float("inf"), float("-inf")):
        raise ValidationError(f"{field_name} must be a number.")
    return candidate


def money(value, field_name="Amount", allow_negative=False, maximum=MAX_MONEY):
    amount = _to_float(value, field_name)
    if not allow_negative and amount < 0:
        raise ValidationError(f"{field_name} cannot be negative.")
    if abs(amount) > maximum:
        raise ValidationError(
            f"{field_name} looks too large ({amount:,.2f}). "
            f"Please check for an extra digit."
        )
    return round(amount, 2)


def quantity(value, field_name="Quantity", allow_zero=False):
    qty = _to_float(value, field_name)
    if qty < 0:
        raise ValidationError(f"{field_name} cannot be negative.")
    if not allow_zero and qty == 0:
        raise ValidationError(f"{field_name} must be more than zero.")
    if qty > MAX_QUANTITY:
        raise ValidationError(
            f"{field_name} looks too large ({qty:,.3f}). "
            f"Please check for an extra digit."
        )
    return round(qty, 3)


def pack_size(value):
    if value is None or (isinstance(value, str) and not str(value).strip()):
        return None
    size = _to_float(value, "Pack size")
    if size <= 0:
        raise ValidationError("Pack size must be more than zero, or left blank.")
    if size > MAX_QUANTITY:
        raise ValidationError("Pack size looks too large. Please check for an extra digit.")
    return round(size, 3)


# ---------------- DATE & TIME ----------------

def bill_date(value, field_name="Date"):
    """Accepts the app's own YYYY-MM-DD plus the two formats people
    actually type on an Indian keyboard, and always returns YYYY-MM-DD -
    the format every date filter, the archive workflow and the sales
    chart all assume. Previously any text at all was accepted here and
    silently made those features wrong."""
    text = (value or "").strip()
    if not text:
        return datetime.now().strftime(DATE_FORMAT)

    for fmt in (DATE_FORMAT, "%d-%m-%Y", "%d/%m/%Y", "%d.%m.%Y", "%Y/%m/%d"):
        try:
            parsed = datetime.strptime(text, fmt)
            break
        except ValueError:
            continue
    else:
        raise ValidationError(
            f"{field_name} '{text}' isn't a valid date.\n\n"
            f"Use the format YYYY-MM-DD, for example {datetime.now().strftime(DATE_FORMAT)}."
        )

    if not 2000 <= parsed.year <= 2100:
        raise ValidationError(f"{field_name} must have a year between 2000 and 2100.")
    return parsed.strftime(DATE_FORMAT)


def bill_time(value, field_name="Time"):
    text = (value or "").strip()
    if not text:
        return datetime.now().strftime("%H:%M")
    for fmt in TIME_FORMATS + ("%I:%M %p", "%I:%M%p"):
        try:
            return datetime.strptime(text, fmt).strftime("%H:%M")
        except ValueError:
            continue
    raise ValidationError(
        f"{field_name} '{text}' isn't a valid time.\n\n"
        f"Use 24-hour format like 14:30."
    )


# ---------------- BILL-LEVEL RULES ----------------

def validate_bill_totals(subtotal, addition, discount, amount_paid):
    """Cross-field rules that can only be checked once every individual
    field is known to be a valid number on its own.

    Returns the computed total. Raises with a plain-language explanation
    when the combination doesn't make business sense - a discount larger
    than the bill, or a payment larger than what is owed, are almost
    always a slip of the keypad and were previously saved without comment
    (and then quietly corrupted the customer's khata balance)."""
    total = round(subtotal + addition - discount, 2)

    if discount > subtotal + addition + 0.001:
        raise ValidationError(
            f"The 'Less' amount ({discount:,.2f}) is more than the bill itself "
            f"({subtotal + addition:,.2f}).\n\nPlease check the amount."
        )
    if total < 0:
        raise ValidationError("This bill works out to a negative total. Please check the amounts.")
    if amount_paid > total + 0.001:
        raise ValidationError(
            f"Amount paid ({amount_paid:,.2f}) is more than the bill total "
            f"({total:,.2f}).\n\nIf the customer is clearing an older balance, "
            f"record that as a payment in the Khata / Ledger screen instead."
        )
    return total


def validate_item_count(count):
    if count > MAX_ITEMS_PER_BILL:
        raise ValidationError(
            f"A single bill can hold up to {MAX_ITEMS_PER_BILL} items "
            f"(this one has {count}). Please split it into two bills."
        )
    return count
