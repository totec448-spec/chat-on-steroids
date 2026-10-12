/**
 * Opt-in speech-to-text for Windows. It uses Windows' own dictation engine
 * (Windows.Media.SpeechRecognition, which Windows runs online when the person's
 * "Online speech recognition" setting is on), else the offline System.Speech
 * recognizer. CoS saves no audio and sends none anywhere; only recognized text
 * reaches our own renderer.
 *
 * This process is spawned only when the user clicks the microphone. The child
 * event loop never reads stdin (a synchronous Windows Console reader can block
 * recognition events). It watches the owning app PID so a crash or forced quit
 * cannot leave the microphone listening; only an explicit Stop allows grace.
 */
import { app, ipcMain, type BrowserWindow, type WebContents } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DictationEvent } from '../shared/dictation.js';
import { parseDictationEvent } from '../shared/dictation.js';

const SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  '$cosParentPid = __COS_PARENT_PID__',
  "$cosStopFile = '__COS_STOP_FILE__'",
  "function Send([string]$type,[string]$value,[string]$engine) {",
  "  $data = if($type -eq 'status') { @{type='status';status=$value} } elseif($type -eq 'error') { @{type='error';message=$value} } else { @{type=$type;text=$value} }",
  '  if($engine) { $data.engine = $engine }',
  '  [Console]::Out.WriteLine(($data | ConvertTo-Json -Compress -Depth 3))',
  '  [Console]::Out.Flush()',
  '}',
  'function Inner($e) { while($e.InnerException) { $e = $e.InnerException }; $e }',
  'function Await($operation) { ([System.WindowsRuntimeSystemExtensions]::AsTask($operation)).Wait(-1) | Out-Null }',
  "function Explain([string]$why) {",
  "  if($why -eq 'MicrophoneUnavailable') { 'No microphone is available. Connect one, or allow microphone access in Windows settings.' }",
  "  elseif($why -eq 'NetworkFailure') { 'Windows speech recognition lost its internet connection.' }",
  "  elseif($why -eq 'AudioQualityFailure') { 'The microphone signal was too poor to recognize speech.' }",
  "  else { 'Windows speech recognition stopped unexpectedly.' }",
  '}',
  '$recognizer = $null',
  '$session = $null',
  '$legacy = $null',
  '$engine = $null',
  '$stopping = $false',
  'try {',
  "  if(-not (Get-Process -Id $cosParentPid -ErrorAction SilentlyContinue)) { exit 0 }",
  '  # BEGIN recognizer',
  // Windows' own dictation engine: online, current accuracy, with punctuation. It needs the
  // person's "Online speech recognition" setting; without it, or on Windows builds without
  // the engine, the offline System.Speech recognizer below still listens, and says so.
  '  try {',
  '    Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '    $null = [Windows.Media.SpeechRecognition.SpeechRecognizer,Windows.Media.SpeechRecognition,ContentType=WindowsRuntime]',
  "    $asTask = @([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  '    $recognizer = [Windows.Media.SpeechRecognition.SpeechRecognizer]::new()',
  "    $recognizer.Constraints.Add([Windows.Media.SpeechRecognition.SpeechRecognitionTopicConstraint]::new([Windows.Media.SpeechRecognition.SpeechRecognitionScenario]::Dictation, 'dictation'))",
  '    $compile = $asTask.MakeGenericMethod([Windows.Media.SpeechRecognition.SpeechRecognitionCompilationResult]).Invoke($null, @($recognizer.CompileConstraintsAsync()))',
  '    $compile.Wait(-1) | Out-Null',
  "    if([string]$compile.Result.Status -ne 'Success') { throw ('Dictation is not available: ' + $compile.Result.Status) }",
  '    $session = $recognizer.ContinuousRecognitionSession',
  '    $session.AutoStopSilenceTimeout = [TimeSpan]::FromMinutes(10)',
  "    $null = Register-ObjectEvent -InputObject $session -EventName ResultGenerated -SourceIdentifier 'CoSDictationFinal'",
  "    $null = Register-ObjectEvent -InputObject $recognizer -EventName HypothesisGenerated -SourceIdentifier 'CoSDictationPartial'",
  "    $null = Register-ObjectEvent -InputObject $session -EventName Completed -SourceIdentifier 'CoSDictationDone'",
  '    Await $session.StartAsync()',
  "    $engine = 'modern'",
  "    Send 'status' 'listening' 'modern'",
  '  } catch {',
  '    $hr = (Inner $_.Exception).HResult',
  "    foreach($id in 'CoSDictationFinal','CoSDictationPartial','CoSDictationDone') { Unregister-Event -SourceIdentifier $id -ErrorAction SilentlyContinue }",
  '    if($recognizer) { $recognizer.Dispose() }',
  '    $recognizer = $null; $session = $null',
  // 0x80070005: Windows blocks microphone access for desktop apps. The fallback would hit the
  // same wall, so the person learns where to allow it. 0x80045509 (online speech recognition
  // turned off) and anything else fall back.
  "    if($hr -eq 0x80070005) { throw 'Windows blocks microphone access for desktop apps. Allow it in Windows settings.' }",
  '  }',
  '  if(-not $engine) {',
  '    Add-Type -AssemblyName System.Speech',
  '    $available = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())',
  "    if($available.Count -eq 0) { throw 'No Windows speech recognizer is installed. Install a Windows speech language pack.' }",
  '    $culture = [System.Globalization.CultureInfo]::CurrentUICulture',
  '    $choice = $available | Where-Object { $_.Culture.Name -eq $culture.Name } | Select-Object -First 1',
  '    if(-not $choice) { $choice = $available | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq $culture.TwoLetterISOLanguageName } | Select-Object -First 1 }',
  '    if(-not $choice) { $choice = $available[0] }',
  '    $legacy = [System.Speech.Recognition.SpeechRecognitionEngine]::new($choice)',
  '    $legacy.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())',
  "    try { $legacy.SetInputToDefaultAudioDevice() } catch { throw 'No microphone is available. Connect one, or allow microphone access in Windows settings.' }",
  "    $null = Register-ObjectEvent -InputObject $legacy -EventName SpeechRecognized -SourceIdentifier 'CoSDictationFinal'",
  "    $null = Register-ObjectEvent -InputObject $legacy -EventName SpeechHypothesized -SourceIdentifier 'CoSDictationPartial'",
  "    $null = Register-ObjectEvent -InputObject $legacy -EventName RecognizeCompleted -SourceIdentifier 'CoSDictationDone'",
  '    $legacy.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)',
  "    $engine = 'legacy'",
  "    Send 'status' 'listening' 'legacy'",
  '  }',
  '  # END recognizer',
  '  while($true) {',
  '    $item = Wait-Event -Timeout 1',
  '    if(-not (Get-Process -Id $cosParentPid -ErrorAction SilentlyContinue)) { break }',
  // Stop: the recognizer finishes the phrase in progress and reports it before it ends.
  '    if(-not $stopping -and (Test-Path -LiteralPath $cosStopFile)) {',
  '      $stopping = $true',
  "      if($engine -eq 'modern') { try { Await $session.StopAsync() } catch { break } }",
  "      elseif($engine -eq 'legacy') { $legacy.RecognizeAsyncStop() }",
  '      else { break }',
  '    }',
  '    if(-not $item) { continue }',
  '    $done = $false',
  '    try {',
  '      $e = $item.SourceEventArgs',
  "      if($item.SourceIdentifier -eq 'CoSDictationFinal') {",
  '        $result = $e.Result',
  "        $usable = $result -and -not [string]::IsNullOrWhiteSpace($result.Text) -and ($engine -ne 'modern' -or ([string]$result.Status -eq 'Success' -and [string]$result.Confidence -ne 'Rejected'))",
  "        if($usable) { Send 'final' $result.Text }",
  "      } elseif($item.SourceIdentifier -eq 'CoSDictationPartial') {",
  "        $text = if($engine -eq 'modern') { $e.Hypothesis.Text } else { $e.Result.Text }",
  "        if(-not [string]::IsNullOrWhiteSpace($text)) { Send 'partial' $text }",
  "      } elseif($item.SourceIdentifier -eq 'CoSDictationDone') {",
  '        $done = $true',
  "        if($engine -eq 'modern') { $why = [string]$e.Status; if(@('Success','UserCanceled','TimeoutExceeded','PauseLimitExceeded') -notcontains $why) { Send 'error' (Explain $why) } }",
  "        elseif($e.Error) { Send 'error' $e.Error.Message }",
  '      }',
  '    } finally { Remove-Event -EventIdentifier $item.EventIdentifier -ErrorAction SilentlyContinue }',
  '    if($done) { break }',
  '  }',
  "} catch { Send 'error' $_.Exception.Message }",
  'finally {',
  "  foreach($id in 'CoSDictationFinal','CoSDictationPartial','CoSDictationDone') { Unregister-Event -SourceIdentifier $id -ErrorAction SilentlyContinue }",
  '  if($session -and -not $stopping) { try { ([System.WindowsRuntimeSystemExtensions]::AsTask($session.CancelAsync())).Wait(2000) | Out-Null } catch { } }',
  '  if($recognizer) { $recognizer.Dispose() }',
  '  if($legacy) { try { $legacy.RecognizeAsyncCancel() } catch { }; $legacy.Dispose() }',
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
  /** Created on Stop; the recognizer polls for it, then finishes the phrase in progress. */
  stopFile: string;
};

