; installer/raceiq.iss
; Compile with: iscc /DMyAppVersion=1.0.0 installer\raceiq.iss

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif

#define MyAppName "RaceIQ with Co-driver"
#define MyAppPublisher "Priyanshu Patel (unofficial fork of RaceIQ by SpeedHQ)"
#define MyAppURL "https://github.com/prisp09/RaceIQ-with-Co-driver"
#define MyAppExeName "raceiq.exe"

[Setup]
; Own AppId so this fork installs alongside the official RaceIQ instead of replacing it.
AppId={{4d3a53e2-4d5d-436e-856b-d6116b3ca52c}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={localappdata}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..
OutputBaseFilename=RaceIQ-with-Co-driver-Setup-v{#MyAppVersion}
LicenseFile=..\LICENSE
Compression=lzma
SolidCompression=yes
WizardStyle=modern
CloseApplications=force
SetupIconFile=..\assets\raceiq.ico
UninstallFilesDir={app}\uninstall
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Code]
procedure UpdatePrepareStatus(const Msg: String);
begin
  if not WizardSilent then
    WizardForm.PreparingLabel.Caption := Msg;
  Log(Msg);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  UpdatePrepareStatus('Closing RaceIQ...');
  Exec('taskkill', '/F /IM raceiq.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('powershell.exe', '-NoProfile -Command "Get-NetTCPConnection -LocalPort 3117 -State Listen -EA 0 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -EA 0 }"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  Result := '';
end;

[Files]
Source: "..\dist\raceiq.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\dist\data\*"; DestDir: "{app}\data"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\dist\node_modules\@libsql\win32-x64-msvc\*"; DestDir: "{app}\node_modules\@libsql\win32-x64-msvc"; Flags: ignoreversion
Source: "..\dist\node_modules\@duckdb\node-bindings-win32-x64\*"; DestDir: "{app}\node_modules\@duckdb\node-bindings-win32-x64"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\dist\credstore.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "raceiq-launcher.vbs"; DestDir: "{app}"; Flags: ignoreversion

[InstallDelete]
; Public contains only packaged assets; replace it completely on every install/upgrade.
; User data lives under data and is intentionally preserved.
Type: filesandordirs; Name: "{app}\public\*"

[Registry]
; Create startup entry on install (enabled by default)
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "RaceIQ with Co-driver"; ValueData: """{app}\raceiq.exe"""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"; ValueType: binary; ValueName: "RaceIQ with Co-driver"; ValueData: 03 00 00 00 00 00 00 00 00 00 00 00; Flags: uninsdeletevalue

[Icons]
Name: "{userprograms}\{#MyAppName}"; Filename: "wscript.exe"; Parameters: """{app}\raceiq-launcher.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{userprograms}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "wscript.exe"; Parameters: """{app}\raceiq-launcher.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "wscript.exe"; Parameters: """{app}\raceiq-launcher.vbs"""; WorkingDir: "{app}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent runasoriginaluser
Filename: "wscript.exe"; Parameters: """{app}\raceiq-launcher.vbs"""; WorkingDir: "{app}"; Flags: nowait skipifnotsilent runasoriginaluser

[UninstallRun]
Filename: "taskkill"; Parameters: "/F /IM raceiq.exe"; Flags: runhidden; RunOnceId: "KillRaceIQ"
Filename: "powershell.exe"; Parameters: "-NoProfile -Command ""Get-NetTCPConnection -LocalPort 3117 -State Listen -EA 0 | ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force -EA 0 }}"""; Flags: runhidden; RunOnceId: "KillPort3117"
Filename: "powershell.exe"; Parameters: "-NoProfile -Command ""Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'RaceIQ with Co-driver' -ErrorAction SilentlyContinue; Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' -Name 'RaceIQ with Co-driver' -ErrorAction SilentlyContinue"""; Flags: runhidden; RunOnceId: "RemoveStartup"
