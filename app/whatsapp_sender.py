"""
whatsapp_sender.py
Sends a PDF file to a customer's WhatsApp number by automating WhatsApp Web
through a real Chrome browser (Selenium).
"""

import os
import time
import appdata
# EXPLICIT IMPORT: Forces PyInstaller to pack the Chrome webdriver module
import selenium.webdriver.chrome.webdriver 
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException

# Kept with the rest of the data (see appdata.py): this folder holds a
# live WhatsApp Web session for the owner's own account, so losing it
# on a rebuild meant re-scanning the QR code every time.
PROFILE_DIR = appdata.subdir("whatsapp_profile")


def _clean_phone(phone):
    """Keep digits only; assume Indian numbers if no country code given (prefix 91)."""
    digits = "".join(c for c in phone if c.isdigit())
    if len(digits) == 10:
        digits = "91" + digits
    return digits


def _get_driver(headless=False):
    os.makedirs(PROFILE_DIR, exist_ok=True)
    options = Options()
    options.add_argument(f"--user-data-dir={PROFILE_DIR}")
    options.add_argument("--profile-directory=Default")
    options.add_argument("--start-maximized")
    
    # Stability flags to prevent DevToolsActivePort crash
    options.add_argument("--remote-debugging-port=0")
    options.add_argument("--disable-gpu")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-software-rasterizer")
    # NOTE: "--no-sandbox" was removed here during the security review.
    # It switches off Chrome's renderer sandbox, which is the main thing
    # standing between a hostile web page and the rest of this machine -
    # and this browser session is logged into the owner's WhatsApp
    # account. It is a workaround for running Chrome as root on Linux
    # containers and does nothing useful on a normal Windows desktop.
    
    # Removes the "Chrome is being controlled by automated software" warning
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option('useAutomationExtension', False)
    
    if headless:
        options.add_argument("--headless=new")
        
    try:
        driver = webdriver.Chrome(options=options)
        return driver
    except Exception as e:
        raise RuntimeError(f"Could not launch Chrome. Error: {e}")


def send_pdf_via_whatsapp(phone, pdf_path, caption="", wait_for_qr_scan=True, status_callback=None):
    """
    Opens WhatsApp Web, navigates to the chat for `phone`, attaches `pdf_path`
    as a document, adds an optional caption, and sends it.
    """
    def status(msg):
        if status_callback:
            try:
                status_callback(msg)
            except:
                pass
        else:
            print(msg)

    if not os.path.exists(pdf_path):
        return False, f"PDF file not found: {pdf_path}"

    clean_number = _clean_phone(phone)
    if len(clean_number) < 10:
        return False, f"Invalid phone number: {phone}"

    pdf_path = os.path.abspath(pdf_path)

    status("Launching Chrome...")
    try:
        driver = _get_driver(headless=False)
    except Exception as e:
        return False, str(e)

    wait = WebDriverWait(driver, 40)

    try:
        url = f"https://web.whatsapp.com/send?phone={clean_number}"
        driver.get(url)
        status("Opening WhatsApp Web chat...")

        # 1. Wait directly for the "+" attach button to appear (means the chat is fully open and valid)
        attach_btn_xpath = '//div[@title="Attach"] | //span[@data-icon="plus"] | //span[@data-icon="clip"]'
        
        try:
            attach_btn = wait.until(EC.element_to_be_clickable((By.XPATH, attach_btn_xpath)))
        except TimeoutException:
            # Check if it timed out because the number is invalid
            # We MUST use //div here to avoid matching hidden <script> tags containing error dictionary strings!
            invalid_check = driver.find_elements(By.XPATH, "//div[contains(text(),'invalid') or contains(text(),'not registered')]")
            if invalid_check:
                return False, f"This number is not registered on WhatsApp: +{clean_number}"
            
            if wait_for_qr_scan:
                status("Please scan the QR code with your phone (WhatsApp > Linked Devices)...")
                long_wait = WebDriverWait(driver, 120)
                attach_btn = long_wait.until(EC.element_to_be_clickable((By.XPATH, attach_btn_xpath)))
            else:
                return False, "WhatsApp Web not logged in and QR wait disabled."

        time.sleep(1.5) 

        # Double check for invalid number popup just in case it popped up late
        invalid = driver.find_elements(By.XPATH, "//div[contains(text(),'invalid') or contains(text(),'not registered')]")
        if invalid:
            return False, f"This number is not registered on WhatsApp: +{clean_number}"

        status("Attaching PDF...")
        # 2. Click the attach button we already found
        attach_btn.click()
        time.sleep(1.5)

        # 3. Push the PDF directly into the hidden Document file input
        doc_input = wait.until(EC.presence_of_element_located((By.XPATH, '//input[@accept="*"]')))
        doc_input.send_keys(pdf_path)
        
        status("Uploading document...")
        time.sleep(2.5) 

        # 4. Add a caption if provided
        if caption:
            try:
                caption_box = wait.until(EC.presence_of_element_located(
                    (By.XPATH, '//*[@title="Type a message"] | //*[@title="Type a message "] | //div[@contenteditable="true"][@data-tab="10"]')
                ))
                caption_box.send_keys(caption)
                time.sleep(1)
            except TimeoutException:
                pass  

        status("Sending...")
        # 5. Click the send button
        send_btn = wait.until(EC.element_to_be_clickable(
            (By.XPATH, '//span[@data-icon="send"] | //div[@aria-label="Send"]')
        ))
        send_btn.click()
        
        # 6. Wait for the file to actually upload over the network before closing Chrome
        time.sleep(6)

        status("Sent successfully.")
        return True, "Bill sent successfully via WhatsApp."

    except TimeoutException as e:
        return False, "Timed out waiting for WhatsApp. Your internet may be slow or the layout changed."
    except Exception as e:
        return False, f"Failed to send via WhatsApp: {e}"
    finally:
        driver.quit()


if __name__ == "__main__":
    # Manual test — replace with a real number and PDF path before running.
    ok, msg = send_pdf_via_whatsapp("9999999999", "data/bills/BS-0001.pdf", caption="Your bill from Balaji Store")
    print(ok, msg)