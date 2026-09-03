/**
 * The Windows side of computer use, as one PowerShell script.
 *
 * Everything that needs the Win32 API lives here rather than in a native module, so
 * the app still ships with nothing to compile and nothing to rebuild per Electron
 * version. The script is written to a temporary file once per app run and invoked
 * with -File; it reads one JSON request on stdin and prints one JSON reply, so the
 * TypeScript side never builds a command line out of model-supplied text.
 *
 * Input is synthesised with SendInput, not the older mouse_event/SendKeys pair:
 * SendInput is what Windows itself treats as real input, it batches atomically, and
 * KEYEVENTF_UNICODE lets `type` send any character rather than only what a US
 * keyboard layout can reach.
 */

export const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Without this the reply is written in the console codepage, and any window title
# with a non-ASCII character comes back as mojibake.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# And the same in the other direction, which was missing. Requests are written to this
# process's stdin as UTF-8, but [Console]::In decodes them through the legacy OEM input
# codepage, so every non-ASCII character in a request was corrupted before ConvertFrom-Json
# ever saw it: an em dash (E2 80 94) arrived as three CP437 characters and was then typed
# into the target window exactly as mangled. That hits every textual argument the helper
# takes — type, set_value, UIA queries — not only keystrokes.
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;

public static class Clf {
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public INPUTUNION u; }

  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
  const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
  const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
  const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetWindowTextW(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint flags);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

  public struct POINT { public int X, Y; }
  public struct RECT { public int Left, Top, Right, Bottom; }
  delegate bool EnumProc(IntPtr h, IntPtr lp);

  static int VX { get { return GetSystemMetrics(76); } }
  static int VY { get { return GetSystemMetrics(77); } }
  static int VW { get { return GetSystemMetrics(78); } }
  static int VH { get { return GetSystemMetrics(79); } }

  static void Send(INPUT[] inputs) {
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) throw new Exception("SendInput was blocked (sent " + sent + " of " + inputs.Length + "). A window running as administrator can refuse synthetic input.");
  }

  static INPUT Mouse(uint flags, int dx, int dy, uint data) {
    INPUT i = new INPUT();
    i.type = INPUT_MOUSE;
    i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data;
    i.u.mi.dwFlags = flags;
    return i;
  }

  // SendInput takes absolute coordinates normalised to 0..65535 across the whole
  // virtual desktop, not pixels, so every monitor layout works with one formula.
  public static void Move(int x, int y) {
    int nx = (int)(((double)(x - VX) * 65535.0) / Math.Max(1, VW - 1));
    int ny = (int)(((double)(y - VY) * 65535.0) / Math.Max(1, VH - 1));
    Send(new INPUT[] { Mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny, 0) });
  }

  static void ButtonFlags(string button, out uint down, out uint up) {
    switch (button) {
      case "right": down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; break;
      case "middle": case "wheel": down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; break;
      default: down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; break;
    }
  }

  public static void Click(int x, int y, string button, int times) {
    Move(x, y);
    uint down, up;
    ButtonFlags(button, out down, out up);
    List<INPUT> batch = new List<INPUT>();
    for (int n = 0; n < times; n++) {
      batch.Add(Mouse(down, 0, 0, 0));
      batch.Add(Mouse(up, 0, 0, 0));
    }
    Send(batch.ToArray());
  }

  public static void Scroll(int x, int y, int dx, int dy) {
    Move(x, y);
    List<INPUT> batch = new List<INPUT>();
    // Positive scroll_y means "scroll down" for the caller; the wheel API is the
    // other way round, hence the negation.
    if (dy != 0) batch.Add(Mouse(MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)(-dy * 120))));
    if (dx != 0) batch.Add(Mouse(MOUSEEVENTF_HWHEEL, 0, 0, unchecked((uint)(dx * 120))));
    if (batch.Count > 0) Send(batch.ToArray());
  }

  public static void Drag(int[] xs, int[] ys, string button) {
    uint down, up;
    ButtonFlags(button, out down, out up);
    Move(xs[0], ys[0]);
    Send(new INPUT[] { Mouse(down, 0, 0, 0) });
    for (int i = 1; i < xs.Length; i++) { Move(xs[i], ys[i]); System.Threading.Thread.Sleep(12); }
    Send(new INPUT[] { Mouse(up, 0, 0, 0) });
  }

  static INPUT Key(ushort vk, bool up) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wVk = vk;
    i.u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
    return i;
  }

  static INPUT Unicode(char c, bool up) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wVk = 0;
    i.u.ki.wScan = c;
    i.u.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
    return i;
  }

  /** Types literal text, layout-independently. */
  public static void Type(string text) {
    List<INPUT> batch = new List<INPUT>();
    foreach (char c in text) {
      if (c == '\n') { batch.Add(Key(0x0D, false)); batch.Add(Key(0x0D, true)); continue; }
      if (c == '\r') continue;
      batch.Add(Unicode(c, false));
      batch.Add(Unicode(c, true));
      // SendInput caps out on very long batches; flush in chunks.
      if (batch.Count >= 200) { Send(batch.ToArray()); batch.Clear(); }
    }
    if (batch.Count > 0) Send(batch.ToArray());
  }

  /**
   * Presses keys together, holds the chord briefly, then releases in reverse.
   * Sending down+up for an entire chord as one zero-delay batch is accepted by
   * SendInput but some Windows apps miss system shortcuts such as ALT+F4. Keeping
   * the modifiers physically down for a few milliseconds makes the sequence match
   * a real keyboard much more closely without making ordinary shortcuts feel slow.
   */
  public static void Press(ushort[] vks) {
    List<INPUT> down = new List<INPUT>();
    List<INPUT> up = new List<INPUT>();
    for (int i = 0; i < vks.Length; i++) down.Add(Key(vks[i], false));
    for (int i = vks.Length - 1; i >= 0; i--) up.Add(Key(vks[i], true));
    Send(down.ToArray());
    System.Threading.Thread.Sleep(35);
    Send(up.ToArray());
  }

  public static string Cursor() {
    POINT p; GetCursorPos(out p);
    return p.X + "," + p.Y;
  }

  /** Virtual desktop rect, then the primary monitor's size. */
  public static string Screen() {
    return VX + "," + VY + "," + VW + "," + VH + "," + GetSystemMetrics(0) + "," + GetSystemMetrics(1);
  }

  public static string Rect(long handle) {
    RECT r;
    if (!GetWindowRect(new IntPtr(handle), out r)) throw new Exception("No window with that id is open.");
    return r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top);
  }

  public static string Window(long handle) {
    IntPtr h = new IntPtr(handle);
    if (!IsWindow(h) || !IsWindowVisible(h)) return "";
    int len = GetWindowTextLengthW(h);
    if (len == 0 || (GetWindowLong(h, -20) & 0x00000080) != 0) return "";
    StringBuilder sb = new StringBuilder(len + 1);
    GetWindowTextW(h, sb, sb.Capacity);
    RECT r;
    if (!GetWindowRect(h, out r) || r.Right - r.Left <= 0 || r.Bottom - r.Top <= 0) return "";
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    string proc = "";
    try { proc = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { }
    return string.Join(((char)31).ToString(), new string[] {
      h.ToInt64().ToString(), sb.ToString(), proc,
      r.Left.ToString(), r.Top.ToString(), (r.Right - r.Left).ToString(), (r.Bottom - r.Top).ToString(),
      IsIconic(h) ? "minimized" : (h == GetForegroundWindow() ? "foreground" : "open")
    });
  }

  public static List<string> Windows() {
    List<string> found = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr lp) {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLengthW(h);
      if (len == 0) return true;
      // WS_EX_TOOLWINDOW: palettes and other chrome the user never thinks of as
      // a window, which would otherwise bury the real ones.
      if ((GetWindowLong(h, -20) & 0x00000080) != 0) return true;
      StringBuilder sb = new StringBuilder(len + 1);
      GetWindowTextW(h, sb, sb.Capacity);
      RECT r; GetWindowRect(h, out r);
      if (r.Right - r.Left <= 0 || r.Bottom - r.Top <= 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      string proc = "";
      try { proc = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { }
      found.Add(string.Join(((char)31).ToString(), new string[] {
        h.ToInt64().ToString(), sb.ToString(), proc,
        r.Left.ToString(), r.Top.ToString(), (r.Right - r.Left).ToString(), (r.Bottom - r.Top).ToString(),
        IsIconic(h) ? "minimized" : (h == GetForegroundWindow() ? "foreground" : "open")
      }));
      return true;
    }, IntPtr.Zero);
    return found;
  }

  /**
   * Windows refuses SetForegroundWindow to a process that does not own the current
   * foreground window. Briefly attaching to that window's input thread is the
   * long-standing way to be allowed to do it.
   */
  public static bool Focus(long handle) {
    IntPtr h = new IntPtr(handle);
    if (!IsWindow(h)) return false;
    if (GetForegroundWindow() == h) return true;
    if (IsIconic(h)) ShowWindow(h, 9);
    uint dummy;
    uint target = GetWindowThreadProcessId(h, out dummy);
    uint fore = GetWindowThreadProcessId(GetForegroundWindow(), out dummy);
    uint self = GetCurrentThreadId();
    if (fore != self) AttachThreadInput(fore, self, true);
    bool ok = SetForegroundWindow(h);
    if (fore != self) AttachThreadInput(fore, self, false);
    return ok;
  }

  public static long ForegroundId() {
    return GetForegroundWindow().ToInt64();
  }

  /**
   * Grabs a screen region and saves it as a PNG no wider than maxW.
   *
   * The scaling happens here rather than after the fact because a 4K PNG is slow to
   * write, slow to read back and slow to base64, and nothing downstream ever wants
   * one. Returns the size actually written.
   */
  static string SavePng(Bitmap shot, int maxW, string file) {
    int w = shot.Width, h = shot.Height;
    int outW = w, outH = h;
    if (maxW > 0 && w > maxW) {
      outW = maxW;
      outH = (int)Math.Round((double)h * maxW / w);
      if (outH < 1) outH = 1;
    }
    if (outW == w && outH == h) {
      shot.Save(file, System.Drawing.Imaging.ImageFormat.Png);
    } else {
      using (Bitmap small = new Bitmap(outW, outH))
      using (Graphics gs = Graphics.FromImage(small)) {
        gs.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
        gs.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
        gs.DrawImage(shot, new Rectangle(0, 0, outW, outH));
        small.Save(file, System.Drawing.Imaging.ImageFormat.Png);
      }
    }
    return outW + "," + outH;
  }

  public static string Capture(int x, int y, int w, int h, int maxW, string file) {
    using (Bitmap shot = new Bitmap(w, h))
    using (Graphics g = Graphics.FromImage(shot)) {
      g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
      return SavePng(shot, maxW, file);
    }
  }

  /** Captures a classic top-level window without changing the foreground. */
  public static string CaptureWindow(long handle, int maxW, string file) {
    IntPtr h = new IntPtr(handle);
    RECT r;
    if (!IsWindow(h) || IsIconic(h) || !GetWindowRect(h, out r)) return "";
    int w = r.Right - r.Left, height = r.Bottom - r.Top;
    if (w <= 0 || height <= 0) return "";
    using (Bitmap shot = new Bitmap(w, height))
    using (Graphics g = Graphics.FromImage(shot)) {
      IntPtr dc = g.GetHdc();
      bool ok;
      try { ok = PrintWindow(h, dc, 2); }
      finally { g.ReleaseHdc(dc); }
      if (!ok) return "";
      return SavePng(shot, maxW, file);
    }
  }
}
'@ -ReferencedAssemblies System.Drawing

