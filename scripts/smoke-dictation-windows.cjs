// Uses synthesized speech WAV instead of the physical microphone.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

if (process.platform !== 'win32') {
  console.log('Skipped: Windows recognizer only');
  process.exit(0);
}
const root = path.resolve(__dirname, '..');
const wave = process.argv[2] ?? path.join(root, 'outputs', 'cos-dictation-synthetic-es.wav');
if (!fs.existsSync(wave)) throw new Error('Synthetic WAV file not found');
const source = fs.readFileSync(path.join(root, 'src', 'main', 'dictation.ts'), 'utf8');
const embedded = source.match(/const SCRIPT = (\[[\s\S]*?\])\.join\('\\r\\n'\)/);
if (!embedded) throw new Error('Recognizer script missing');
const lines = vm.runInNewContext(embedded[1], Object.create(null));
const original = lines.join('\r\n');
// A WAV file can only feed the offline System.Speech fallback, so the modern engine is skipped.
const script = original
  .replace('\r\n    CompileRecognizer\r\n', "\r\n    throw 'A synthetic WAV uses the offline engine'\r\n")
  .replace('$legacy.SetInputToDefaultAudioDevice()', () => "$legacy.SetInputToWaveFile('" + wave.replace(/'/g, "''") + "')")
  .replace('__COS_PARENT_PID__', String(process.pid))
  .replace('__COS_STOP_FILE__', () => path.join(require('node:os').tmpdir(), `cos-dictation-wav-${process.pid}.stop`));
if (!script.includes('SetInputToWaveFile') || !script.includes("throw 'A synthetic WAV") || script.includes('__COS_')) {
  throw new Error('Synthetic WAV was not substituted');
}
const child = spawn('powershell.exe', [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
  Buffer.from(script, 'utf16le').toString('base64')
], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const messages = [];
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', value => {
  stdout += value;
  let index;
  while ((index = stdout.indexOf('\n')) >= 0) {
    const line = stdout.slice(0, index).trim();
    stdout = stdout.slice(index + 1);
    if (line) {
      try { messages.push(JSON.parse(line)); }
      catch { messages.push({ type: 'invalid', line }); }
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });
const timer = setTimeout(() => child.kill(), 12_000);
const stopper = setTimeout(() => { child.kill(); }, 8_000);
child.once('exit', (code, signal) => {
  clearTimeout(timer);
  clearTimeout(stopper);
  console.log(messages.map(e => e.type + ':' + (e.status ?? e.text ?? e.message)).join('\n'));
  if (stderr.trim()) console.log('PowerShell stderr:', stderr.trim().slice(0, 4000));
  if (!messages.some(e => e.type === 'status' && e.status === 'listening') ||
    !messages.some(e => e.type === 'final' && e.text) ||
    messages.some(e => e.type === 'error' || e.type === 'invalid')) {
    process.exitCode = 1;
  } else {
    console.log('Synthetic speech recognition PASS (no microphone accessed)');
  }
});
