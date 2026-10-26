/**
 * Global push-to-talk input on Windows.
 *
 * The RaceIQ UI is a browser tab, which cannot see key presses while the game
 * has focus. A small PowerShell helper (same approach as the tray icon) polls
 * GetAsyncKeyState for keyboard bindings and winmm joyGetPosEx for wheel and
 * button-box buttons, and prints state changes on stdout.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type PushToTalkBinding =
  | { kind: "keyboard"; vk: number; name: string }
  | { kind: "joystick"; deviceId: number; button: number; name: string };

export type InputDevice = { deviceId: number; name: string; buttons: number };

export const INPUT_HELPER_SUPPORTED = process.platform === "win32";

const SCRIPT = String.raw`
param([string]$Mode = "watch", [int]$Vk = 0, [int]$Joy = -1, [int]$Button = 0)
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class RaceIqInput {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [StructLayout(LayoutKind.Sequential)] public struct JOYINFOEX { public int dwSize, dwFlags, dwXpos, dwYpos, dwZpos, dwRpos, dwUpos, dwVpos, dwButtons, dwButtonNumber, dwPOV, dwReserved1, dwReserved2; }
  [DllImport("winmm.dll")] public static extern int joyGetPosEx(int id, ref JOYINFOEX info);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct JOYCAPS {
    public ushort wMid, wPid;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szPname;
    public int wXmin, wXmax, wYmin, wYmax, wZmin, wZmax, wNumButtons, wPeriodMin, wPeriodMax, wRmin, wRmax, wUmin, wUmax, wVmin, wVmax, wCaps, wMaxAxes, wNumAxes, wMaxButtons;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szRegKey;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szOEMVxD;
  }
  [DllImport("winmm.dll", CharSet = CharSet.Unicode, EntryPoint = "joyGetDevCapsW")] public static extern int joyGetDevCaps(IntPtr id, ref JOYCAPS caps, int size);
  public static long Buttons(int id) { var i = new JOYINFOEX(); i.dwSize = Marshal.SizeOf(i); i.dwFlags = 0xFF; return joyGetPosEx(id, ref i) == 0 ? (long)(uint)i.dwButtons : -1; }
  public static bool KeyDown(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
  public static string Name(int id) { var c = new JOYCAPS(); return joyGetDevCaps((IntPtr)id, ref c, Marshal.SizeOf(c)) == 0 ? c.szPname + "|" + c.wNumButtons : null; }
}
"@
function Out-Line($text) { [Console]::Out.WriteLine($text); [Console]::Out.Flush() }
if ($Mode -eq "devices") {
  for ($id = 0; $id -lt 16; $id++) { if ([RaceIqInput]::Buttons($id) -ge 0) { $n = [RaceIqInput]::Name($id); if ($n) { Out-Line ("dev " + $id + " " + $n) } } }
  exit 0
}
if ($Mode -eq "bind") {
  $base = @{}
  for ($id = 0; $id -lt 16; $id++) { $base[$id] = [RaceIqInput]::Buttons($id) }
  $held = @{}
  for ($vk = 8; $vk -lt 255; $vk++) { if ([RaceIqInput]::KeyDown($vk)) { $held[$vk] = $true } }
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    for ($vk = 8; $vk -lt 255; $vk++) {
      if ($vk -ge 0x10 -and $vk -le 0x12) { continue }
      if ([RaceIqInput]::KeyDown($vk)) { if (-not $held[$vk]) { Out-Line ("key " + $vk); exit 0 } } else { $held.Remove($vk) }
    }
    for ($id = 0; $id -lt 16; $id++) {
      $b = [RaceIqInput]::Buttons($id)
      if ($b -lt 0) { continue }
      $prev = [long]$base[$id]; if ($prev -lt 0) { $prev = 0 }
      $new = $b -band (-bnot $prev)
      if ($new -ne 0) { for ($bit = 0; $bit -lt 32; $bit++) { if (($new -shr $bit) -band 1) { Out-Line ("joy " + $id + " " + ($bit + 1) + " " + [RaceIqInput]::Name($id)); exit 0 } } }
      $base[$id] = $b
    }
    Start-Sleep -Milliseconds 15
  }
  Out-Line "timeout"
  exit 0
}
$last = $false
while ($true) {
  $pressed = $false
  if ($Vk -gt 0 -and [RaceIqInput]::KeyDown($Vk)) { $pressed = $true }
  if ($Joy -ge 0 -and $Button -gt 0) { $b = [RaceIqInput]::Buttons($Joy); if ($b -ge 0 -and (($b -shr ($Button - 1)) -band 1)) { $pressed = $true } }
  if ($pressed -ne $last) { $last = $pressed; if ($pressed) { Out-Line "ptt 1" } else { Out-Line "ptt 0" } }
  Start-Sleep -Milliseconds 15
}
`;

let scriptPath: string | null = null;
function ensureScript(): string {
  if (scriptPath) return scriptPath;
  scriptPath = join(tmpdir(), `raceiq-engineer-input-${process.pid}.ps1`);
  writeFileSync(scriptPath, SCRIPT, "utf8");
  process.on("exit", () => { try { if (scriptPath) unlinkSync(scriptPath); } catch {} });
  return scriptPath;
}

function runHelper(args: string[]): ChildProcess {
  return spawn(
    "powershell.exe",
    ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", ensureScript(), ...args],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
}

function onLines(proc: ChildProcess, handle: (line: string) => void): void {
  let buffer = "";
  proc.stdout?.setEncoding("utf8");
  proc.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) handle(line);
    }
  });
}

function collect(args: string[], timeoutMs: number): Promise<string[]> {
  return new Promise((resolve) => {
    if (!INPUT_HELPER_SUPPORTED) { resolve([]); return; }
    const lines: string[] = [];
    const proc = runHelper(args);
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    onLines(proc, (line) => lines.push(line));
    proc.on("exit", () => { clearTimeout(timer); resolve(lines); });
    proc.on("error", () => { clearTimeout(timer); resolve(lines); });
  });
}

function parseDeviceName(raw: string): { name: string; buttons: number } {
  const [name, buttons] = raw.split("|");
  return { name: (name ?? "").trim() || "Game controller", buttons: Number(buttons) || 0 };
}

export async function listInputDevices(): Promise<InputDevice[]> {
  const lines = await collect(["-Mode", "devices"], 15_000);
  return lines.flatMap((line) => {
    const match = /^dev (\d+) (.*)$/.exec(line);
    if (!match) return [];
    return [{ deviceId: Number(match[1]), ...parseDeviceName(match[2]) }];
  });
}

/** Waits for the next key or controller button press (up to 10 s). */
export async function captureBinding(): Promise<PushToTalkBinding | null> {
  const lines = await collect(["-Mode", "bind"], 20_000);
  for (const line of lines) {
    const key = /^key (\d+)$/.exec(line);
    if (key) { const vk = Number(key[1]); return { kind: "keyboard", vk, name: keyName(vk) }; }
    const joy = /^joy (\d+) (\d+) (.*)$/.exec(line);
    if (joy) {
      const device = parseDeviceName(joy[3]);
      return { kind: "joystick", deviceId: Number(joy[1]), button: Number(joy[2]), name: `${device.name} button ${joy[2]}` };
    }
  }
  return null;
}