# Requests arrive as one JSON object per stdin line. The process stays alive, so the
# expensive Add-Type/C# compilation above happens once instead of on every MCP call.
# Model-supplied text is data parsed by ConvertFrom-Json and is never evaluated as
# PowerShell source.

function Vk([string]$name) {
  $n = $name.ToUpperInvariant()
  $map = @{
    'CTRL'=0x11; 'CONTROL'=0x11; 'ALT'=0x12; 'SHIFT'=0x10; 'WIN'=0x5B; 'SUPER'=0x5B; 'CMD'=0x5B;
    'ENTER'=0x0D; 'RETURN'=0x0D; 'TAB'=0x09; 'ESC'=0x1B; 'ESCAPE'=0x1B; 'SPACE'=0x20;
    'BACKSPACE'=0x08; 'DELETE'=0x2E; 'DEL'=0x2E; 'INSERT'=0x2D; 'HOME'=0x24; 'END'=0x23;
    'PAGEUP'=0x21; 'PAGEDOWN'=0x22; 'UP'=0x26; 'DOWN'=0x28; 'LEFT'=0x25; 'RIGHT'=0x27;
    'F1'=0x70;'F2'=0x71;'F3'=0x72;'F4'=0x73;'F5'=0x74;'F6'=0x75;
    'F7'=0x76;'F8'=0x77;'F9'=0x78;'F10'=0x79;'F11'=0x7A;'F12'=0x7B;
    'PRINTSCREEN'=0x2C; 'CAPSLOCK'=0x14;
    'PGUP'=0x21; 'PGDN'=0x22; 'ARROWUP'=0x26; 'ARROWDOWN'=0x28; 'ARROWLEFT'=0x25; 'ARROWRIGHT'=0x27;
    'META'=0x5B; 'COMMAND'=0x5B; 'OPTION'=0x12; 'INS'=0x2D; 'BKSP'=0x08; 'PAUSE'=0x13;
    'NUMLOCK'=0x90; 'SCROLLLOCK'=0x91; 'MENU'=0x5D; 'APPS'=0x5D;
    'F13'=0x7C;'F14'=0x7D;'F15'=0x7E;'F16'=0x7F;'F17'=0x80;'F18'=0x81;
    'F19'=0x82;'F20'=0x83;'F21'=0x84;'F22'=0x85;'F23'=0x86;'F24'=0x87;
    'MINUS'=0xBD; '-'=0xBD; 'EQUALS'=0xBB; 'EQUAL'=0xBB; '='=0xBB; 'PLUS'=0xBB;
    'LBRACKET'=0xDB; 'BRACKETLEFT'=0xDB; '['=0xDB; 'RBRACKET'=0xDD; 'BRACKETRIGHT'=0xDD; ']'=0xDD;
    'BACKSLASH'=0xDC; '\'=0xDC; 'SEMICOLON'=0xBA; ';'=0xBA; 'QUOTE'=0xDE; 'APOSTROPHE'=0xDE; "'"=0xDE;
    'COMMA'=0xBC; ','=0xBC; 'PERIOD'=0xBE; '.'=0xBE; 'SLASH'=0xBF; '/'=0xBF;
    'BACKQUOTE'=0xC0; 'GRAVE'=0xC0; 'TILDE'=0xC0; '~'=0xC0
  }
  # The backtick cannot be spelled inside this script's own quoting, so it joins the map by code.
  $map[[string][char]96] = 0xC0
  if ($map.ContainsKey($n)) { return [uint16]$map[$n] }
  if ($n.Length -eq 1) {
    $c = [char]$n
    if (($c -ge 'A' -and $c -le 'Z') -or ($c -ge '0' -and $c -le '9')) { return [uint16][int][char]$c }
  }
  throw "BAD_KEY: Unknown key: $name. Use one character, or a key name: enter, tab, esc, space, backspace, delete, insert, home, end, pageup, pagedown, up, down, left, right, f1-f24, printscreen, or a modifier ctrl, alt, shift, win."
}

