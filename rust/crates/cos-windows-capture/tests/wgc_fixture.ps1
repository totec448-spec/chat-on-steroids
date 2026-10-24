param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 2147483647)]
  [int]$ProbeProcessId
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class CosWgcOwnedFixture {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr awareness);
  [DllImport("dwmapi.dll")] static extern int DwmFlush();

  // Hold a handle to the exact test process, not merely its reusable PID.
  // If native capture access-violates, Rust Drop never runs: this background
  // watcher ends the owned UI process when its test process dies.
  static void RetireWithProbe(int probeProcessId) {
    var probe = Process.GetProcessById(probeProcessId);
    if (probe.HasExited || probe.Handle == IntPtr.Zero) {
      throw new InvalidOperationException("capture probe ended before the fixture started");
    }
    var watcher = new Thread(() => {
      try { probe.WaitForExit(); }
      catch (Exception) { /* A broken owner wait cannot leave a fixture behind. */ }
      Environment.Exit(0);
    });
    watcher.IsBackground = true;
    watcher.Start();
  }

  static bool Marker(Point at, Color color) {
    using (var bitmap = new Bitmap(1, 1))
    using (var graphics = Graphics.FromImage(bitmap)) {
      graphics.CopyFromScreen(at.X, at.Y, 0, 0, bitmap.Size);
      var pixel = bitmap.GetPixel(0, 0);
      return pixel.R == color.R && pixel.G == color.G && pixel.B == color.B;
    }
  }

  [STAThread]
  public static void Run(int probeProcessId) {
    RetireWithProbe(probeProcessId);
    SetThreadDpiAwarenessContext(new IntPtr(-4)); // PMv2, same as native capture.
    var target = new Form {
      Text = "COS owned WGC capture fixture", StartPosition = FormStartPosition.Manual,
      Location = new Point(90, 80), Size = new Size(420, 300),
      BackColor = Color.FromArgb(128, 0, 128), TopMost = true
    };
    var cover = new Form {
      Text = "COS owned WGC occluder", StartPosition = FormStartPosition.Manual,
      Location = new Point(70, 60), Size = new Size(470, 350),
      BackColor = Color.Cyan, TopMost = true
    };
    int phase = 0;
    var clock = Stopwatch.StartNew();
    var timer = new System.Windows.Forms.Timer { Interval = 35 };
    var sample = new Point();
    timer.Tick += (sender, args) => {
      DwmFlush();
      if (phase == 0) {
        sample = target.PointToScreen(new Point(target.ClientSize.Width / 2, target.ClientSize.Height / 2));
        if (Marker(sample, Color.FromArgb(128, 0, 128))) {
          phase = 1;
          target.TopMost = false;
          cover.Show();
          cover.Activate();
        }
      } else if (phase == 1 && Marker(sample, Color.Cyan)
          && GetForegroundWindow() == cover.Handle) {
        phase = 2;
        timer.Stop();
        Console.Out.WriteLine("READY " + target.Handle.ToInt64() + " " +
            cover.Handle.ToInt64() + " " + sample.X + " " + sample.Y);
        Console.Out.Flush();
      }
      if (phase != 2 && clock.ElapsedMilliseconds >= 8000) {
        timer.Stop();
        Console.Out.WriteLine("ERROR owned fixture marker not painted/occluded phase=" + phase +
            " targetVisible=" + target.Visible + " coverVisible=" + cover.Visible +
            " foregroundIsCover=" + (GetForegroundWindow() == cover.Handle));
        Console.Out.Flush();
        cover.Close();
        target.Close();
      }
    };
    target.Shown += (sender, args) => { target.Activate(); timer.Start(); };
    var inputThread = new Thread(() => {
      string command;
      while (true) {
        command = Console.ReadLine();
        // The pipe writer is owned exclusively by the current test process
        // incarnation. A native AV closes it without invoking Rust Drop.
        // EOF therefore revokes this fixture's right to keep its windows open.
        if (command == null) Environment.Exit(1);
        string item = command;
        try {
          target.BeginInvoke(new Action(() => {
            if (item == "report") {
              Console.Out.WriteLine("FOREGROUND " + GetForegroundWindow().ToInt64());
            } else if (item == "minimize") {
              target.WindowState = FormWindowState.Minimized;
              Console.Out.WriteLine("MINIMIZED");
            } else if (item == "close" || item == "quit") {
              cover.Close();
              target.Close();
              Console.Out.WriteLine("CLOSED");
            } else {
              Console.Out.WriteLine("ERROR unknown command");
            }
            Console.Out.Flush();
          }));
        } catch (InvalidOperationException) { break; }
        if (item == "close" || item == "quit") break;
      }
    });
    inputThread.IsBackground = true;
    inputThread.Start();
    Application.Run(target);
    timer.Stop();
    cover.Dispose();
    target.Dispose();
  }
}
'@
[CosWgcOwnedFixture]::Run($ProbeProcessId)
