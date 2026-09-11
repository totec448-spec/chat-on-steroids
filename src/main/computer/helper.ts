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

import { WINDOWS_CAPTURE_BOOTSTRAP } from './windows-capture.js';
import { WINDOWS_APP_IDENTITY_SOURCE, WINDOWS_APPS_SCRIPT } from './windows-apps.js';
import { WINDOWS_KEYS_SOURCE } from './windows-keys.js';
import { BROWSER_PROCESS_PATTERN } from './browser-chords.js';

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
  // Nonzero when the user has swapped the primary and secondary mouse buttons. See ButtonFlags.
  const int SM_SWAPBUTTON = 23;
  const uint KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

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
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr window, StringBuilder value, int count);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);

  public struct POINT { public int X, Y; }
  public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  struct GUITHREADINFO {
    public uint cbSize, flags;
    public IntPtr active, focus, capture, menuOwner, moveSize, caret;
    public RECT caretRect;
  }
  delegate bool EnumProc(IntPtr h, IntPtr lp);

  static int VX { get { return GetSystemMetrics(76); } }
  static int VY { get { return GetSystemMetrics(77); } }
  static int VW { get { return GetSystemMetrics(78); } }
  static int VH { get { return GetSystemMetrics(79); } }

  public static void EnsureDpiAware() {
    // WGC/DWM surfaces use physical pixels. Keep Win32 geometry on the same scale,
    // including on monitors whose scaling differs from the primary display.
    if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero)
      throw new InvalidOperationException("DPI_AWARENESS_FAILED: cannot establish per-monitor physical coordinates");
  }

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

  /**
   * The caller's "left" means the primary button, not the physical one on the left.
   *
   * SendInput's flags name physical buttons, and Windows applies the left-handed swap
   * (SM_SWAPBUTTON) when it turns a physical press into the message an application receives. So
   * on a swapped mouse MOUSEEVENTF_LEFTDOWN arrives as the *secondary* click, and a default click
   * opens a context menu instead of activating what it was aimed at -- issue #76. Inverting the
   * pair here cancels the system's inversion, so a caller asking for "left" always gets whatever
   * that user's Windows treats as primary.
   *
   * Measured on Windows 11 rather than inferred, by injecting into a window the probe owned:
   * with the swap on, sending LEFTDOWN produced WM_RBUTTONDOWN and sending RIGHTDOWN produced
   * WM_LBUTTONDOWN.
   *
   * Read per call rather than cached: it is a checkbox in Mouse properties and can change while
   * the app runs, and a stale answer is the same wrong-button bug with a longer fuse. Only the
   * primary and secondary swap -- middle and the wheel are untouched.
   *
   * (No backticks in this comment: the whole script is a String.raw template literal.)
   */
  static void ButtonFlags(string button, out uint down, out uint up) {
    bool swapped = GetSystemMetrics(SM_SWAPBUTTON) != 0;
    switch (button) {
      case "right":
        down = swapped ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_RIGHTDOWN;
        up = swapped ? MOUSEEVENTF_LEFTUP : MOUSEEVENTF_RIGHTUP;
        break;
      case "middle": case "wheel": down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; break;
      default:
        down = swapped ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
        up = swapped ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
        break;
    }
  }

  public static void Click(int x, int y, string button, int times) {
    if (times < 1 || times > 3) throw new ArgumentException("BAD_ACTION: click count must be between 1 and 3");
    Move(x, y);
    uint down, up;
    ButtonFlags(button, out down, out up);
    List<INPUT> batch = new List<INPUT>();
    for (int n = 0; n < times; n++) {
      batch.Add(Mouse(down, 0, 0, 0));
      batch.Add(Mouse(up, 0, 0, 0));
    }
    try { Send(batch.ToArray()); }
    catch {
      // A short SendInput may have accepted a button-down without its matching up.
      try { Send(new INPUT[] { Mouse(up, 0, 0, 0) }); } catch { }
      throw;
    }
  }

  public static void Scroll(int x, int y, int dx, int dy) {
    Scroll(x, y, dx, dy, false);
  }

  public static void Scroll(int x, int y, int dx, int dy, bool rawWheel) {
    Move(x, y);
    List<INPUT> batch = new List<INPUT>();
    // Positive scroll_y means "scroll down" for the caller; the wheel API is the
    // other way round, hence the negation.
    int unit = rawWheel ? 1 : 120;
    if (dy != 0) batch.Add(Mouse(MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)(-dy * unit))));
    if (dx != 0) batch.Add(Mouse(MOUSEEVENTF_HWHEEL, 0, 0, unchecked((uint)(dx * unit))));
    if (batch.Count > 0) Send(batch.ToArray());
  }

  public static void Drag(int[] xs, int[] ys, string button) {
    Drag(xs, ys, button, 350);
  }

  public static void Drag(int[] xs, int[] ys, string button, int durationMs) {
    if (xs == null || ys == null || xs.Length != ys.Length || xs.Length < 2 || xs.Length > 64 || durationMs < 50 || durationMs > 2000)
      throw new ArgumentException("BAD_ACTION: drag requires 2-64 points and a 50-2000 ms duration");
    double[] distance = new double[xs.Length];
    for (int i = 1; i < xs.Length; i++) {
      double dx = (double)xs[i] - xs[i - 1], dy = (double)ys[i] - ys[i - 1];
      distance[i] = distance[i - 1] + Math.Sqrt(dx * dx + dy * dy);
    }
    uint down, up;
    ButtonFlags(button, out down, out up);
    Move(xs[0], ys[0]);
    try {
      Send(new INPUT[] { Mouse(down, 0, 0, 0) });
      int steps = Math.Min(256, Math.Max(2, (int)Math.Ceiling(durationMs / 10.0)));
      int segment = 1;
      var clock = System.Diagnostics.Stopwatch.StartNew();
      for (int step = 1; step <= steps; step++) {
        double at = distance[distance.Length - 1] * step / steps;
        while (segment < distance.Length - 1 && distance[segment] < at) segment++;
        double length = distance[segment] - distance[segment - 1];
        double fraction = length <= 0 ? 1 : (at - distance[segment - 1]) / length;
        int x = (int)Math.Round(xs[segment - 1] + (xs[segment] - (double)xs[segment - 1]) * fraction);
        int y = (int)Math.Round(ys[segment - 1] + (ys[segment] - (double)ys[segment - 1]) * fraction);
        Move(x, y);
        int remaining = (int)Math.Ceiling((double)durationMs * step / steps - clock.ElapsedMilliseconds);
        if (remaining > 0) System.Threading.Thread.Sleep(Math.Min(10, remaining));
      }
    } finally {
      Send(new INPUT[] { Mouse(up, 0, 0, 0) });
    }
  }

  static INPUT Key(int encoded, bool up) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wVk = (ushort)(encoded & 0xFFFF);
    bool extended = (encoded & 0x10000) != 0;
    i.u.ki.dwFlags = (up ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
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
    if (text.IndexOf('\r') >= 0 || text.IndexOf('\n') >= 0)
      throw new InvalidOperationException("MULTILINE_REQUIRES_PASTE: literal multiline text requires the clipboard paste action");
    List<INPUT> batch = new List<INPUT>();
    foreach (char c in text) {
      batch.Add(Unicode(c, false));
      batch.Add(Unicode(c, true));
      // SendInput caps out on very long batches; flush in chunks.
      if (batch.Count >= 200) { SendText(batch); batch.Clear(); }
    }
    if (batch.Count > 0) SendText(batch);
  }

  static void SendText(List<INPUT> batch) {
    try { Send(batch.ToArray()); }
    catch {
      // A short injection can split a Unicode packet's down/up pair too.
      List<INPUT> release = new List<INPUT>();
      foreach (INPUT input in batch) {
        if ((input.u.ki.dwFlags & KEYEVENTF_KEYUP) == 0) release.Add(Unicode((char)input.u.ki.wScan, true));
      }
      try { Send(release.ToArray()); } catch { }
      throw;
    }
  }

  /**
   * Presses keys together, holds the chord briefly, then releases in reverse.
   * Sending down+up for an entire chord as one zero-delay batch is accepted by
   * SendInput but some Windows apps miss system shortcuts such as ALT+F4. Keeping
   * the modifiers physically down for a few milliseconds makes the sequence match
   * a real keyboard much more closely without making ordinary shortcuts feel slow.
   */
  public static void Press(int[] vks) {
    List<INPUT> down = new List<INPUT>();
    List<INPUT> up = new List<INPUT>();
    for (int i = 0; i < vks.Length; i++) down.Add(Key(vks[i], false));
    for (int i = vks.Length - 1; i >= 0; i--) up.Add(Key(vks[i], true));
    try {
      Send(down.ToArray());
      System.Threading.Thread.Sleep(35);
    } finally {
      Send(up.ToArray());
    }
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
    // An exact handle may name a menu/popup without a title. General listing still
    // filters these; related-window discovery supplies their ownership proof.
    StringBuilder sb = new StringBuilder(len + 1);
    GetWindowTextW(h, sb, sb.Capacity);
    RECT r;
    if (!GetWindowRect(h, out r) || r.Right - r.Left <= 0 || r.Bottom - r.Top <= 0) return "";
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    string[] identity = CosWindowsAppIdentity.Read(handle, pid);
    if (identity[0].Length == 0) return ""; // Unknown app identity cannot be targeted by the window API.
    string proc = System.IO.Path.GetFileNameWithoutExtension(identity[1]);
    if (proc.Length == 0) try { using (var process = System.Diagnostics.Process.GetProcessById((int)pid)) proc = process.ProcessName; } catch { }
    uint dpi = GetDpiForWindow(h);
    if (dpi == 0) return "";
    return string.Join(((char)31).ToString(), new string[] {
      h.ToInt64().ToString(), sb.ToString().Replace((char)31, ' '), proc,
      r.Left.ToString(), r.Top.ToString(), (r.Right - r.Left).ToString(), (r.Bottom - r.Top).ToString(),
      IsIconic(h) ? "minimized" : (h == GetForegroundWindow() ? "foreground" : "open"),
      identity[0], pid.ToString(), identity[1], identity[2], dpi.ToString()
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
      string row = Window(h.ToInt64());
      if (row.Length > 0) found.Add(row);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  static bool OwnedBy(IntPtr candidate, IntPtr target) {
    IntPtr root = GetAncestor(candidate, 2); // GA_ROOT: child controls belong to their top-level window.
    if (root != IntPtr.Zero) candidate = root;
    for (int depth = 0; depth < 16 && candidate != IntPtr.Zero; depth++) {
      if (candidate == target) return true;
      candidate = GetWindow(candidate, 4); // GW_OWNER: exact owner chain, never merely same PID.
    }
    return false;
  }

  static bool IsMenu(IntPtr window) {
    StringBuilder name = new StringBuilder(256);
    GetClassNameW(window, name, name.Capacity);
    return name.ToString() == "#32768";
  }

  public static bool IsRelatedWindow(long candidateHandle, long targetHandle) {
    IntPtr candidate = new IntPtr(candidateHandle), target = new IntPtr(targetHandle);
    if (candidate == target || !IsWindow(target) || !IsWindowVisible(candidate) || IsIconic(candidate)) return false;
    if (OwnedBy(candidate, target)) return true;
    if (!IsMenu(candidate)) return false;
    uint targetProcess, candidateProcess;
    uint targetThread = GetWindowThreadProcessId(target, out targetProcess);
    uint candidateThread = GetWindowThreadProcessId(candidate, out candidateProcess);
    GUITHREADINFO gui = new GUITHREADINFO();
    gui.cbSize = (uint)Marshal.SizeOf(typeof(GUITHREADINFO));
    return candidateThread == targetThread && candidateProcess == targetProcess && GetGUIThreadInfo(targetThread, ref gui) &&
      gui.menuOwner != IntPtr.Zero && OwnedBy(gui.menuOwner, target);
  }

  static IntPtr InputRoot(IntPtr window) {
    bool menu = IsMenu(window);
    if ((GetWindowLong(window, -20) & 0x08000000) == 0 && !menu) return window; // WS_EX_NOACTIVATE
    IntPtr owner = GetWindow(window, 4);
    if (owner == IntPtr.Zero && menu) {
      uint process;
      uint thread = GetWindowThreadProcessId(window, out process);
      GUITHREADINFO gui = new GUITHREADINFO();
      gui.cbSize = (uint)Marshal.SizeOf(typeof(GUITHREADINFO));
      if (GetGUIThreadInfo(thread, ref gui)) owner = GetAncestor(gui.menuOwner, 2);
    }
    for (int depth = 0; depth < 16 && owner != IntPtr.Zero; depth++) {
      if ((GetWindowLong(owner, -20) & 0x08000000) == 0 && !IsMenu(owner)) break;
      owner = GetWindow(owner, 4);
    }
    return owner != IntPtr.Zero && IsRelatedWindow(window.ToInt64(), owner.ToInt64()) ? owner : IntPtr.Zero;
  }

  public static bool InputIsFocused(long handle) {
    IntPtr window = new IntPtr(handle);
    if (!IsWindowVisible(window) || IsIconic(window)) return false;
    IntPtr root = InputRoot(window);
    return root != IntPtr.Zero && GetForegroundWindow() == root;
  }

  public static List<string> RelatedWindows(long handle) {
    IntPtr target = new IntPtr(handle);
    List<string> related = new List<string>();
    if (!IsWindow(target)) return related;
    uint targetProcess;
    uint targetThread = GetWindowThreadProcessId(target, out targetProcess);
    GUITHREADINFO gui = new GUITHREADINFO();
    gui.cbSize = (uint)Marshal.SizeOf(typeof(GUITHREADINFO));
    bool menuOwned = GetGUIThreadInfo(targetThread, ref gui) && gui.menuOwner != IntPtr.Zero && OwnedBy(gui.menuOwner, target);
    EnumWindows(delegate(IntPtr candidate, IntPtr lp) {
      if (candidate == target || !IsWindowVisible(candidate) || IsIconic(candidate)) return true;
      bool owned = OwnedBy(candidate, target);
      if (!owned && menuOwned) {
        uint candidateProcess;
        uint candidateThread = GetWindowThreadProcessId(candidate, out candidateProcess);
        StringBuilder className = new StringBuilder(256);
        GetClassNameW(candidate, className, className.Capacity);
        owned = candidateThread == targetThread && candidateProcess == targetProcess && className.ToString() == "#32768";
      }
      if (!owned) return true;
      string row = Window(candidate.ToInt64());
      if (row.Length > 0) related.Add(row);
      return related.Count < 3;
    }, IntPtr.Zero);
    return related;
  }

  /**
   * Attachment can fail, and Windows still owns permission to activate the target.
   * Only a successful attachment is ours to detach, including when activation throws.
   */
  public static bool Focus(long handle) {
    IntPtr h = InputRoot(new IntPtr(handle));
    if (h == IntPtr.Zero) return false;
    if (!IsWindow(h)) return false;
    if (GetForegroundWindow() == h) return true;
    if (IsIconic(h)) ShowWindow(h, 9);
    uint dummy;
    uint fore = GetWindowThreadProcessId(GetForegroundWindow(), out dummy);
    uint self = GetCurrentThreadId();
    bool attached = fore != 0 && fore != self && AttachThreadInput(self, fore, true);
    try {
      return SetForegroundWindow(h);
    } finally {
      if (attached) AttachThreadInput(self, fore, false);
    }
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

}
${WINDOWS_KEYS_SOURCE}
${WINDOWS_APP_IDENTITY_SOURCE}
'@ -ReferencedAssemblies System.Drawing

${WINDOWS_CAPTURE_BOOTSTRAP}

# Requests arrive as one JSON object per stdin line. The process stays alive, so the
# expensive Add-Type/C# compilation above happens once instead of on every MCP call.
# Model-supplied text is data parsed by ConvertFrom-Json and is never evaluated as
# PowerShell source.

function Get-WindowRows {
  $rows = @()
  foreach ($line in [Clf]::Windows()) {
    $rows += Convert-WindowRow $line
  }
  return $rows
}

function Convert-WindowRow([string]$line) {
  if ([string]::IsNullOrEmpty($line)) { return $null }
  $f = $line -split ([char]31)
  return @{
    id = [int64]$f[0]; title = $f[1]; process = $f[2]
    x = [int]$f[3]; y = [int]$f[4]; width = [int]$f[5]; height = [int]$f[6]; state = $f[7]
    app = $f[8]; processId = [uint32]$f[9]; processPath = $f[10]; appUserModelId = $f[11]; dpi = [int]$f[12]
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
  if ([Clf]::InputIsFocused($id)) { return $true }
  $null = [Clf]::Focus($id)
  # Activation is asynchronous for some windows. Confirm the actual foreground state and
  # stop as soon as it lands, including when SetForegroundWindow returned false. That
  # immediate result does not replace the target's actual foreground postcondition.
  $timer = [Diagnostics.Stopwatch]::StartNew()
  do {
    if ([Clf]::InputIsFocused($id)) { return $true }
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

function Get-UiRoot([int64]$id) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$id)
  if ($null -eq $root) { throw "UIA_FAILED: no accessible window with id $id" }
  if ($root.Current.ClassName -ne 'Chrome_WidgetWin_1') { return $root }
  $window = Get-WindowRow $id
  if ($null -eq $window) { throw "UIA_FAILED: window $id disappeared during observation" }
  if ($window.process -notmatch '${BROWSER_PROCESS_PATTERN.source}') { return $root }

  # Chromium also exposes legacy renderer HWNDs as direct children. They retain
  # old tabs, plausible bounds and even IsOffscreen=false. BrowserRootView owns
  # the current browser UI, including its address bar and selected document.
  # Select that exact provider before spending the bounded element traversal.
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $child = $walker.GetFirstChild($root)
  $browserRoot = $null
  $visited = 0
  while ($null -ne $child -and $visited -lt 128) {
    $visited += 1
    if ($child.Current.ClassName -eq 'BrowserRootView') {
      if ($null -ne $browserRoot) { throw 'UIA_FAILED: multiple browser UI roots; use the screenshot instead' }
      $browserRoot = $child
    }
    $child = $walker.GetNextSibling($child)
  }
  if ($null -ne $child -or $null -eq $browserRoot) {
    throw 'UIA_FAILED: current browser UI root is unavailable; use the screenshot instead'
  }
  return $browserRoot
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
    $root = Get-UiRoot $id
  } catch {
    throw "UIA_FAILED: cannot inspect window $id. $($_.Exception.Message)"
  }
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
    # A live legacy provider is not proof that its old tab is still displayed.
    # Revalidate membership in the same current UI root before semantic input.
    $parent = $element
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    for ($depth = 0; $depth -le 64 -and $null -ne $parent; $depth++) {
      if ((Ui-RuntimeKey $parent) -eq [string]$snapshot.rootRuntimeKey) { return $element }
      $parent = $walker.GetParent($parent)
    }
    throw 'STALE_UI_REF: the element is no longer in the observed window UI; observe again'
  } catch {
    $message = $_.Exception.Message
    if ($message -match '^[A-Z0-9_]+:') { throw $message }
    throw "UI_ELEMENT_GONE: the referenced UI element is no longer present. Call observe on the window again and use a ref from that reply."
  }
}

$script:UiActionNames = @('invoke','toggle','select','expand','collapse','focus','scroll_up','scroll_down','scroll_left','scroll_right','scroll_into_view')

function Get-UiActions($element, $current) {
  $actions = New-Object 'System.Collections.Generic.List[string]'
  $supported = @($element.GetSupportedPatterns() | ForEach-Object { $_.Id })
  if ($supported -contains [System.Windows.Automation.InvokePattern]::Pattern.Id) { $actions.Add('invoke') }
  if ($supported -contains [System.Windows.Automation.TogglePattern]::Pattern.Id) { $actions.Add('toggle') }
  if ($supported -contains [System.Windows.Automation.SelectionItemPattern]::Pattern.Id) { $actions.Add('select') }
  if ($supported -contains [System.Windows.Automation.ExpandCollapsePattern]::Pattern.Id) {
    $pattern = [System.Windows.Automation.ExpandCollapsePattern]$element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    if ($pattern.Current.ExpandCollapseState -ne [System.Windows.Automation.ExpandCollapseState]::LeafNode) {
      $actions.Add('expand'); $actions.Add('collapse')
    }
  }
  if ($supported -contains [System.Windows.Automation.ScrollPattern]::Pattern.Id) {
    $pattern = [System.Windows.Automation.ScrollPattern]$element.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
    if ($pattern.Current.VerticallyScrollable) { $actions.Add('scroll_up'); $actions.Add('scroll_down') }
    if ($pattern.Current.HorizontallyScrollable) { $actions.Add('scroll_left'); $actions.Add('scroll_right') }
  }
  if ($supported -contains [System.Windows.Automation.ScrollItemPattern]::Pattern.Id) { $actions.Add('scroll_into_view') }
  if ($current.IsKeyboardFocusable) { $actions.Add('focus') }
  return @($actions.ToArray())
}

function Invoke-UiAction($element, [string]$action) {
  # Explicit semantic actions never degrade to a click at guessed coordinates.
  $patternId = switch ($action) {
    'invoke' { [System.Windows.Automation.InvokePattern]::Pattern }
    'toggle' { [System.Windows.Automation.TogglePattern]::Pattern }
    'select' { [System.Windows.Automation.SelectionItemPattern]::Pattern }
    { $_ -in @('expand','collapse') } { [System.Windows.Automation.ExpandCollapsePattern]::Pattern }
    { $_ -in @('scroll_up','scroll_down','scroll_left','scroll_right') } { [System.Windows.Automation.ScrollPattern]::Pattern }
    'scroll_into_view' { [System.Windows.Automation.ScrollItemPattern]::Pattern }
    'focus' { $null }
    default { throw "BAD_ACTION: unsupported UI element action $action" }
  }
  if ($action -eq 'focus') {
    if (-not $element.Current.IsKeyboardFocusable) { throw 'UI_ACTION_UNSUPPORTED: element is not keyboard focusable' }
    $element.SetFocus()
    return
  }
  $pattern = $null
  if (-not $element.TryGetCurrentPattern($patternId, [ref]$pattern)) {
    throw "UI_ACTION_UNSUPPORTED: element does not currently support $action"
  }
  switch ($action) {
    'invoke' { ([System.Windows.Automation.InvokePattern]$pattern).Invoke() }
    'toggle' { ([System.Windows.Automation.TogglePattern]$pattern).Toggle() }
    'select' { ([System.Windows.Automation.SelectionItemPattern]$pattern).Select() }
    'expand' { ([System.Windows.Automation.ExpandCollapsePattern]$pattern).Expand() }
    'collapse' { ([System.Windows.Automation.ExpandCollapsePattern]$pattern).Collapse() }
    'scroll_into_view' { ([System.Windows.Automation.ScrollItemPattern]$pattern).ScrollIntoView() }
    { $_ -in @('scroll_up','scroll_down','scroll_left','scroll_right') } {
      $scroll = [System.Windows.Automation.ScrollPattern]$pattern
      $horizontal = [System.Windows.Automation.ScrollAmount]::NoAmount
      $vertical = [System.Windows.Automation.ScrollAmount]::NoAmount
      if ($action -in @('scroll_up','scroll_down')) {
        if (-not $scroll.Current.VerticallyScrollable) { throw 'UI_ACTION_UNSUPPORTED: element is not vertically scrollable' }
        $vertical = if ($action -eq 'scroll_up') { [System.Windows.Automation.ScrollAmount]::LargeDecrement } else { [System.Windows.Automation.ScrollAmount]::LargeIncrement }
      } else {
        if (-not $scroll.Current.HorizontallyScrollable) { throw 'UI_ACTION_UNSUPPORTED: element is not horizontally scrollable' }
        $horizontal = if ($action -eq 'scroll_left') { [System.Windows.Automation.ScrollAmount]::LargeDecrement } else { [System.Windows.Automation.ScrollAmount]::LargeIncrement }
      }
      $scroll.Scroll($horizontal, $vertical)
    }
  }
}

function Get-RequestedClickCount($request) {
  $value = if ($request -is [Collections.IDictionary]) { $request['count'] } else { $request.count }
  if ($null -eq $value) { return 1 }
  if ([double]$value -lt 1 -or [double]$value -gt 3 -or [double]$value -ne [int]$value) { throw 'BAD_ACTION: click count must be an integer between 1 and 3' }
  return [int]$value
}

function Act-UiElement($request) {
  $action = [string]$request.action
  if ($action -notin $script:UiActionNames -and $action -notin @('click','set_value')) {
    throw "BAD_ACTION: unsupported UI element action $action"
  }
  $id = [int64]$request.id
  Assert-InputOwner $id $request.ownerWindow $request.targetApp $request.ownerApp
  $element = Resolve-UiElement $id ([int]$request.snapshotId) ([string]$request.runtimeKey)
  if (-not $element.Current.IsEnabled) { throw "UI_ELEMENT_DISABLED: the referenced element is disabled" }
  if ($action -eq 'set_value') {
    $pattern = $null
    if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
      throw "UI_VALUE_UNSUPPORTED: the referenced element does not expose ValuePattern"
    }
    $value = [System.Windows.Automation.ValuePattern]$pattern
    if ($value.Current.IsReadOnly) { throw "UI_VALUE_READONLY: the referenced element is read-only" }
    Assert-InputOwner $id $request.ownerWindow $request.targetApp $request.ownerApp
    $value.SetValue([string]$request.value)
    $route = 'uia'
  } elseif ($action -eq 'click') {
    $button = if ($request.button) { [string]$request.button } else { 'left' }
    $count = Get-RequestedClickCount $request
    if ($button -notin @('left','right','middle') -or $count -lt 1 -or $count -gt 3) { throw 'BAD_ACTION: unsupported click button or count' }
    $semanticClick = $button -eq 'left' -and $count -eq 1
    $pattern = $null
    if ($semanticClick -and $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
      Assert-InputOwner $id $request.ownerWindow $request.targetApp $request.ownerApp
      ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
      $route = 'uia'
    } elseif ($semanticClick -and $element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
      Assert-InputOwner $id $request.ownerWindow $request.targetApp $request.ownerApp
      ([System.Windows.Automation.TogglePattern]$pattern).Toggle()
      $route = 'uia'
    } elseif ($semanticClick -and $element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
      Assert-InputOwner $id $request.ownerWindow $request.targetApp $request.ownerApp
      ([System.Windows.Automation.SelectionItemPattern]$pattern).Select()
      $route = 'uia'
    } else {
      # A semantic control without InvokePattern has to fall back to physical input. Make
      # that last resort explicit and safe: the referenced window, not an overlay at the
      # same desktop coordinates, must be foreground before the pointer goes down.
      Assert-Focused $id
      $r = $element.Current.BoundingRectangle
      if ($r.Width -le 0 -or $r.Height -le 0) { throw "UI_ELEMENT_OFFSCREEN: the referenced element has no clickable bounds" }
      Assert-InputOwner $id $request.ownerWindow $request.targetApp $request.ownerApp
      [Clf]::Click([int][Math]::Round($r.X + $r.Width / 2), [int][Math]::Round($r.Y + $r.Height / 2), $button, $count)
      $route = 'sendinput'
    }
  } else {
    Assert-InputOwner $id $request.ownerWindow $request.targetApp $request.ownerApp
    Invoke-UiAction $element $action
    $route = 'uia'
  }
  return @{ runtimeKey = (Ui-RuntimeKey $element); name = [string]$element.Current.Name; route = $route }
}

function Find-UiElements($request) {
  $id = if ($request.id) { [int64]$request.id } else { [Clf]::ForegroundId() }
  try {
    $root = Get-UiRoot $id
  } catch {
    throw "UIA_FAILED: cannot inspect window $id. $($_.Exception.Message)"
  }

  $query = ([string]$request.query).Trim().ToLowerInvariant()
  $role = ([string]$request.role).Trim().ToLowerInvariant()
  $limit = if ($request.maxResults) { [Math]::Min(100, [Math]::Max(1, [int]$request.maxResults)) } else { 30 }
  $visitLimit = if ($request.maxVisited) { [Math]::Min(10000, [Math]::Max($limit, [int]$request.maxVisited)) } else { 3000 }
  $found = @()
  $handles = New-Object 'System.Collections.Generic.List[object]'
  $visited = 0
  $documentText = $null
  $selectedText = $null
  $focusedElement = $null
  $textPattern = $null
  $textPriority = 0
  $browserDocument = $root.Current.ClassName -eq 'BrowserRootView'
  $depthLimited = $false
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
    $cache.Add([System.Windows.Automation.AutomationElement]::HasKeyboardFocusProperty)
    $cache.Add([System.Windows.Automation.AutomationElement]::IsKeyboardFocusableProperty)
    $cache.Add([System.Windows.Automation.AutomationElement]::IsPasswordProperty)
    $cache.Add([System.Windows.Automation.SelectionItemPattern]::IsSelectedProperty)
    $stack = New-Object System.Collections.Stack
    $element = $walker.GetFirstChild($root, $cache)
    $depth = 1
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
            $runtimeKey = Ui-RuntimeKey $element
            $availableActions = @()
            try { $availableActions = @(Get-UiActions $element $current) } catch { }
            $entry = @{
              runtimeKey = $runtimeKey
              name = $name
              role = $control
              automationId = $automationId
              enabled = [bool]$current.IsEnabled
              offscreen = [bool]$current.IsOffscreen
              focused = [bool]$current.HasKeyboardFocus
              depth = $depth
              actions = $availableActions
              bounds = @{
                x = [int][Math]::Round($r.X); y = [int][Math]::Round($r.Y)
                width = [int][Math]::Round($r.Width); height = [int][Math]::Round($r.Height)
              }
            }
            try {
              $selected = $element.GetCachedPropertyValue([System.Windows.Automation.SelectionItemPattern]::IsSelectedProperty, $true)
              if ($selected -is [bool]) { $entry.selected = $selected }
            } catch { }
            if ($current.HasKeyboardFocus) { $focusedElement = $runtimeKey }
            $found += $entry
            $handles.Add($element)
            # Select within this traversal, then read just one provider. Browser
            # toolbar editors precede the page and must never become document_text.
            # Native editors remain useful when no Document provider is observed.
            $priority = if ($current.IsPassword) { 0 }
              elseif ($control -eq 'Document') { 3 }
              elseif ($browserDocument) { 0 }
              elseif ($current.HasKeyboardFocus) { 2 }
              elseif ($control -eq 'Edit') { 1 }
              else { 0 }
            if ($priority -gt $textPriority) {
              try {
                $candidate = $null
                if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$candidate)) {
                  $textPattern = [System.Windows.Automation.TextPattern]$candidate
                  $textPriority = $priority
                }
              } catch { }
            }
          }
        }
      } catch { }

      $sibling = $null
      try { $sibling = $walker.GetNextSibling($element, $cache) } catch { }
      if ($null -ne $sibling) { $stack.Push(@{ element = $sibling; depth = $depth }) }
      $child = $null
      if ($depth -lt 64) { try { $child = $walker.GetFirstChild($element, $cache) } catch { } } else { $depthLimited = $true }
      if ($null -ne $child) {
        $element = $child
        $depth += 1
      } elseif ($stack.Count -gt 0) {
        $next = $stack.Pop()
        $element = $next.element
        $depth = $next.depth
      } else {
        $element = $null
      }
    }
  } catch {
    throw "UIA_FAILED: $($_.Exception.Message)"
  }
  if ($null -ne $textPattern) {
    try {
      $budget = 8000
      $selection = New-Object System.Text.StringBuilder
      $ranges = @($textPattern.GetSelection())
      foreach ($range in ($ranges | Select-Object -First 4)) {
        $remaining = [Math]::Min(2000 - $selection.Length, $budget)
        if ($remaining -le 0) { break }
        $part = $range.GetText($remaining)
        $null = $selection.Append($part)
        $budget -= $part.Length
      }
      $selectedText = $selection.ToString()
      $documentText = $textPattern.DocumentRange.GetText($budget)
    } catch { }
  }
  $snapshotId = Remember-UiSnapshot $id $root $handles
  return @{
    window = $id
    snapshotId = $snapshotId
    elements = @($found)
    visited = $visited
    truncated = ($null -ne $element -or $stack.Count -gt 0 -or $depthLimited)
    document_text = $documentText
    selected_text = $selectedText
    focused_element = $focusedElement
  }
}