function Get-WindowRows {
  $rows = @()
  foreach ($line in [Clf]::Windows()) {
    $f = $line -split ([char]31)
    $rows += @{
      id = [int64]$f[0]; title = $f[1]; process = $f[2]
      x = [int]$f[3]; y = [int]$f[4]; width = [int]$f[5]; height = [int]$f[6]; state = $f[7]
    }
  }
  return $rows
}

function Convert-WindowRow([string]$line) {
  if ([string]::IsNullOrEmpty($line)) { return $null }
  $f = $line -split ([char]31)
  return @{
    id = [int64]$f[0]; title = $f[1]; process = $f[2]
    x = [int]$f[3]; y = [int]$f[4]; width = [int]$f[5]; height = [int]$f[6]; state = $f[7]
  }
}

function Get-WindowRow([int64]$id) {
  return Convert-WindowRow ([Clf]::Window($id))
}

function Get-ScreenRect {
  $s = [Clf]::Screen() -split ','
  return @{
    virtual = @{ x = [int]$s[0]; y = [int]$s[1]; width = [int]$s[2]; height = [int]$s[3] }
    primary = @{ x = 0; y = 0; width = [int]$s[4]; height = [int]$s[5] }
  }
}

function Try-Focus([int64]$id) {
  if ([Clf]::ForegroundId() -eq $id) { return $true }
  if (-not [Clf]::Focus($id)) { return $false }
  # Activation is asynchronous for some windows. Confirm the actual foreground state and
  # stop as soon as it lands instead of charging every call one fixed 120 ms sleep.
  $timer = [Diagnostics.Stopwatch]::StartNew()
  do {
    if ([Clf]::ForegroundId() -eq $id) { return $true }
    Start-Sleep -Milliseconds 10
  } while ($timer.ElapsedMilliseconds -lt 250)
  return $false
}

