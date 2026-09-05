"""
pdf_generator.py
Generates a compact, black-and-white, Tally-style PDF bill for Balaji Store.
Matches exact font styles (Helvetica), spacing, and layouts of standard professional invoices.
"""

import os
from xml.sax.saxutils import escape as _xml_escape

from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
)
from reportlab.lib.enums import TA_RIGHT, TA_LEFT, TA_CENTER
from reportlab.pdfgen.canvas import Canvas

import database as db
import safe_paths
import appdata

OUTPUT_DIR = appdata.subdir("bills")


def esc(value):
    """Escapes text before it goes into a ReportLab Paragraph.

    ReportLab Paragraphs are not plain text - they parse a small HTML-like
    markup (<b>, <br/>, <font>). Any customer name, item name or note
    containing '&', '<' or '>' was therefore being fed to a parser as
    markup. In practice that meant a shop selling "Rice & Dal" or an item
    written "Oil <1L>" could not print a bill at all: PDF generation threw,
    the bill saved but no PDF appeared, and the error shown gave no clue
    why. A crafted name could also alter the surrounding markup of the
    document.

    Everything user-supplied now passes through here. This is the desktop
    equivalent of escaping output to prevent injection - the sink is a
    markup parser either way.
    """
    return _xml_escape(str(value if value is not None else ""))

BLACK = colors.black

# Use full A4 width while keeping the content table at 180mm.
CUSTOM_PAGE_SIZE = (210 * mm, 297 * mm)

# Table width remains 180mm.
CONTENT_WIDTH = 180 * mm


class _NumberedCanvas(Canvas):
    """Adds "Page X of Y" to the bottom of every page.

    X is known as each page is drawn, but Y - the total - is not known
    until the whole document has been laid out. The standard way around
    that in ReportLab is to intercept every showPage() call, buffering
    the finished page's drawing state instead of actually emitting it,
    then replay all of them at save() time once the true page count is
    known and the footer can be stamped onto each one.
    """

    def __init__(self, *args, **kwargs):
        Canvas.__init__(self, *args, **kwargs)
        self._saved_page_states = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total_pages = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self._draw_page_number(total_pages)
            Canvas.showPage(self)
        Canvas.save(self)

    def _draw_page_number(self, total_pages):
        self.setFont("Helvetica", 8)
        self.setFillColor(BLACK)
        self.drawCentredString(
            CUSTOM_PAGE_SIZE[0] / 2.0, 6 * mm,
            f"Page {self._pageNumber} of {total_pages}")


# Sl, Description, Pack, Quantity, Rate, Amount.
#
# Pack sits before Quantity - the pack breakdown ("2 Carton") is read as
# "how it was billed", which comes before "how many units that is".
#
# Amount was measured against its actual worst case: the totals row
# prints "Rs. 9,99,999.99", which needs ~36.4mm at this table's 14.5pt
# bold font. 42mm leaves it a real margin without carrying dead space,
# and the 4mm taken from it went to Description, which is the one
# column that actually runs out of room (a long product name wrapping
# to a third line is what taxes this layout, not Amount running out of
# digits).
#
# Pack got 3mm more than a straight column-for-column swap would give
# it (27mm here, 24mm before), taken from Rate. Once Pack's text was
# put at the same 14.5pt as everything else - matching request #3 -
# its own worst realistic case ("1* Packet") measured wider than the
# 24mm column had room for once the smaller 11pt font that used to
# absorb that was gone, wrapping the ordinary case onto two lines
# rather than the extreme one.
#
# Rate -10% (27 -> 24.3mm) and Quantity raised to match Pack's 27mm
# (from 20mm) were both requested directly; the resulting +4.3mm gap
# came out of Amount (42 -> 37.7mm), also as requested. That leaves
# Amount narrower than its own worst case ("Rs. 9,99,999.99" needs
# ~39.2mm including padding) - rather than silently bleeding into
# Description the way the old Pack column did at its old width, the
# Amount cells for every item and the grand total are now a Paragraph
# (see amount_style below), which wraps onto a second line instead.
COL_WIDTHS = [8 * mm, 56 * mm, 27 * mm, 27 * mm, 24.3 * mm, 37.7 * mm]


# ---------------- NUMBER FORMATTING ----------------

