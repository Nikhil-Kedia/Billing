; ============================================================
;  Vikray — Windows installer (Inno Setup 6)
;
;  Produces a single Vikray-Setup-3.0.exe: the usual wizard, a
;  Start-menu entry, an optional desktop icon, an entry in
;  Add/Remove Programs and a working uninstaller.
;
;  Installs per-user (no admin prompt) so the shop's till machine
;  doesn't need an administrator standing over it.
; ============================================================

#define AppName        "Vikray"
#define AppVersion     "3.0.5"
#define AppPublisher   "Vikray Retail Software"
#define AppExeName     "Vikray.exe"
#define SrcDir         "..\dist\Vikray"

[Setup]
AppId={{8E2C1A64-7F3B-4C1D-9E55-B1A0D6F27C31}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=no
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\installer
OutputBaseFilename=Vikray-Setup-{#AppVersion}
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName} {#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
AppMutex=VikrayBillingSingleInstance
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "startup";     Description: "Open Vikray when Windows starts"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "{#SrcDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}";              Filename: "{app}\{#AppExeName}"
Name: "{group}\Uninstall {#AppName}";    Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}";        Filename: "{app}\{#AppExeName}"; Tasks: desktopicon
Name: "{userstartup}\{#AppName}";        Filename: "{app}\{#AppExeName}"; Tasks: startup

[Registry]
; Double-clicking a .bbak archive opens it in Vikray, read-only - see
; nova.py's _open_as_archive(). Registered per-user (HKCU) to match this
; installer's non-admin, per-user install; Explorer honours it the same
; way and uninstalling takes it back out again.
Root: HKCU; Subkey: "Software\Classes\.bbak"; ValueType: string; ValueName: ""; ValueData: "Vikray.Archive"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\Vikray.Archive"; ValueType: string; ValueName: ""; ValueData: "Vikray archived bills"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\Vikray.Archive\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#AppExeName},0"
Root: HKCU; Subkey: "Software\Classes\Vikray.Archive\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExeName}"" ""%1"""

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Open {#AppName} now"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Only build leftovers — never the shop's data, which lives in
; %LOCALAPPDATA%\BalajiBilling and is deliberately left alone.
Type: filesandordirs; Name: "{app}\_internal\__pycache__"

[Code]
// WebView2 is what draws the interface. It ships with Windows 11 and
// current Windows 10, but a stripped or very old machine can be missing
// it, in which case the window would open blank — so check, and offer
// to fetch the tiny Evergreen bootstrapper rather than fail silently.
function WebView2Installed(): Boolean;
var
  v: string;
begin
  Result :=
    RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) or
    RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) or
    RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ErrCode: Integer;
begin
  if (CurStep = ssPostInstall) and (not WebView2Installed()) then
  begin
    if MsgBox('Vikray needs the Microsoft Edge WebView2 runtime to draw its screens, ' +
              'and it is not installed on this computer.' + #13#10#13#10 +
              'Open the free Microsoft download page now?',
              mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', 'https://developer.microsoft.com/microsoft-edge/webview2/',
                '', '', SW_SHOW, ewNoWait, ErrCode);
  end;
end;