function Assert-Focused([int64]$id) {
  if (-not (Try-Focus $id)) {
    $foreground = [Clf]::ForegroundId()
    throw "FOCUS_FAILED: requested $id but foreground is $foreground after asking Windows to activate it. Another window is holding focus; click it away or retry."
  }
}

function Ui-RuntimeKey($element) {
  try { return (@($element.GetRuntimeId()) -join '.') } catch { return '' }
}

$script:UiSnapshots = [ordered]@{}
$script:NextUiSnapshotId = 1
# One helper serves every chat, so this cap is shared across a whole swarm: with sixteen,
# thirteen workers taking turns evicted each other's newest snapshot before its owner could
# act on a ref from it (forty STALE_UI_SNAPSHOT refusals on 2026-09-01). A snapshot holds
# element handles, not screenshots, so keeping a few per worker is cheap.
$script:MaxUiSnapshots = 96

function Remember-UiSnapshot([int64]$id, $root, $elements) {
  $snapshotId = $script:NextUiSnapshotId
  $script:NextUiSnapshotId += 1
  $byRuntimeKey = @{}
  foreach ($element in $elements) {
    $key = Ui-RuntimeKey $element
    if ($key -and -not $byRuntimeKey.ContainsKey($key)) { $byRuntimeKey[$key] = $element }
  }
  $snapshotKey = "s$snapshotId"
  $script:UiSnapshots[$snapshotKey] = @{
    window = $id
    rootRuntimeKey = (Ui-RuntimeKey $root)
    elements = $byRuntimeKey
  }
  while ($script:UiSnapshots.Count -gt $script:MaxUiSnapshots) {
    $oldest = @($script:UiSnapshots.Keys)[0]
    $script:UiSnapshots.Remove($oldest)
  }
  return $snapshotId
}

