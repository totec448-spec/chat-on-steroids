using System;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;

// Owned, disposable windows for scripts/smoke-windows-desktop.mjs. Never inspects
// or sends input to an existing user application.
class DesktopFixture {
  const string PasteText = "a\nb\r\nc";
  static System.Windows.Forms.DataObject savedClipboard;
  static bool clipboardSaved;
  static readonly System.Collections.Generic.List<IDisposable> clipboardResources = new System.Collections.Generic.List<IDisposable>();
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);
  [System.Runtime.InteropServices.DllImport("dwmapi.dll")] static extern int DwmFlush();

  static object CloneClipboardValue(object value) {
    if (value is string || value is int || value is uint || value is bool) return value;
    if (value is byte[]) return ((byte[])value).Clone();
    if (value is string[]) return ((string[])value).Clone();
    if (value is System.Drawing.Image) {
      var image = (System.Drawing.Image)((System.Drawing.Image)value).Clone();
      clipboardResources.Add(image); return image;
    }
    var stream = value as System.IO.Stream;
    if (stream != null && stream.CanSeek && stream.Length <= 64 * 1024 * 1024) {
      long position = stream.Position;
      var copy = new System.IO.MemoryStream();
      try { stream.Position = 0; stream.CopyTo(copy); copy.Position = 0; }
      finally { stream.Position = position; }
      clipboardResources.Add(copy); return copy;
    }
    throw new InvalidOperationException("Clipboard format type " + (value == null ? "null" : value.GetType().FullName) + " cannot be preserved safely; paste test was not started");
  }

  static void SaveClipboard() {
    uint sequence = GetClipboardSequenceNumber();
    var original = System.Windows.Forms.Clipboard.GetDataObject();
    var snapshot = new System.Windows.Forms.DataObject();
    if (original != null) {
      string[] formats = original.GetFormats(false);
      if (formats.Length > 128) throw new InvalidOperationException("Clipboard has too many formats to preserve safely");
      foreach (string format in formats) snapshot.SetData(format, false, CloneClipboardValue(original.GetData(format, false)));
    }
    if (GetClipboardSequenceNumber() != sequence) throw new InvalidOperationException("Clipboard changed during snapshot; paste test was not started");
    savedClipboard = snapshot;
    clipboardSaved = true;
  }

  static bool RestoreClipboard() {
    if (!clipboardSaved) return false;
    // Do not overwrite a newer user copy. Never print any original clipboard data.
    if (System.Windows.Forms.Clipboard.GetText(System.Windows.Forms.TextDataFormat.UnicodeText) != PasteText) return false;
    System.Windows.Forms.Clipboard.SetDataObject(savedClipboard, true);
    clipboardSaved = false;
    return true;
  }

  [STAThread] static void Main() {
    if (Environment.GetCommandLineArgs().Length > 1 && Environment.GetCommandLineArgs()[1] == "--software")
      System.Windows.Media.RenderOptions.ProcessRenderMode = System.Windows.Interop.RenderMode.SoftwareOnly;
    var app = new Application();
    var target = new Window { Title = "COS desktop test target", Left = 120, Top = 120, Width = 480, Height = 360, Background = Brushes.Red };
    var panel = new Grid();
    panel.Children.Add(new Border { Background = Brushes.Lime, Width = 100, Height = 100, HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(30, 40, 0, 0) });
    var editor = new TextBox { AcceptsReturn = true, Margin = new Thickness(20, 170, 20, 20), VerticalAlignment = VerticalAlignment.Top, Height = 100 };
    int enterKeys = 0, pasteCount = 0;
    editor.PreviewKeyDown += (s, e) => { if (e.Key == Key.Return) enterKeys++; };
    System.Windows.DataObject.AddPastingHandler(editor, (s, e) => { pasteCount++; });
    panel.Children.Add(editor);
    int invocations = 0;
    var invoke = new Button { Content = "Smoke Invoke", Width = 100, Height = 25, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Bottom };
    invoke.Click += (s, e) => { invocations++; };
    panel.Children.Add(invoke);
    target.Content = panel;
    var popup = new System.Windows.Controls.Primitives.Popup {
      PlacementTarget = panel, Placement = System.Windows.Controls.Primitives.PlacementMode.Relative,
      HorizontalOffset = 220, VerticalOffset = 60, StaysOpen = true, AllowsTransparency = true,
      Child = new Border { Width = 100, Height = 80, Background = Brushes.Magenta }
    };
    var cover = new Window { Title = "COS desktop test occluder", Left = 100, Top = 100, Width = 530, Height = 410, Background = Brushes.Blue };
    var serializer = new JavaScriptSerializer();
    Action<object> reply = value => { Console.WriteLine(serializer.Serialize(value)); Console.Out.Flush(); };
    // Loaded precedes the first WPF render. Covering there can leave a genuinely
    // white compositor surface: a capture must not invent pixels never painted.
    bool firstContentRendered = false;
    var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
    var painted = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(50) };
    var paintClock = new System.Diagnostics.Stopwatch();
    string paintEvidence = "";
    painted.Tick += (s, e) => {
      var point = panel.PointToScreen(new Point(60, 90));
      using (var pixel = new System.Drawing.Bitmap(1, 1)) {
        using (var graphics = System.Drawing.Graphics.FromImage(pixel)) graphics.CopyFromScreen((int)point.X, (int)point.Y, 0, 0, new System.Drawing.Size(1, 1));
        var color = pixel.GetPixel(0, 0);
        paintEvidence = point + "; pixel=" + color + "; active=" + target.IsActive + "; visible=" + target.IsVisible + "; tier=" + RenderCapability.Tier + "; panel=" + panel.ActualWidth + "x" + panel.ActualHeight;
        if (color.R < 10 && color.G > 240 && color.B < 10) {
          painted.Stop(); target.Topmost = false; cover.Show(); cover.Activate(); popup.IsOpen = true; timer.Start(); return;
        }
      }
      if (paintClock.ElapsedMilliseconds > 5000) {
        painted.Stop();
        reply(new { ok = false, stage = "fixture-first-paint", error = "Owned target marker did not render visibly before occlusion: " + paintEvidence });
        target.Close(); app.Shutdown();
      }
    };
    target.ContentRendered += (s, e) => {
      if (firstContentRendered) return;
      firstContentRendered = true;
      target.Topmost = true;
      target.Activate();
      DwmFlush();
      paintClock.Start(); painted.Start();
    };
    timer.Tick += (s, e) => {
      timer.Stop();
      var popupSource = System.Windows.PresentationSource.FromVisual(popup.Child) as System.Windows.Interop.HwndSource;
      // WPF Popup can omit native owner metadata. Explicitly construct an owned
      // transient for this fixture; production discovery must never guess by PID.
      if (popupSource != null) SetWindowLongPtr(popupSource.Handle, -8, new System.Windows.Interop.WindowInteropHelper(target).Handle);
      var invokeCenter = invoke.PointToScreen(new Point(invoke.ActualWidth / 2, invoke.ActualHeight / 2));
      reply(new { target = new System.Windows.Interop.WindowInteropHelper(target).Handle.ToInt64(), occluder = new System.Windows.Interop.WindowInteropHelper(cover).Handle.ToInt64(), popup = popupSource == null ? 0 : popupSource.Handle.ToInt64(), invokeX = invokeCenter.X, invokeY = invokeCenter.Y });
      System.Threading.Tasks.Task.Run(() => {
        string command;
        while ((command = Console.ReadLine()) != null) {
          string current = command;
          bool quit = current == "quit";
          app.Dispatcher.Invoke(() => {
            try {
            switch (current) {
              case "minimize": target.WindowState = WindowState.Minimized; break;
              case "occlude": cover.Show(); cover.Activate(); break;
              case "edit": popup.IsOpen = false; target.WindowState = WindowState.Normal; cover.Hide(); target.Activate(); editor.Focus(); Keyboard.Focus(editor); break;
              case "report": break;
              case "save-clipboard": SaveClipboard(); break;
              case "paste-ready": editor.Clear(); editor.Focus(); Keyboard.Focus(editor); break;
              case "restore-clipboard": reply(new { clipboardRestored = RestoreClipboard() }); return;
              case "quit": RestoreClipboard(); popup.IsOpen = false; cover.Close(); target.Close(); app.Shutdown(); break;
              default: throw new Exception("Unknown fixture command");
            }
            reply(new { ok = true, text = editor.Text, invocations = invocations, enterKeys = enterKeys, pasteCount = pasteCount, clipboardSaved = clipboardSaved });
            } catch (Exception error) { reply(new { ok = false, error = error.Message }); }
          });
          if (quit) return;
        }
        app.Dispatcher.Invoke(() => { RestoreClipboard(); popup.IsOpen = false; cover.Close(); target.Close(); app.Shutdown(); });
      });
    };
    app.Run(target);
    foreach (var resource in clipboardResources) resource.Dispose();
  }
}