/** Time the recognizer gets to report the last phrase after Stop before it is ended. */
const STOP_GRACE_MS = 4_000;

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
    try { fs.writeFileSync(row.stopFile, ''); } catch { /* The grace timer still ends it. */ }
    row.killTimeout = setTimeout(() => {
      if (active === row) row.child.kill();
    }, STOP_GRACE_MS);
    row.killTimeout.unref();
  };

  app.once('before-quit', () => {
    if (!active) return;
    // An unref'ed Stop grace timer cannot be relied on once Electron quits.
    // Terminate the child synchronously; the PID watcher covers app crashes.
    active.stopping = true;
    if (active.killTimeout) {
      clearTimeout(active.killTimeout);
      active.killTimeout = null;
    }
    active.child.kill();
    fs.rmSync(active.stopFile, { force: true });
  });
  ipcMain.handle('dictation:start', async event => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents)
      return { ok: false as const, error: 'Dictation can only start from the CoS window' };
    if (process.platform !== 'win32')
      return { ok: false as const, error: 'Microphone dictation currently requires Windows' };
    if (active)
      return { ok: false as const, error: 'Dictation is already running' };
    const stopFile = path.join(os.tmpdir(), `cos-dictation-${process.pid}-${randomUUID()}.stop`);
    const script = SCRIPT.replace('__COS_PARENT_PID__', String(process.pid))
      .replace('__COS_STOP_FILE__', () => stopFile.replaceAll("'", "''"));
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive',
        '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      return { ok: false as const, error: 'Could not launch the Windows speech recognizer' };
    }
    const row: OwnedProcess = { child, owner: event.sender, stopping: false, lineBuffer: '', killTimeout: null, stopFile };
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
      fs.rmSync(row.stopFile, { force: true });
      if (!row.stopping) send(row, { type: 'error', message: 'Windows speech recognition could not start' });
      if (active === row) {
        if (row.killTimeout) clearTimeout(row.killTimeout);
        send(row, { type: 'status', status: 'stopped' });
        active = null;
      }
    });
    child.once('exit', (code, signal) => {
      if (row.killTimeout) clearTimeout(row.killTimeout);
      fs.rmSync(row.stopFile, { force: true });
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