function Resolve-UiElement([int64]$id, [int]$snapshotId, [string]$runtimeKey) {
  $snapshot = $script:UiSnapshots["s$snapshotId"]
  if ($null -eq $snapshot -or [int64]$snapshot.window -ne $id) {
    throw "STALE_UI_SNAPSHOT: UI snapshot $snapshotId is no longer active for window $id. Call observe on the window again and use a ref from that reply."
  }
  $element = $snapshot.elements[$runtimeKey]
  if ($null -eq $element) {
    throw "UI_ELEMENT_GONE: the referenced UI element is not part of snapshot $snapshotId. Use a ref printed by that snapshot, or observe the window again."
  }
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$id)
  } catch {
    throw "UIA_FAILED: no accessible window with id $id"
  }
  if ($null -eq $root) { throw "UIA_FAILED: no accessible window with id $id" }
  try {
    if ((Ui-RuntimeKey $root) -ne [string]$snapshot.rootRuntimeKey) {
      throw "STALE_UI_SNAPSHOT: window $id no longer has the UIA root from snapshot $snapshotId. Call observe on the window again and use a ref from that reply."
    }
    # Reading Current is the liveness check. The element object itself is the cached handle;
    # never rescan by RuntimeId, because Microsoft permits RuntimeId reuse over time.
    $null = $element.Current.IsEnabled
    if ((Ui-RuntimeKey $element) -ne $runtimeKey) {
      throw "STALE_UI_REF: the cached element identity changed"
    }
    return $element
  } catch {
    $message = $_.Exception.Message
    if ($message -match '^[A-Z0-9_]+:') { throw $message }
    throw "UI_ELEMENT_GONE: the referenced UI element is no longer present. Call observe on the window again and use a ref from that reply."
  }
}

function Act-UiElement($request) {
  $id = [int64]$request.id
  $element = Resolve-UiElement $id ([int]$request.snapshotId) ([string]$request.runtimeKey)
  if (-not $element.Current.IsEnabled) { throw "UI_ELEMENT_DISABLED: the referenced element is disabled" }
  $action = [string]$request.action
  if ($action -eq 'set_value') {
    $pattern = $null
    if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
      throw "UI_VALUE_UNSUPPORTED: the referenced element does not expose ValuePattern"
    }
    $value = [System.Windows.Automation.ValuePattern]$pattern
    if ($value.Current.IsReadOnly) { throw "UI_VALUE_READONLY: the referenced element is read-only" }
    $value.SetValue([string]$request.value)
    $route = 'uia'
  } elseif ($action -eq 'click') {
    $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
      ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
      $route = 'uia'
    } else {
      # A semantic control without InvokePattern has to fall back to physical input. Make
      # that last resort explicit and safe: the referenced window, not an overlay at the
      # same desktop coordinates, must be foreground before the pointer goes down.
      Assert-Focused $id
      $r = $element.Current.BoundingRectangle
      if ($r.Width -le 0 -or $r.Height -le 0) { throw "UI_ELEMENT_OFFSCREEN: the referenced element has no clickable bounds" }
      [Clf]::Click([int][Math]::Round($r.X + $r.Width / 2), [int][Math]::Round($r.Y + $r.Height / 2), 'left', 1)
      $route = 'sendinput'
    }
  } else {
    throw "BAD_ACTION: unsupported UI element action $action"
  }
  return @{ runtimeKey = (Ui-RuntimeKey $element); name = [string]$element.Current.Name; route = $route }
}

