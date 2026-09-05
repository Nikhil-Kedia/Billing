# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for Vikray (Balaji Billing & Inventory).

One-dir build on purpose: it starts noticeably faster than one-file
(no unpack to a temp folder on every launch) and the installer is what
hides the folder from the user, so they only ever see a single app.

Build with:   pyinstaller build\nova.spec --noconfirm --clean
"""

import os

ROOT = os.path.abspath(os.path.join(os.getcwd()))
APP = os.path.join(ROOT, 'app')
WEB = os.path.join(ROOT, 'web')
ASSETS = os.path.join(ROOT, 'assets')

a = Analysis(
    [os.path.join(APP, 'nova.py')],
    pathex=[APP],                       # backend modules import each other flat
    binaries=[],
    datas=[
        (WEB, 'web'),                   # the whole UI
        (ASSETS, 'assets'),             # icon
    ],
    hiddenimports=[
        'webview.platforms.edgechromium',
        'clr_loader', 'pythonnet',
        'reportlab.pdfbase._fontdata_enc_winansi',
        'reportlab.pdfbase._fontdata_enc_macroman',
        'reportlab.pdfbase._fontdata_widths_helvetica',
        'reportlab.pdfbase._fontdata_widths_helveticabold',
        'openpyxl.cell._writer',
        'sqlite3',
    ],
    hookspath=[],
    runtime_hooks=[],
    # Selenium (WhatsApp sending) is optional and heavy; it is imported
    # lazily at the moment it is used, and excluded here so the build stays
    # small. Remove it from this list if WhatsApp sending is needed.
    # PIL is NOT excluded: reportlab.lib.utils imports it at import time,
    # and safe_paths.py uses it to validate a logo image.
    excludes=['tkinter', 'matplotlib', 'numpy', 'pandas', 'selenium', 'customtkinter'],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='Vikray',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,                      # windowed app, no console flash
    disable_windowed_traceback=False,
    icon=os.path.join(ASSETS, 'icon.ico'),
    version=os.path.join(ROOT, 'build', 'version_info.txt')
        if os.path.exists(os.path.join(ROOT, 'build', 'version_info.txt')) else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='Vikray',
)
