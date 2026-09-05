# Vikray — Billing & Inventory

A complete rewrite of the Balaji Store billing app: same data, same rules,
new interface.

---

## Build the installer (one step)

**Double-click `BUILD.bat`.**

It sets up its own Python environment, builds the app, and leaves a proper
Windows installer here:

```
installer\Vikray-Setup-3.0.exe
```

Double-click that to install Vikray like any other Windows program — Start
menu entry, optional desktop icon, and an uninstaller in Add/Remove Programs.
No admin password needed.

Requirements: Python 3.10+ (tick *Add python.exe to PATH* when installing it)
and an internet connection the first time, so the build can download what it
needs. Inno Setup is fetched automatically if `winget` is available; if it
isn't, the build still produces a working app in `dist\Vikray\` and tells you
where to get Inno Setup.

## Run it without building (for testing)

```
.venv\Scripts\python app\nova.py
```

---

## Your data

Nothing here touches it. The database, generated bill PDFs, backups and logs
live in:

```
%LOCALAPPDATA%\BalajiBilling\data
```

That is the **same folder the old app used**, so an installed Vikray opens
with every existing bill, customer, item and khata balance already in place.
Uninstalling Vikray leaves that folder alone.

When run from source (`python app\nova.py`) it uses the project's own `data\`
folder instead — a developer scratch copy — exactly as the old app did.

---

## What's in here

```
app\        The application. Python.
              nova.py       entry point: window, single-instance guard, startup
              bridge.py     the only door between the interface and the data
              database.py   the data layer — carried over unchanged
              …             validation, security, PDF, backup, import/export
              selftest.py   exercises every bridge method against a throwaway
                            copy of a real database. Run it after any change.
web\        The interface. Plain HTML/CSS/JS, no frameworks, no CDN.
              css\tokens.css   every colour, size and timing in the app
              js\panels.js     the resizable / collapsible panel system
              js\views\*.js    one file per screen
assets\     App icon.
build\      PyInstaller spec + Inno Setup installer script.
```

### Two rules worth keeping

1. **`css/tokens.css` is the single source of truth for appearance.** No screen
   hardcodes a colour. Changing the accent, the corner radius or the animation
   speed is a one-line edit there and the whole app follows.
2. **`bridge.py` is the only place the interface can reach data.** Every method
   returns `{ok: true, data}` or `{ok: false, error}`; the UI never sees a
   traceback and never talks to SQLite directly.

---

## Keyboard

The counter is meant to be worked without a mouse.

| Key | Where | What it does |
|---|---|---|
| `*` | customer row | Jump to the first item's code box |
| `*` | anywhere else | **Save & print the bill, immediately** |
| `Enter` | any field | Move forward; on the last row it adds a new one |
| `Enter` | item code | Skip straight to Quantity |
| `↑ ↓ ← →` | any field | Move around the form like a grid |
| `Ctrl+Enter` | anywhere | Save & print |
| `Ctrl+D` | an item row | Delete that row |
| `Ctrl+K` | anywhere | Search or jump to anything |
| `Ctrl+N` | anywhere | New bill |
| `Ctrl+B` | anywhere | Collapse / expand the sidebar |
| `F1` | anywhere | The full shortcut list |

`*` never types a `*` character — it is a command key everywhere on the bill
screen, including in the Pack box (the old app had a gap there where a stray
`*` could be typed into Pack and silently break its number; that is fixed).

## Panels

Every boundary between two boxes is a live edge:

- **drag** it to resize
- **click the handle** on it, or **double-click** the edge, to collapse that
  panel away — and again to bring it back
- **focus it and use the arrow keys** to resize without a mouse

Sizes are remembered per screen. *Settings → About → Reset panel layout* puts
everything back.
