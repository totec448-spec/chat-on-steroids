/**
 * Opt-in speech-to-text for Windows. System.Speech uses the locally installed
 * desktop speech recognizer. No audio recordings are saved or forwarded to a
 * remote service by CoS; only recognition text is sent to our own renderer.
 *
 * This process is spawned only when the user clicks the microphone. The child
 * event loop never reads stdin (a synchronous Windows Console reader can block
 * recognition events). It watches the owning app PID so a crash or forced quit
 * cannot leave the microphone listening; only an explicit Stop allows grace.
 */
import { app, ipcMain, type BrowserWindow, type WebContents } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { DictationEvent } from '../shared/dictation.js';
import { parseDictationEvent } from '../shared/dictation.js';

const SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  '$cosParentPid = __COS_PARENT_PID__',
  "function Send([string]$type,[string]$value) {",
  "  $data = if($type -eq 'status') { @{type='status';status=$value} } elseif($type -eq 'error') { @{type='error';message=$value} } else { @{type=$type;text=$value} }",
  '  [Console]::Out.WriteLine(($data | ConvertTo-Json -Compress -Depth 3))',
  '  [Console]::Out.Flush()',
  '}',
  '$recognizer = $null',
  '$subFinal = $null',
  '$subPartial = $null',
  'try {',
  "  if(-not (Get-Process -Id $cosParentPid -ErrorAction SilentlyContinue)) { exit 0 }",
  '  Add-Type -AssemblyName System.Speech',
  '  $available = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())',
  "  if($available.Count -eq 0) { throw 'No Windows speech recognizer is installed. Install a Windows speech language pack.' }",
  '  $culture = [System.Globalization.CultureInfo]::CurrentUICulture',
  '  $choice = $available | Where-Object { $_.Culture.Name -eq $culture.Name } | Select-Object -First 1',
  '  if(-not $choice) { $choice = $available | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq $culture.TwoLetterISOLanguageName } | Select-Object -First 1 }',
  '  if(-not $choice) { $choice = $available[0] }',
  '  $recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::new($choice)',
  '  $recognizer.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())',
  '  $recognizer.SetInputToDefaultAudioDevice()',
  "  $subFinal = Register-ObjectEvent -InputObject $recognizer -EventName SpeechRecognized -SourceIdentifier 'CoSDictationFinal'",
  "  $subPartial = Register-ObjectEvent -InputObject $recognizer -EventName SpeechHypothesized -SourceIdentifier 'CoSDictationPartial'",
  '  $recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)',
  "  Send 'status' 'listening'",
  '  while($true) {',
  '    $item = Wait-Event -Timeout 1',
  '    if(-not (Get-Process -Id $cosParentPid -ErrorAction SilentlyContinue)) { break }',
  '    if(-not $item) { continue }',
  '    try {',
  '      $result = $item.SourceEventArgs.Result',
  '      if($result -and -not [string]::IsNullOrWhiteSpace($result.Text)) {',
  "        if($item.SourceIdentifier -eq 'CoSDictationFinal') { Send 'final' $result.Text }",
  "        elseif($item.SourceIdentifier -eq 'CoSDictationPartial') { Send 'partial' $result.Text }",
  '      }',
  '    } finally { Remove-Event -EventIdentifier $item.EventIdentifier -ErrorAction SilentlyContinue }',
  '  }',
  "  $recognizer.RecognizeAsyncCancel()",
  "} catch { Send 'error' $_.Exception.Message }",
  'finally {',
  '  if($subFinal) { Unregister-Event -SourceIdentifier CoSDictationFinal -ErrorAction SilentlyContinue }',
  '  if($subPartial) { Unregister-Event -SourceIdentifier CoSDictationPartial -ErrorAction SilentlyContinue }',
  '  if($recognizer) { $recognizer.Dispose() }',
  "  Send 'status' 'stopped'",
  '}',
  'exit 0'
].join('\r\n');

type OwnedProcess = {
  child: ChildProcessWithoutNullStreams;
  owner: WebContents;
  stopping: boolean;
  lineBuffer: string;
  killTimeout: NodeJS.Timeout | null;
};

/** Separate registration to keep the main IPC allowlist fixed and narrow. */
export function registerDictationIpc(getWindow: () => BrowserWindow | null): void {
  let active: OwnedProcess | null = null;

  const send = (row: OwnedProcess, event: DictationEvent): void => {
    const window = getWindow();
    if (active !== row || !window || window.isDestroyed() || window.webContents !== row.owner ||
      row.owner.isDestroyed()) return;
    row.owner.send('dictation:event', event);
  };
  const stop = (row: OwnedProcess): void => {
    if (row.stopping) return;
    row.stopping = true;
    row.killTimeout = setTimeout(() => {
      if (active === row) row.child.kill();
    }, 650);
    row.killTimeout.unref();
  };

  app.once('before-quit', () => {
    if (!active) return;
    // An unref'ed 650ms Stop timer cannot be relied on once Electron quits.
    // Terminate the child synchronously; the PID watcher covers app crashes.
    active.stopping = true;
    if (active.killTimeout) {
      clearTimeout(active.killTimeout);
      active.killTimeout = null;
    }
    active.child.kill();
  });
  ipcMain.handle('dictation:start', async event => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents)
      return { ok: false as const, error: 'Dictation can only start from the CoS window' };
    if (process.platform !== 'win32')
      return { ok: false as const, error: 'Microphone dictation currently requires Windows' };
    if (active)
      return { ok: false as const, error: 'Dictation is already running' };
    const script = SCRIPT.replace('__COS_PARENT_PID__', String(process.pid));
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive',
        '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      return { ok: false as const, error: 'Could not launch the Windows speech recognizer' };
    }
    const row: OwnedProcess = { child, owner: event.sender, stopping: false, lineBuffer: '', killTimeout: null };
    active = row;
    send(row, { type: 'status', status: 'starting' });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (active !== row) return;
      row.lineBuffer += chunk;
      if (row.lineBuffer.length > 32_768) { stop(row); return; }
      let index = row.lineBuffer.indexOf('\n');
      while (index >= 0) {
        const line = row.lineBuffer.slice(0, index).trim();
        row.lineBuffer = row.lineBuffer.slice(index + 1);
        const parsed = parseDictationEvent(line);
        if (parsed) send(row, parsed);
        index = row.lineBuffer.indexOf('\n');
      }
    });
    child.stderr.resume(); // Avoid a blocked stdout pipe; never log spoken text.
    child.once('error', () => {
      if (!row.stopping) send(row, { type: 'error', message: 'Windows speech recognition could not start' });
      if (active === row) {
        if (row.killTimeout) clearTimeout(row.killTimeout);
        send(row, { type: 'status', status: 'stopped' });
        active = null;
      }
    });
    child.once('exit', (code, signal) => {
      if (row.killTimeout) clearTimeout(row.killTimeout);
      if (active !== row) return;
      if (!row.stopping && code !== 0 && signal !== 'SIGTERM')
        send(row, { type: 'error', message: 'Windows speech recognition exited unexpectedly' });
      send(row, { type: 'status', status: 'stopped' });
      active = null;
    });
    event.sender.once('destroyed', () => { if (active === row) stop(row); });
    return { ok: true as const, data: { status: 'starting' as const } };
  });
  ipcMain.handle('dictation:stop', async event => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents)
      return { ok: false as const, error: 'Dictation is not owned by this window' };
    if (active) stop(active);
    return { ok: true as const, data: undefined };
  });
}