def format_indian_currency(num):
    """Formats numbers with commas in the Indian numbering system (Lakhs, Crores)."""
    is_negative = num < 0
    num = abs(float(num))
    num_str = f"{num:.2f}"
    parts = num_str.split('.')
    integer_part = parts[0]
    decimal_part = parts[1]
    
    if len(integer_part) > 3:
        last_three = integer_part[-3:]
        remaining = integer_part[:-3]
        remaining_chunks = [remaining[max(i-2, 0):i] for i in range(len(remaining), 0, -2)]
        remaining_chunks.reverse()
        formatted_integer = ",".join(remaining_chunks) + "," + last_three
    else:
        formatted_integer = integer_part
        
    result = f"{formatted_integer}.{decimal_part}"
    return f"-{result}" if is_negative else result


# ---------------- AMOUNT IN WORDS ----------------

_ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
         "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
         "Eighteen", "Nineteen"]
_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def _two_digit_words(n):
    if n < 20:
        return _ONES[n]
    return _TENS[n // 10] + (" " + _ONES[n % 10] if n % 10 else "")


def _three_digit_words(n):
    if n >= 100:
        rest = n % 100
        return _ONES[n // 100] + " Hundred" + (" " + _two_digit_words(rest) if rest else "")
    return _two_digit_words(n)


def _number_to_words(n):
    if n == 0:
        return "Zero"
    parts = []
    crore, n = divmod(n, 10000000)
    lakh, n = divmod(n, 100000)
    thousand, n = divmod(n, 1000)
    hundred = n
    if crore:
        parts.append(_three_digit_words(crore) + " Crore")
    if lakh:
        parts.append(_three_digit_words(lakh) + " Lakh")
    if thousand:
        parts.append(_three_digit_words(thousand) + " Thousand")
    if hundred:
        parts.append(_three_digit_words(hundred))
    return " ".join(parts)


def amount_in_words(amount):
    rupees = int(amount)
    paise = int(round((amount - rupees) * 100))
    words = f"{_number_to_words(rupees)} Rupees"
    if paise:
        words += f" and {_number_to_words(paise)} Paise"
    words += " Only"
    return words


def fmt_qty(value):
    try:
        v = float(value)
        return f"{v:g}"
    except (TypeError, ValueError):
        return str(value)


# ---------------- PDF GENERATION ----------------

def generate_bill_pdf(bill, output_path=None):
    """
    bill: dict as returned by database.get_bill() / get_bill_by_number()
    Returns path to the generated PDF.
    """
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    if output_path is None:
        # A bill number can arrive from an imported backup file, so it is
        # never trusted as a path component. safe_paths also proves the
        # result stayed inside OUTPUT_DIR. Replaces the old
        # .replace("/", "-"), which missed "\\", ".." and device names.
        output_path = safe_paths.bill_pdf_path(OUTPUT_DIR, bill["bill_number"])

    # The store name on the bill header now comes from Settings, like the
    # contact number and address beside it. It was previously hard-coded
    # here, which quietly made the "Store Name" field in Settings do
    # nothing at all - the value was saved but never printed.
    store_name = db.get_setting("store_name", "Balaji Store") 
    store_contact = db.get_setting("store_contact", "")
    store_address = db.get_setting("store_address", "")

    # 10mm side margins on a 210mm-wide page leaves exactly 180mm of
    # printable width, matching the table width. The bottom margin is
    # 12mm rather than 5mm to leave room for the "Page X of Y" footer -
    # doc.height (the space the filler row and page-break math below is
    # measured against) is derived from this, so the content area
    # shrinks to match automatically rather than needing a separate
    # adjustment.
    doc = SimpleDocTemplate(
        output_path, pagesize=CUSTOM_PAGE_SIZE,
        topMargin=10 * mm, bottomMargin=12 * mm, leftMargin=10 * mm, rightMargin=10 * mm
    )
    styles = getSampleStyleSheet()

    # ---- Setup Styles ----
    title_style = ParagraphStyle("InvoiceTitle", parent=styles["Normal"], fontSize=14,
                                 fontName="Helvetica-Bold", alignment=TA_CENTER, textColor=BLACK, spaceAfter=6)
    store_name_style = ParagraphStyle("StoreName", parent=styles["Normal"], fontSize=12,
                                       fontName="Helvetica-Bold", alignment=TA_CENTER, textColor=BLACK, spaceAfter=2)
    store_sub_style = ParagraphStyle("StoreSub", parent=styles["Normal"], fontSize=8.5,
                                      fontName="Helvetica", alignment=TA_CENTER, textColor=BLACK, leading=10.5)
    label_style = ParagraphStyle("Label", parent=styles["Normal"], fontSize=8.5, fontName="Helvetica", textColor=BLACK, leading=11)
    cust_bold_style = ParagraphStyle("CustBold", parent=styles["Normal"], fontSize=14.5, fontName="Helvetica-Bold", textColor=BLACK, leading=16)
    item_bold_style = ParagraphStyle("ItemBold", parent=styles["Normal"], fontSize=14.5, fontName="Helvetica-Bold", textColor=BLACK, leading=16)
    # Pack is a raw string like every numeric column, EXCEPT that its
    # content ("2* Wholesale Carton Box") is free text a shopkeeper types
    # once when setting up an item, not a number of bounded width. A plain
    # string that overflows its column does not wrap or clip in a
    # reportlab Table - it just draws straight over the neighbouring
    # column. A Paragraph wraps inside its own column instead.
    pack_style = ParagraphStyle("PackStyle", parent=styles["Normal"], fontSize=14.5, fontName="Helvetica-Bold", textColor=BLACK, leading=16, alignment=TA_RIGHT)
    # Amount is a raw string everywhere else numeric columns are, which
    # is fine right up until a bill totals into six figures - the same
    # "a plain string does not wrap, it just bleeds into the next
    # column" failure Pack hit, on the column funded by taking width
    # away from it. A Paragraph wraps to a second line instead.
    amount_style = ParagraphStyle("AmountStyle", parent=styles["Normal"], fontSize=14.5, fontName="Helvetica-Bold", textColor=BLACK, leading=16, alignment=TA_RIGHT)
    note_style = ParagraphStyle("NoteStyle", parent=styles["Normal"], fontSize=13, fontName="Helvetica-Oblique", textColor=BLACK, leading=14.5)
    small_center = ParagraphStyle("SmallCenter", parent=styles["Normal"], fontSize=7.5,
                                   fontName="Helvetica", alignment=TA_CENTER, textColor=BLACK)

    # ---- 1. Header block ----
    header_inner = [Paragraph(esc(store_name), store_name_style)]
    addr_contact = store_address
    if store_contact:
        addr_contact = (addr_contact + " | " if addr_contact else "") + f"Contact: {store_contact}"
    if addr_contact:
        header_inner.append(Paragraph(esc(addr_contact), store_sub_style))
    header_row = Table([[header_inner]], colWidths=[CONTENT_WIDTH])
    header_row.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"), 
    ]))

    # ---- 2. Invoice meta strip ----
    meta_data = [[
        Paragraph(f"<b>Estimate No.</b> {esc(bill['bill_number'])}", label_style),
        Paragraph(f"<b>Dated:</b> {esc(bill['bill_date'])}", label_style),
        Paragraph(f"<b>Time:</b> {esc(bill['bill_time'])}", label_style),
    ]]
    meta_table = Table(meta_data, colWidths=[CONTENT_WIDTH / 3.0] * 3)
    meta_table.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.8, BLACK),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, BLACK),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("ALIGN", (0, 0), (0, 0), "LEFT"),
        ("ALIGN", (1, 0), (1, 0), "CENTER"),
        ("ALIGN", (2, 0), (2, 0), "RIGHT"),
    ]))

    # ---- 3. Bill To box ----
    cust_parts = [f"Party: {bill['customer_name']}"]
    if bill.get("customer_address"):
        cust_parts.append(bill["customer_address"])
    if bill.get("customer_phone"):
        phone = str(bill['customer_phone']).strip()
        if phone and not phone.startswith("+91"):
            if phone.startswith("91") and len(phone) > 10:
                phone = "+" + phone
            else:
                phone = "+91 " + phone
        cust_parts.append(f"Phone: {phone}")
    cust_para = Paragraph(" | ".join(esc(p) for p in cust_parts), cust_bold_style)
    cust_table = Table([[cust_para]], colWidths=[CONTENT_WIDTH])
    cust_table.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.8, BLACK),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
    ]))

    # ---- Pre-Table & Post-Table Layout Sections for Height Measurement ----
    words_para = Paragraph(f"Amount Chargeable (in words)<br/><b>INR {amount_in_words(bill['total'])}</b>", label_style)
    words_table = Table([[words_para]], colWidths=[CONTENT_WIDTH])
    words_table.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.8, BLACK),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
    ]))
    footer_note = Paragraph("This is a Computer Generated Estimate", small_center)

    story_before_table = [
        Paragraph("ESTIMATE", title_style),
        header_row, Spacer(1, 4), meta_table, Spacer(1, 0), cust_table, Spacer(1, 0)
    ]
    story_after_table = [
        Spacer(1, 0), words_table, Spacer(1, 5), footer_note
    ]

    # Dynamically measure exactly how much pixel space the above elements consume
    h_before = sum(f.wrap(doc.width, doc.height)[1] for f in story_before_table)
    h_after = sum(f.wrap(doc.width, doc.height)[1] for f in story_after_table)


    # ---- 4. Items table Data Setup ----
    table_data = [["Sl", "Description of Goods", "Pack", "Quantity", "Rate", "Amount"]]
    
    for i, item in enumerate(bill["items"], start=1):
        unit_val = item.get("unit", "")
        if not unit_val and item.get("item_id"):
            db_item = db.get_item(item["item_id"])
            if db_item and db_item.get("unit"):
                unit_val = db_item.get("unit")
        unit_suffix = f" {unit_val}" if unit_val else ""

        # Pack breakdown (e.g. "1* Carton") - frozen at the time this bill
        # was created (see database.py's create_bill/update_bill), so it
        # stays accurate even if the item's own carton size is changed
        # later. The '*' marks a partial box: quantity wasn't an exact
        # multiple of the pack size that was in effect at time of sale.
        pack_display = ""
        pack_qty = item.get("pack_qty")
        pack_unit = (item.get("pack_unit_name") or "").strip()
        pack_size = item.get("pack_size")
        if pack_qty and pack_unit:
            star = ""
            if pack_size:
                remainder = item["quantity"] - (pack_qty * pack_size)
                if abs(remainder) > 1e-9:
                    star = "*"
            pack_display = f"{fmt_qty(pack_qty)}{star} {pack_unit}"

        table_data.append([
            str(i),
            Paragraph(esc(item["item_name"].upper()), item_bold_style),
            Paragraph(esc(pack_display), pack_style) if pack_display else "",
            f"{fmt_qty(item['quantity'])}{unit_suffix}",
            format_indian_currency(item['price_per_unit']),
            Paragraph(format_indian_currency(item['final_price']), amount_style),
        ])

    n_item_rows = len(bill["items"])
    total_qty = sum(it["quantity"] for it in bill["items"])
    row_cursor = 1 + n_item_rows  

    freight_row = discount_row = notes_row = None
    first_extra_row = None

    if bill.get("freight_charges"):
        table_data.append(["", Paragraph("Add: Addition", note_style), "", "", "", format_indian_currency(bill['freight_charges'])])
        freight_row = row_cursor
        first_extra_row = first_extra_row if first_extra_row is not None else freight_row
        row_cursor += 1

    if bill.get("discount"):
        table_data.append(["", Paragraph("Less", note_style), "", "", "", f"(-){format_indian_currency(bill['discount'])}"])
        discount_row = row_cursor
        first_extra_row = first_extra_row if first_extra_row is not None else discount_row
        row_cursor += 1

    if bill.get("notes"):
        notes_para_inline = Paragraph(f"Notes: {esc(bill['notes'])}", note_style)
        table_data.append(["", notes_para_inline, "", "", "", ""])
        notes_row = row_cursor
        first_extra_row = first_extra_row if first_extra_row is not None else notes_row
        row_cursor += 1

    # ---- Exact Height Calculation & Table Styling ----
    
    # Using negative indices (-1 represents the last row, -2 the second to last) guarantees 
    # the styling remains flawless regardless of how many filler rows are dynamically injected.
    style_cmds = [
        ("BOX", (0, 0), (-1, -1), 0.8, BLACK),
        ("LINEBELOW", (0, 0), (-1, 0), 0.8, BLACK),           
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 8.5),
        ("FONTSIZE", (0, 1), (-1, -1), 14.5),
        ("ALIGN", (0, 0), (0, -1), "CENTER"), 
        ("ALIGN", (1, 0), (1, 0), "CENTER"),  
        ("ALIGN", (1, 1), (1, -2), "LEFT"),   
        ("ALIGN", (2, 0), (-1, -1), "RIGHT"), 
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 1), (-1, -2), 0),
        ("BOTTOMPADDING", (0, 1), (-1, -2), 0),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, 0), 2),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 2),
        ("LINEBEFORE", (1, 0), (1, -1), 0.5, BLACK),
        ("LINEBEFORE", (2, 0), (2, -1), 0.5, BLACK),
        ("LINEBEFORE", (3, 0), (3, -1), 0.5, BLACK),
        ("LINEBEFORE", (4, 0), (4, -1), 0.5, BLACK),
        ("LINEBEFORE", (5, 0), (5, -1), 0.5, BLACK),
        
        # Totals Row (Pinned to -1)
        ("ALIGN", (1, -1), (1, -1), "RIGHT"),
        ("VALIGN", (0, -1), (-1, -1), "MIDDLE"),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.8, BLACK),
        ("FONTSIZE", (0, -1), (-1, -1), 14.5),
        ("TOPPADDING", (0, -1), (-1, -1), 4),
        ("BOTTOMPADDING", (0, -1), (-1, -1), 4),
    ]

    if freight_row is not None:
        style_cmds += [
            ("ALIGN", (1, freight_row), (1, freight_row), "RIGHT"),
            ("TOPPADDING", (0, freight_row), (-1, freight_row), 2),
            ("FONTNAME", (5, freight_row), (5, freight_row), "Helvetica-Oblique"),
            ("FONTSIZE", (5, freight_row), (5, freight_row), 13),
        ]
    if discount_row is not None:
        style_cmds += [
            ("ALIGN", (1, discount_row), (1, discount_row), "RIGHT"),
            ("TOPPADDING", (0, discount_row), (-1, discount_row), 2),
            ("FONTNAME", (5, discount_row), (5, discount_row), "Helvetica-Oblique"),
            ("FONTSIZE", (5, discount_row), (5, discount_row), 13),
        ]
    if notes_row is not None:
        style_cmds += [
            ("TOPPADDING", (0, notes_row), (-1, notes_row), 3),
            ("BOTTOMPADDING", (0, notes_row), (-1, notes_row), 3),
        ]
    if first_extra_row is not None:
        style_cmds += [
            ("TOPPADDING", (0, first_extra_row), (-1, first_extra_row), 8),
        ]

    # Temporarily append the Total row just to measure the native table height
    total_row_data = ["", "Total", "", fmt_qty(total_qty), "",
                     Paragraph(f"Rs. {format_indian_currency(bill['total'])}", amount_style)]
    table_data.append(total_row_data)

    temp_table = Table(table_data, colWidths=COL_WIDTHS)
    temp_table.setStyle(TableStyle(style_cmds))
    h_table = temp_table.wrap(doc.width, doc.height)[1]

    # --- FIX APPLIED HERE ---
    # Increased safety net to a solid 20 points (~7mm) to stop ReportLab from breaking 
    # to the next page due to paragraph descenders in the footer.
    safety_buffer = 20
    available_for_filler = max(0, doc.height - h_before - h_after - h_table - safety_buffer)

    row_heights = [None] * len(table_data)

    # If there's enough space, inject the exact height filler row right before the totals
    if available_for_filler > 10:
        table_data.pop() # Pull the total out temporarily
        table_data.append(["", "", "", "", "", ""]) # Insert empty filler
        table_data.append(total_row_data) # Put the total back below the filler
        
        # Reset row heights to match new length, assigning the perfect pixel height to the filler row
        row_heights = [None] * len(table_data)
        row_heights[-2] = available_for_filler

    items_table = Table(table_data, colWidths=COL_WIDTHS, repeatRows=1, rowHeights=row_heights)
    items_table.setStyle(TableStyle(style_cmds))

    # ---- Assemble the Final Document ----
    story = []
    story.extend(story_before_table)
    story.append(items_table)
    story.extend(story_after_table)

    doc.build(story, canvasmaker=_NumberedCanvas)
    return output_path


if __name__ == "__main__":
    import database as db
    db.init_db()
    
    sample_bill = {
        "bill_number": "BS-0001",
        "customer_name": "Test Customer",
        "customer_phone": "9999999999",
        "customer_address": "Balangir, Odisha",
        "bill_date": "2026-07-18",
        "bill_time": "10:00 AM",
        "freight_charges": 50.00,
        "discount": 100.50,
        "subtotal": 125000.50,
        "total": 124950.00,
        "notes": "",
        "items": [
            {"item_name": "Sugar 1kg", "quantity": 21, "price_per_unit": 45.0, "final_price": 945.0,
             "unit": "kg", "pack_qty": 1, "pack_unit_name": "Carton", "pack_size": 16},
            {"item_name": "Rice 50kg Sack", "quantity": 50, "price_per_unit": 2500.0, "final_price": 125000.0, "unit": "case"},
        ]
    }
    path = generate_bill_pdf(sample_bill)
    print("Generated:", path)