/** Keeps a watcher running for the binding and reports press/release. */
export class PushToTalkWatcher {
  private proc: ChildProcess | null = null;
  private key = "";
  private stopped = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;

  private readonly onChange: (pressed: boolean) => void;
  private readonly onError: (message: string) => void;

  constructor(onChange: (pressed: boolean) => void, onError: (message: string) => void) {
    this.onChange = onChange;
    this.onError = onError;
  }

  apply(binding: PushToTalkBinding | null): void {
    const key = binding ? JSON.stringify(binding) : "";
    if (key === this.key && (this.proc || !binding)) return;
    this.key = key;
    this.stopProcess();
    if (!binding || !INPUT_HELPER_SUPPORTED) return;
    this.stopped = false;
    this.launch(binding);
  }

  stop(): void {
    this.stopped = true;
    this.key = "";
    this.stopProcess();
  }

  private launch(binding: PushToTalkBinding): void {
    const args = binding.kind === "keyboard"
      ? ["-Mode", "watch", "-Vk", String(binding.vk)]
      : ["-Mode", "watch", "-Joy", String(binding.deviceId), "-Button", String(binding.button)];
    const proc = runHelper(args);
    this.proc = proc;
    onLines(proc, (line) => {
      this.failures = 0;
      if (line === "ptt 1") this.onChange(true);
      else if (line === "ptt 0") this.onChange(false);
    });
    let stderr = "";
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-500); });
    const restart = () => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.onChange(false);
      if (this.stopped) return;
      this.failures++;
      if (stderr) this.onError(`Push-to-talk helper stopped: ${stderr.trim().split("\n").at(-1)}`);
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.failures, 5));
      this.restartTimer = setTimeout(() => { if (!this.stopped && this.key === JSON.stringify(binding)) this.launch(binding); }, delay);
    };
    proc.on("exit", restart);
    proc.on("error", restart);
  }

  private stopProcess(): void {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const proc = this.proc;
    this.proc = null;
    if (proc) { try { proc.kill(); } catch {} }
  }
}

const NAMED_KEYS: Record<number, string> = {
  0x08: "Backspace", 0x09: "Tab", 0x0d: "Enter", 0x13: "Pause", 0x14: "Caps Lock", 0x1b: "Esc", 0x20: "Space",
  0x21: "Page Up", 0x22: "Page Down", 0x23: "End", 0x24: "Home", 0x25: "Left", 0x26: "Up", 0x27: "Right", 0x28: "Down",
  0x2d: "Insert", 0x2e: "Delete", 0x5b: "Left Windows", 0x5c: "Right Windows", 0x90: "Num Lock", 0x91: "Scroll Lock",
  0xa0: "Left Shift", 0xa1: "Right Shift", 0xa2: "Left Ctrl", 0xa3: "Right Ctrl", 0xa4: "Left Alt", 0xa5: "Right Alt",
  0xba: ";", 0xbb: "=", 0xbc: ",", 0xbd: "-", 0xbe: ".", 0xbf: "/", 0xc0: "`", 0xdb: "[", 0xdc: "\\", 0xdd: "]", 0xde: "'",
};

export function keyName(vk: number): string {
  if (NAMED_KEYS[vk]) return NAMED_KEYS[vk];
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);
  if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk);
  if (vk >= 0x60 && vk <= 0x69) return `Numpad ${vk - 0x60}`;
  if (vk >= 0x70 && vk <= 0x87) return `F${vk - 0x6f}`;
  return `Key ${vk}`;
}