function Find-UiElements($request) {
  $id = if ($request.id) { [int64]$request.id } else { [Clf]::ForegroundId() }
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$id)
  } catch {
    throw "UIA_FAILED: no accessible window with id $id"
  }
  if ($null -eq $root) { throw "UIA_FAILED: no accessible window with id $id" }

  $query = ([string]$request.query).Trim().ToLowerInvariant()
  $role = ([string]$request.role).Trim().ToLowerInvariant()
  $limit = if ($request.maxResults) { [Math]::Min(100, [Math]::Max(1, [int]$request.maxResults)) } else { 30 }
  $visitLimit = if ($request.maxVisited) { [Math]::Min(10000, [Math]::Max($limit, [int]$request.maxVisited)) } else { 3000 }
  $found = @()
  $handles = New-Object 'System.Collections.Generic.List[object]'
  $visited = 0
  try {
    # ControlView avoids the enormous raw Chromium implementation tree. TreeWalker lets the
    # limit bound traversal work as well as output; FindAll(Descendants) materialised the full
    # tree before maxResults could stop it. CacheRequest fetches the projection properties in
    # bulk rather than paying one cross-process provider call for every Current field.
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $cache = New-Object System.Windows.Automation.CacheRequest
    $cache.TreeScope = [System.Windows.Automation.TreeScope]::Element
    $cache.Add([System.Windows.Automation.AutomationElement]::NameProperty)
    $cache.Add([System.Windows.Automation.AutomationElement]::AutomationIdProperty)
    $cache.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
    $cache.Add([System.Windows.Automation.AutomationElement]::IsEnabledProperty)
    $cache.Add([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)
    $cache.Add([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
    $stack = New-Object System.Collections.Stack
    $element = $walker.GetFirstChild($root, $cache)
    while ($null -ne $element -and $found.Count -lt $limit -and $visited -lt $visitLimit) {
      $visited += 1
      try {
        $current = $element.Cached
        $name = [string]$current.Name
        $automationId = [string]$current.AutomationId
        $control = [string]$current.ControlType.ProgrammaticName
        if ($control.StartsWith('ControlType.')) { $control = $control.Substring(12) }
        $matches = (-not $query -or $name.ToLowerInvariant().Contains($query) -or $automationId.ToLowerInvariant().Contains($query))
        $matches = $matches -and (-not $role -or $control.ToLowerInvariant().Contains($role))
        if ($matches) {
          $r = $current.BoundingRectangle
          if ($r.Width -gt 0 -and $r.Height -gt 0) {
            $found += @{
              runtimeKey = (Ui-RuntimeKey $element)
              name = $name
              role = $control
              automationId = $automationId
              enabled = [bool]$current.IsEnabled
              offscreen = [bool]$current.IsOffscreen
              bounds = @{
                x = [int][Math]::Round($r.X); y = [int][Math]::Round($r.Y)
                width = [int][Math]::Round($r.Width); height = [int][Math]::Round($r.Height)
              }
            }
            $handles.Add($element)
          }
        }
      } catch { }

      $sibling = $null
      try { $sibling = $walker.GetNextSibling($element, $cache) } catch { }
      if ($null -ne $sibling) { $stack.Push($sibling) }
      $child = $null
      try { $child = $walker.GetFirstChild($element, $cache) } catch { }
      if ($null -ne $child) {
        $element = $child
      } elseif ($stack.Count -gt 0) {
        $element = $stack.Pop()
      } else {
        $element = $null
      }
    }
  } catch {
    throw "UIA_FAILED: $($_.Exception.Message)"
  }
  $snapshotId = Remember-UiSnapshot $id $root $handles
  return @{
    window = $id
    snapshotId = $snapshotId
    elements = @($found)
    visited = $visited
    truncated = ($visited -ge $visitLimit -and $found.Count -lt $limit)
  }
}

function Capture-Target($request, [Nullable[int64]]$forcedWindow) {
  $screen = Get-ScreenRect
  $id = if ($null -ne $forcedWindow) { [int64]$forcedWindow } elseif ($request.id) { [int64]$request.id } else { $null }
  $mode = 'screen'
  $focused = $null
  if ($request.region) {
    $x = [int]$request.region.x; $y = [int]$request.region.y
    $w = [int]$request.region.width; $h = [int]$request.region.height
  } elseif ($null -ne $id) {
    try { $r = [Clf]::Rect([int64]$id) -split ',' } catch {
      throw "WINDOW_NOT_FOUND: window $id is no longer open, so there is nothing to capture. Call observe what=windows for the current windows."
    }
    $x = [int]$r[0]; $y = [int]$r[1]; $w = [int]$r[2]; $h = [int]$r[3]
    $focused = ([Clf]::ForegroundId() -eq [int64]$id)
  } elseif ($request.full) {
    $x = [int]$screen.virtual.x; $y = [int]$screen.virtual.y
    $w = [int]$screen.virtual.width; $h = [int]$screen.virtual.height
  } else {
    $x = 0; $y = 0; $w = [int]$screen.primary.width; $h = [int]$screen.primary.height
  }
  if ($w -le 0 -or $h -le 0) { throw "CAPTURE_FAILED: target has no drawable area" }
  $maxW = if ($request.maxWidth) { [int]$request.maxWidth } else { 0 }
  $out = $null
  # PrintWindow is background-first and leaves the foreground alone. Providers that reject
  # it fall back to truthful screen pixels, explicitly marked as potentially occluded.
  if ($null -ne $id -and $request.file) {
    $direct = [Clf]::CaptureWindow([int64]$id, $maxW, [string]$request.file)
    if ($direct) {
      $out = $direct -split ','
      $mode = 'window'
    } else {
      $mode = 'screen_fallback'
    }
  }
  if ($null -eq $out) {
    $out = [Clf]::Capture($x, $y, $w, $h, $maxW, [string]$request.file) -split ','
  }
  return @{
    region = @{ x = $x; y = $y; width = $w; height = $h }
    image = @{ width = [int]$out[0]; height = [int]$out[1] }
    screen = $screen.virtual
    focused = $focused
    captureMode = $mode
  }
}

function Assert-CoordinateFrame($frame) {
  $region = $frame.region
  if ($frame.window) {
    $id = [int64]$frame.window
    $geometry = if ($frame.windowGeometry) { $frame.windowGeometry } else { $region }
    $row = Get-WindowRow $id
    if ($null -eq $row -or $row.state -eq 'minimized') {
      throw "STALE_FRAME: target window $id is no longer drawable"
    }
    if ($row.x -ne [int]$geometry.x -or $row.y -ne [int]$geometry.y -or $row.width -ne [int]$geometry.width -or $row.height -ne [int]$geometry.height) {
      throw "STALE_FRAME: target window $id moved or resized after frame $($frame.id)"
    }
    # A background snapshot is safe to observe, but physical coordinates must land on that
    # exact window rather than on an overlay. Focus only here, on the mutating path.
    Assert-Focused $id
    $after = Get-WindowRow $id
    if ($null -eq $after -or $after.x -ne [int]$geometry.x -or $after.y -ne [int]$geometry.y -or $after.width -ne [int]$geometry.width -or $after.height -ne [int]$geometry.height) {
      throw "STALE_FRAME: target window $id changed geometry while it was activated"
    }
    return
  }
  $screen = Get-ScreenRect
  $right = [int]$region.x + [int]$region.width
  $bottom = [int]$region.y + [int]$region.height
  if ([int]$region.x -lt [int]$screen.virtual.x -or [int]$region.y -lt [int]$screen.virtual.y -or
      $right -gt ([int]$screen.virtual.x + [int]$screen.virtual.width) -or
      $bottom -gt ([int]$screen.virtual.y + [int]$screen.virtual.height)) {
    throw "STALE_FRAME: desktop geometry changed after frame $($frame.id)"
  }
}

function Handle-Request($request) {
  $result = @{ ok = $true }
  switch ($request.op) {
    'warm' {
      # Touch both Win32 and UIA without reading pixels or changing focus. Connector startup
      # can pay Add-Type and provider initialization before the first model-facing action.
      $null = [Clf]::ForegroundId()
      $null = [System.Windows.Automation.AutomationElement]::RootElement.Current.ProcessId
      $result.ready = $true
    }
    'cursor' {
      $cursor = [Clf]::Cursor() -split ','
      $result.cursor = @{ x = [int]$cursor[0]; y = [int]$cursor[1] }
      $result.foreground = [Clf]::ForegroundId()
    }
    'windows' {
      $screen = Get-ScreenRect
      $result.windows = @(Get-WindowRows)
      $result.screen = $screen.virtual
    }
    'active' {
      $screen = Get-ScreenRect
      $foreground = [Clf]::ForegroundId()
      $result.window = Get-WindowRow $foreground
      $result.screen = $screen.virtual
    }
    'find_ui' {
      $ui = Find-UiElements $request
      $result.window = $ui.window
      $result.snapshotId = $ui.snapshotId
      $result.elements = @($ui.elements)
      $result.visited = $ui.visited
      $result.truncated = $ui.truncated
    }
    'act_ui' {
      $ui = Act-UiElement $request
      $result.runtimeKey = $ui.runtimeKey
      $result.name = $ui.name
      $result.route = $ui.route
    }
    'capture' {
      $capture = Capture-Target $request $null
      foreach ($key in $capture.Keys) { $result[$key] = $capture[$key] }
    }
    'snapshot' {
      $id = if ($request.id) { [int64]$request.id } else { [Clf]::ForegroundId() }
      $window = Get-WindowRow $id
      if ($null -eq $window) { throw "WINDOW_NOT_FOUND: no matching visible window is available" }
      $result.window = $window
      if ($request.includeScreenshot) {
        $capture = Capture-Target $request ([Nullable[int64]]$id)
        foreach ($key in $capture.Keys) { $result[$key] = $capture[$key] }
      }
      if ($request.includeUi) {
        $uiRequest = @{
          id = $id
          query = if ($request.query) { $request.query } else { '' }
          role = if ($request.role) { $request.role } else { '' }
          maxResults = $request.maxResults
          maxVisited = $request.maxVisited
        }
        $ui = Find-UiElements $uiRequest
        $result.snapshotId = $ui.snapshotId
        $result.elements = @($ui.elements)
        $result.visited = $ui.visited
        $result.truncated = $ui.truncated
      }
    }
    'focus' {
      $id = [int64]$request.id
      $result.focused = (Try-Focus $id)
      $result.foreground = [Clf]::ForegroundId()
    }
    'act' {
      $pointing = @($request.actions | Where-Object { $_.type -in @('move','click','double_click','scroll','drag') })
      if ($pointing.Count -gt 0 -and $request.frame) { Assert-CoordinateFrame $request.frame }
      $routes = @()
      $completed = 0
      for ($index = 0; $index -lt $request.actions.Count; $index++) {
        $a = $request.actions[$index]
        try {
          switch ($a.type) {
            'click_ui' {
              $ui = Act-UiElement @{ id = $a.window; snapshotId = $a.snapshotId; runtimeKey = $a.runtimeKey; action = 'click' }
              $routes += $ui.route
            }
            'set_value_ui' {
              $ui = Act-UiElement @{ id = $a.window; snapshotId = $a.snapshotId; runtimeKey = $a.runtimeKey; action = 'set_value'; value = $a.value }
              $routes += $ui.route
            }
            'move'         { [Clf]::Move([int]$a.x, [int]$a.y); $routes += 'sendinput' }
            'click'        { [Clf]::Click([int]$a.x, [int]$a.y, $a.button, 1); $routes += 'sendinput' }
            'double_click' { [Clf]::Click([int]$a.x, [int]$a.y, $a.button, 2); $routes += 'sendinput' }
            'scroll'       { [Clf]::Scroll([int]$a.x, [int]$a.y, [int]$a.scroll_x, [int]$a.scroll_y); $routes += 'sendinput' }
            'drag'         { [Clf]::Drag([int[]]$a.xs, [int[]]$a.ys, $a.button); $routes += 'sendinput' }
            'type'         { [Clf]::Type([string]$a.text); $routes += 'sendinput' }
            'keypress'     { [Clf]::Press([uint16[]]@($a.keys | ForEach-Object { Vk $_ })); $routes += 'sendinput' }
            'focus'        { Assert-Focused ([int64]$a.window); $routes += 'focus' }
            default        { throw "BAD_ACTION: Unknown action: $($a.type)" }
          }
          $completed += 1
        } catch {
          $message = $_.Exception.Message
          $code = 'HELPER_ERROR'
          if ($message -match '^([A-Z0-9_]+):\s*(.+)') {
            $code = $Matches[1]
            $message = $Matches[2]
          }
          return @{
            ok = $false
            error_code = $code
            message = $message
            completed_count = $completed
            failed_index = $index
            routes = @($routes)
          }
        }
      }
      $cursor = [Clf]::Cursor() -split ','
      $result.cursor = @{ x = [int]$cursor[0]; y = [int]$cursor[1] }
      $result.foreground = [Clf]::ForegroundId()
      $result.completed_count = $completed
      $result.routes = @($routes)
    }
    default { throw "BAD_REQUEST: Unknown op: $($request.op)" }
  }
  return $result
}

while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  try {
    $request = $line | ConvertFrom-Json
    $reply = Handle-Request $request
  } catch {
    $message = $_.Exception.Message
    $code = 'HELPER_ERROR'
    if ($message -match '^([A-Z0-9_]+):\s*(.+)') {
      $code = $Matches[1]
      $message = $Matches[2]
    }
    $reply = @{ ok = $false; error_code = $code; message = $message }
  }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Depth 8 -Compress))
  [Console]::Out.Flush()
}
`;
