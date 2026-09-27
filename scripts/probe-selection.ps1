# End-to-end check of the DSH Bubble selection toolbar lifecycle.
#
# Opens a throwaway text window, selects text with a synthetic drag, then collapses the selection
# with a Right-arrow key press. Keys do not dismiss the toolbar, so the only path that can retire it
# is the selection poll - this isolates exactly that behaviour.
#
# Usage: probe-selection.ps1 [-Target notepad|edge]

param([string]$Target = 'notepad')

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class BubbleProbe3 {
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool EnumThreadWindows(int threadId, EnumProc lpfn, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId2(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  /** Force a window to the foreground even from a background process. */
  public static void ForceForeground(IntPtr h) {
    uint target = GetWindowThreadProcessId(h, IntPtr.Zero);
    uint self = GetCurrentThreadId();
    AttachThreadInput(self, target, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    SetFocus(h);
    AttachThreadInput(self, target, false);
  }
  /** "hwnd [process#pid] 'title'" so focus hand-off is readable in probe output. */
  public static string Describe(IntPtr h) {
    if (h == IntPtr.Zero) return "none";
    var sb = new StringBuilder(256);
    GetWindowText(h, sb, 256);
    string owner = "?";
    foreach (var p in System.Diagnostics.Process.GetProcesses()) {
      try { if (p.MainWindowHandle == h) { owner = p.ProcessName + "#" + p.Id; break; } } catch { }
    }
    return h.ToString() + " [" + owner + "] '" + sb.ToString() + "'";
  }
  public static IntPtr FindByTitle(int pid, string title) {
    IntPtr found = IntPtr.Zero;
    try {
      var proc = System.Diagnostics.Process.GetProcessById(pid);
      foreach (System.Diagnostics.ProcessThread t in proc.Threads) {
        EnumThreadWindows(t.Id, (h, l) => {
          var sb = new StringBuilder(256);
          GetWindowText(h, sb, 256);
          if (sb.ToString() == title) { found = h; return false; }
          return true;
        }, IntPtr.Zero);
      }
    } catch { }
    return found;
  }
  public static IntPtr BiggestVisibleWindow(int pid) {
    IntPtr best = IntPtr.Zero; int bestArea = 0;
    try {
      var proc = System.Diagnostics.Process.GetProcessById(pid);
      foreach (System.Diagnostics.ProcessThread t in proc.Threads) {
        EnumThreadWindows(t.Id, (h, l) => {
          if (!IsWindowVisible(h)) return true;
          RECT r; GetWindowRect(h, out r);
          int area = (r.Right - r.Left) * (r.Bottom - r.Top);
          if (area > bestArea) { bestArea = area; best = h; }
          return true;
        }, IntPtr.Zero);
      }
    } catch { }
    return best;
  }
  /** Store apps (Notepad) and browsers (Edge) host their window in a child process. */
  public static IntPtr BestHwnd = IntPtr.Zero;
  public static int BestPid = 0;
  public static void FindBiggestVisibleWindow(string name) {
    IntPtr best = IntPtr.Zero; int bestArea = 0; int owner = 0;
    foreach (var proc in System.Diagnostics.Process.GetProcessesByName(name)) {
      try {
        foreach (System.Diagnostics.ProcessThread t in proc.Threads) {
          EnumThreadWindows(t.Id, (h, l) => {
            if (!IsWindowVisible(h)) return true;
            RECT r; GetWindowRect(h, out r);
            int area = (r.Right - r.Left) * (r.Bottom - r.Top);
            if (area > bestArea) { bestArea = area; best = h; owner = proc.Id; }
            return true;
          }, IntPtr.Zero);
        }
      } catch { }
    }
    BestHwnd = best;
    BestPid = owner;
  }
}
'@

$ball = Get-Process -Name 'dsh-bubble-shell' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $ball) { throw 'the floating ball is not running' }

$before = New-Object BubbleProbe3+POINT
[void][BubbleProbe3]::GetCursorPos([ref]$before)
"target=$Target  ballPid=$($ball.Id)  cursor=($($before.X),$($before.Y))"

$proc = $null
$sample = "$env:TEMP\bubble-probe-note.txt"
if ($Target -eq 'edge') {
  & taskkill /IM msedge.exe /F 2>&1 | Out-Null
  Start-Sleep -Milliseconds 400
  $profile = "$env:TEMP\bubble-probe-edge"
  $proc = Start-Process msedge.exe -ArgumentList @(
    "--user-data-dir=$profile", '--no-first-run', '--no-default-browser-check',
    '--disable-features=msEdgeFirstRunExperience,msEdgeWelcomePage,EdgeCollections',
    '--disable-sync', '--disable-extensions',
    '--window-size=1000,420', '--window-position=80,120',
    "file:///E:/chat/dsh-bubble/docs/probe.html"
  ) -PassThru
  Start-Sleep -Seconds 6
} else {
  Get-Process notepad -ErrorAction SilentlyContinue | Stop-Process -Force
  Set-Content -Path $sample -Value @(
    'SELECTION TOOLBAR LIFECYCLE PROBE ALPHA BRAVO CHARLIE',
    'DELTA ECHO FOXTROT GOLF HOTEL INDIA JULIET KILO LIMA',
    'MIKE NOVEMBER OSCAR PAPA QUEBEC ROMEO SIERRA TANGO'
  ) -Encoding UTF8
  $proc = Start-Process notepad.exe -ArgumentList $sample -PassThru
  Start-Sleep -Seconds 3
}

$win = [IntPtr]::Zero
if ($Target -eq 'edge') { [BubbleProbe3]::FindBiggestVisibleWindow('msedge') }
else { [BubbleProbe3]::FindBiggestVisibleWindow('Notepad') }
$win = [BubbleProbe3]::BestHwnd
$ownerPid = [BubbleProbe3]::BestPid
if ($win -eq [IntPtr]::Zero) { $win = [BubbleProbe3]::BiggestVisibleWindow($proc.Id) }
if ($win -eq [IntPtr]::Zero) { throw "no visible window found for $Target" }
"window hwnd=$win ownerPid=$ownerPid"
"foreground before select = $([BubbleProbe3]::Describe([BubbleProbe3]::GetForegroundWindow()))"
[BubbleProbe3]::ForceForeground($win)
Start-Sleep -Milliseconds 900
# Safety gate: never synthesise input unless the target really took the foreground, otherwise the
# drag lands in whatever window the user is actually working in.
$fg = [BubbleProbe3]::GetForegroundWindow()
if ($fg -ne $win) {
  "ABORT: $Target did not take the foreground; it is $([BubbleProbe3]::Describe($fg))."
  "       Refusing to synthesise input into a window that belongs to the user."
  [void][BubbleProbe3]::SetCursorPos($before.X, $before.Y)
  Get-Process -Id $proc.Id -ErrorAction SilentlyContinue | Stop-Process -Force
  if ($Target -eq 'edge') { Remove-Item "$env:TEMP\bubble-probe-edge" -Recurse -Force -ErrorAction SilentlyContinue }
  exit 3
}
$rect = New-Object BubbleProbe3+RECT
[void][BubbleProbe3]::GetWindowRect($win, [ref]$rect)
"window hwnd=$win rect=($($rect.Left),$($rect.Top))-($($rect.Right),$($rect.Bottom))"

# Click the page body once first, so any first-run sheet loses focus before the selection is made.
[void][BubbleProbe3]::SetCursorPos($x0, $y)
Start-Sleep -Milliseconds 250
[BubbleProbe3]::mouse_event([BubbleProbe3]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
[BubbleProbe3]::mouse_event([BubbleProbe3]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 700

# Drag-select a run of text.
$y = $rect.Top + 140
$x0 = $rect.Left + 80
[void][BubbleProbe3]::SetCursorPos($x0, $y)
Start-Sleep -Milliseconds 250
[BubbleProbe3]::mouse_event([BubbleProbe3]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 120
for ($dx = 12; $dx -le 380; $dx += 24) {
  [void][BubbleProbe3]::SetCursorPos($x0 + $dx, $y)
  Start-Sleep -Milliseconds 25
}
[BubbleProbe3]::mouse_event([BubbleProbe3]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
"dragged: $x0,$y -> $($x0+380),$y"

# Built from code points so the check cannot be broken by source-file encoding.
$barTitle = 'DSH Bubble ' + [char]0x5212 + [char]0x8BCD

$bar = [IntPtr]::Zero
$visibleAfterSelect = $false
for ($i = 0; $i -lt 24; $i++) {
  Start-Sleep -Milliseconds 150
  if ($bar -eq [IntPtr]::Zero) { $bar = [BubbleProbe3]::FindByTitle($ball.Id, $barTitle) }
  if ($bar -ne [IntPtr]::Zero -and [BubbleProbe3]::IsWindowVisible($bar)) { $visibleAfterSelect = $true; break }
}
"[1] toolbar visible after selecting = $visibleAfterSelect (hwnd=$bar)"
$fgAfter = [BubbleProbe3]::GetForegroundWindow()
"    foreground after showing = $([BubbleProbe3]::Describe($fgAfter))"
"    focusStolenByUs = $($fgAfter -ne $win -and $fgAfter -eq $bar)"

# The user-visible regression: the toolbar used to retire itself a moment after appearing.
$survives = $true
for ($i = 0; $i -lt 27; $i++) {
  Start-Sleep -Milliseconds 150
  if (-not [BubbleProbe3]::IsWindowVisible($bar)) { $survives = $false; break }
}
"[1b] toolbar still visible after 4s idle = $survives"

# A Right arrow collapses the selection without any mouse activity.
$fgBeforeKey = [BubbleProbe3]::GetForegroundWindow()
"    foreground before key = $([BubbleProbe3]::Describe($fgBeforeKey))  keyGoesToTarget=$($fgBeforeKey -eq $win)"
[BubbleProbe3]::keybd_event(0x27, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 50
[BubbleProbe3]::keybd_event(0x27, 0, 2, [IntPtr]::Zero)
$hiddenAfterCollapse = $false
for ($i = 0; $i -lt 24; $i++) {
  Start-Sleep -Milliseconds 150
  if ($bar -ne [IntPtr]::Zero -and -not [BubbleProbe3]::IsWindowVisible($bar)) { $hiddenAfterCollapse = $true; break }
}
"[2] toolbar hidden after collapsing = $hiddenAfterCollapse"

[void][BubbleProbe3]::SetCursorPos($before.X, $before.Y)
Get-Process -Id $proc.Id -ErrorAction SilentlyContinue | Stop-Process -Force
if ($Target -eq 'edge') { Remove-Item "$env:TEMP\bubble-probe-edge" -Recurse -Force -ErrorAction SilentlyContinue }
"cursor restored to ($($before.X),$($before.Y))"
