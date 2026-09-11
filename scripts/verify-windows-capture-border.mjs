/** Opt-in visual regression: node scripts/verify-windows-capture-border.mjs
 * Requires an unlocked Windows 11 desktop; briefly shows one owned test window.
 * The control deliberately displays the border so a blind probe cannot pass. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

if (process.platform !== 'win32') throw new Error('This visual check requires Windows 11.');
const { outputFiles } = await build({ entryPoints: ['src/main/computer/windows-capture.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { WINDOWS_CAPTURE_BOOTSTRAP } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const directory = await mkdtemp(path.join(tmpdir(), 'cos-border-probe-'));
async function probe(mode) {
  let source = WINDOWS_CAPTURE_BOOTSTRAP;
  if (mode === 'control') source = source.replace('border.IsBorderRequired = false;', 'border.IsBorderRequired = true;');
  // Model an older host's E_NOINTERFACE without requiring older WinMetadata.
  if (mode === 'unsupported-interface') source = source.replace('F2CDD966-22AE-5EA1-9596-3A289344C3BE', '40571B05-C4F0-478E-B8A4-9B97D672516E');
  // Keep the real capture alive briefly to sample the compositor's border. Export
  // only a yellow-pixel count from the owned fixture's top edge, never user pixels.
  const bootstrap = source.replace('session.StartCapture();', `session.StartCapture();
      int yellow = 0;
      for (int sample = 0; sample < 35; sample++) {
        Thread.Sleep(15);
        using (var strip = new Bitmap(width, 12)) {
          using (var graphics = Graphics.FromImage(strip)) graphics.CopyFromScreen(bounds.Left, bounds.Top - 6, 0, 0, strip.Size);
          int count = 0;
          for (int y = 0; y < strip.Height; y++) for (int x = 0; x < strip.Width; x++) {
            var color = strip.GetPixel(x, y);
            if (color.R > 180 && color.G > 140 && color.B < 100) count++;
          }
          yellow = Math.Max(yellow, count);
        }
      }
      Console.WriteLine("BORDER_YELLOW_PIXELS=" + yellow);`);
  const script = path.join(directory, 'probe.ps1');
  await writeFile(script, `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
public class BorderFixture : System.Windows.Forms.Form {
  [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
  protected override bool ShowWithoutActivation { get { return true; } }
}
'@
${bootstrap}
Initialize-WindowsCapture
$form = New-Object BorderFixture
$form.Text = 'COS capture border test'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(80,80)
$form.Size = New-Object System.Drawing.Size(360,240)
$form.BackColor = [System.Drawing.Color]::Purple
$form.TopMost = $true
try {
  $form.Show()
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 300
  $before = [BorderFixture]::GetForegroundWindow()
  [CosWindowsCapture]::Capture($form.Handle.ToInt64(), 320, (Join-Path $PSScriptRoot 'fixture.png'))
  if ([BorderFixture]::GetForegroundWindow() -ne $before) { throw 'Capture changed foreground' }
} finally { $form.Close(); $form.Dispose() }
`);
  const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, timeout: 15000 });
  const yellow = Number(result.stdout.match(/BORDER_YELLOW_PIXELS=(\d+)/)?.[1]);
  assert.ok(Number.isFinite(yellow), result.stdout);
  const { data, info } = await sharp(path.join(directory, 'fixture.png')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 320);
  const pixel = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  assert.deepEqual([...data.subarray(pixel, pixel + 3)], [128, 0, 128], 'Capture lost the fixture pixels');
  if (mode === 'production') assert.equal(yellow, 0, 'Production capture flashed the yellow border');
  else assert.ok(yellow > 300, `The ${mode} border was not observable; probe is inconclusive (${yellow})`);
  return { mode, yellowPixels: yellow, screenshotVerified: true, foregroundPreserved: true };
}
try {
  const results = [];
  for (const mode of ['control', 'production', 'unsupported-interface']) results.push(await probe(mode));
  console.log(JSON.stringify(results, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