function Capture-Target($request, [Nullable[int64]]$forcedWindow) {
  $screen = Get-ScreenRect
  $id = if ($null -ne $forcedWindow) { [int64]$forcedWindow } elseif ($request.id) { [int64]$request.id } else { $null }
  $mode = 'screen'
  $focused = $null
  $windowGeometry = $null
  if ($request.region) {
    $x = [int]$request.region.x; $y = [int]$request.region.y
    $w = [int]$request.region.width; $h = [int]$request.region.height
  } elseif ($null -ne $id) {
    try { $r = [Clf]::Rect([int64]$id) -split ',' } catch {
      throw "WINDOW_NOT_FOUND: window $id is no longer open, so there is nothing to capture. Call observe what=windows for the current windows."
    }
    $x = [int]$r[0]; $y = [int]$r[1]; $w = [int]$r[2]; $h = [int]$r[3]
    $windowGeometry = @{ x = $x; y = $y; width = $w; height = $h }
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
  # Capture the named window's compositor surface, never pixels of an occluding window.
  # DWM excludes invisible resize borders, so preserve outer geometry separately.
  if ($null -ne $id -and $request.file) {
    if ($request.ownerWindow -and -not [Clf]::IsRelatedWindow([int64]$id, [int64]$request.ownerWindow)) {
      throw 'RELATED_WINDOW_GONE: popup no longer belongs to the observed window'
    }
    Initialize-WindowsCapture
    try {
      $direct = [CosWindowsCapture]::Capture([int64]$id, $maxW, [string]$request.file) -split ','
    } catch {
      # PowerShell wraps C# exceptions in invocation text; retain the native error
      # code so callers distinguish stale geometry from a transport/helper failure.
      throw $_.Exception.GetBaseException().Message
    }
    $after = [Clf]::Rect([int64]$id) -split ','
    if ([int]$after[0] -ne $windowGeometry.x -or [int]$after[1] -ne $windowGeometry.y -or
        [int]$after[2] -ne $windowGeometry.width -or [int]$after[3] -ne $windowGeometry.height) {
      throw 'STALE_FRAME: window geometry changed during capture'
    }
    if ($request.ownerWindow -and -not [Clf]::IsRelatedWindow([int64]$id, [int64]$request.ownerWindow)) {
      throw 'RELATED_WINDOW_GONE: popup ownership changed during capture'
    }
    $x = [int]$direct[0]; $y = [int]$direct[1]; $w = [int]$direct[2]; $h = [int]$direct[3]
    $out = @($direct[4], $direct[5])
    $mode = 'window'
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
    windowGeometry = $windowGeometry
  }
}

function Assert-InputOwner([int64]$target, $owner, $targetApp, $ownerApp) {
  if ($targetApp) {
    $targetRow = Get-WindowRow $target
    if ($null -eq $targetRow -or $targetRow.app -cne [string]$targetApp) {
      throw 'WINDOW_APP_MISMATCH: input target no longer belongs to the observed application'
    }
  }
  if ($ownerApp) {
    $ownerRow = if ($owner) { Get-WindowRow ([int64]$owner) } else { $null }
    if ($null -eq $ownerRow -or $ownerRow.app -cne [string]$ownerApp) {
      throw 'WINDOW_APP_MISMATCH: input owner no longer belongs to the observed application'
    }
  }
  if ($owner -and ($target -le 0 -or ($target -ne [int64]$owner -and -not [Clf]::IsRelatedWindow($target, [int64]$owner)))) {
    throw 'RELATED_WINDOW_GONE: input target no longer belongs to the observed window'
  }
}

function Assert-CoordinateFrame($frame) {
  $region = $frame.region
  if ($frame.window) {
    $id = [int64]$frame.window
    Assert-InputOwner $id $frame.ownerWindow $frame.targetApp $frame.ownerApp
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
    Assert-InputOwner $id $frame.ownerWindow $frame.targetApp $frame.ownerApp
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

${WINDOWS_APPS_SCRIPT}

function Handle-Request($request) {
  [Clf]::EnsureDpiAware()
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
    'apps' {
      $apps = Get-WindowsApps $request
      foreach ($key in $apps.Keys) { $result[$key] = $apps[$key] }
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
      $result.document_text = $ui.document_text
      $result.selected_text = $ui.selected_text
      $result.focused_element = $ui.focused_element
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
      if ($request.includeRelated) {
        $result.relatedWindows = @([Clf]::RelatedWindows($id) | ForEach-Object { Convert-WindowRow $_ })
      }
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
        try {
          $ui = Find-UiElements $uiRequest
          $result.snapshotId = $ui.snapshotId
          $result.elements = @($ui.elements)
          $result.visited = $ui.visited
          $result.truncated = $ui.truncated
          $result.document_text = $ui.document_text
          $result.selected_text = $ui.selected_text
          $result.focused_element = $ui.focused_element
        } catch {
          # Accessibility is optional observation metadata. Preserve successful pixels
          # when an application provider cannot expose its controls.
          $result.uiUnavailable = @{ code = 'UIA_FAILED'; message = $_.Exception.Message }
          $result.elements = @()
        }
      }
    }
    'focus' {
      $id = [int64]$request.id
      $result.focused = (Try-Focus $id)
      $result.foreground = [Clf]::ForegroundId()
    }
    'act' {
      # Resolve every key before focus, pointer or text effects. A typo in a later chord
      # must not leave the earlier half of a deterministic-invalid batch applied.
      $keyTarget = if ($request.targetWindow) { [int64]$request.targetWindow } else { [Clf]::ForegroundId() }
      foreach ($action in $request.actions) {
        if ($action.type -eq 'focus') { $keyTarget = [int64]$action.window }
        if ($action.type -eq 'keypress') {
          try { $resolved = [CosWindowsKeys]::Resolve([string[]]$action.keys, $keyTarget) }
          catch { throw $_.Exception.GetBaseException().Message }
          $action | Add-Member -NotePropertyName resolvedKeys -NotePropertyValue $resolved -Force
        }
        if ($action.type -eq 'type' -and [string]$action.text -match '[\r\n]') {
          throw 'MULTILINE_REQUIRES_PASTE: literal multiline text requires the clipboard paste action'
        }
        if ($action.type -eq 'ui_action' -and [string]$action.action -notin $script:UiActionNames) {
          throw "BAD_ACTION: unsupported UI element action $($action.action)"
        }
        if ($action.type -in @('click','click_ui')) { $null = Get-RequestedClickCount $action }
        if ($action.type -eq 'drag' -and $null -ne $action.durationMs -and
            ([double]$action.durationMs -lt 50 -or [double]$action.durationMs -gt 2000 -or [double]$action.durationMs -ne [int]$action.durationMs)) {
          throw 'BAD_ACTION: drag duration must be an integer between 50 and 2000 milliseconds'
        }
      }
      $routes = @()
      $launches = @()
      $completed = 0
      for ($index = 0; $index -lt $request.actions.Count; $index++) {
        $a = $request.actions[$index]
        try {
          $actionTarget = if ($a.type -in @('click_ui','set_value_ui','ui_action','focus')) { [int64]$a.window } elseif ($request.targetWindow) { [int64]$request.targetWindow } elseif ($request.frame.window) { [int64]$request.frame.window } else { 0 }
          Assert-InputOwner $actionTarget $request.ownerWindow $request.targetApp $request.ownerApp
          if ($request.targetWindow -and $a.type -in @('move','click','double_click','scroll','drag','type','keypress')) {
            Assert-Focused ([int64]$request.targetWindow)
            Assert-InputOwner $actionTarget $request.ownerWindow $request.targetApp $request.ownerApp
          }
          # Earlier actions may have changed focus or moved the target. Revalidate at
          # each physical action, including actions after a semantic UI invocation.
          if ($a.type -in @('move','click','double_click','scroll','drag') -and $request.frame) {
            Assert-CoordinateFrame $request.frame
          }
          Assert-InputOwner $actionTarget $request.ownerWindow $request.targetApp $request.ownerApp
          switch ($a.type) {
            'click_ui' {
              $ui = Act-UiElement @{ id = $a.window; snapshotId = $a.snapshotId; runtimeKey = $a.runtimeKey; action = 'click'; button = $a.button; count = (Get-RequestedClickCount $a); ownerWindow = $request.ownerWindow; targetApp = $request.targetApp; ownerApp = $request.ownerApp }
              $routes += $ui.route
            }
            'set_value_ui' {
              $ui = Act-UiElement @{ id = $a.window; snapshotId = $a.snapshotId; runtimeKey = $a.runtimeKey; action = 'set_value'; value = $a.value; ownerWindow = $request.ownerWindow; targetApp = $request.targetApp; ownerApp = $request.ownerApp }
              $routes += $ui.route
            }
            'ui_action' {
              $ui = Act-UiElement @{ id = $a.window; snapshotId = $a.snapshotId; runtimeKey = $a.runtimeKey; action = $a.action; ownerWindow = $request.ownerWindow; targetApp = $request.targetApp; ownerApp = $request.ownerApp }
              $routes += $ui.route
            }
            'launch_app' {
              $launches += Launch-WindowsApp @{ app = $a.app }
              $routes += 'shell'
            }
            'move'         { [Clf]::Move([int]$a.x, [int]$a.y); $routes += 'sendinput' }
            'click'        { [Clf]::Click([int]$a.x, [int]$a.y, $a.button, (Get-RequestedClickCount $a)); $routes += 'sendinput' }
            'double_click' { [Clf]::Click([int]$a.x, [int]$a.y, $a.button, 2); $routes += 'sendinput' }
            'scroll'       { [Clf]::Scroll([int]$a.x, [int]$a.y, [int]$a.scroll_x, [int]$a.scroll_y, [bool]$a.rawWheel); $routes += 'sendinput' }
            'drag'         { $duration = if ($null -ne $a.durationMs) { [int]$a.durationMs } else { 350 }; [Clf]::Drag([int[]]$a.xs, [int[]]$a.ys, $a.button, $duration); $routes += 'sendinput' }
            'type'         { [Clf]::Type([string]$a.text); $routes += 'sendinput' }
            'keypress'     { [Clf]::Press([int[]]$a.resolvedKeys); $routes += 'sendinput' }
            'focus'        { Assert-Focused ([int64]$a.window); Assert-InputOwner ([int64]$a.window) $request.ownerWindow $request.targetApp $request.ownerApp; $routes += 'focus' }
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
            launches = @($launches)
          }
        }
      }
      $cursor = [Clf]::Cursor() -split ','
      $result.cursor = @{ x = [int]$cursor[0]; y = [int]$cursor[1] }
      $result.foreground = [Clf]::ForegroundId()
      $result.completed_count = $completed
      $result.routes = @($routes)
      $result.launches = @($launches)
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
