// Windows smoke test for the real PowerShell PID-watcher loop, without any microphone.
// Run: node scripts/fixtures/smoke-dictation-parent-windows.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

if (process.platform !== 'win32') {
  console.log('Skipped: Windows PowerShell required');
  process.exit(0);
}

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/main/dictation.ts'), 'utf8');
const embedded = source.match(/const SCRIPT = (\[[\s\S]*?\])\.join\('\\r\\n'\)/);
if (!embedded) throw new Error('Could not locate the production recognizer script');
const original = vm.runInNewContext(embedded[1], Object.create(null)).join('\r\n');
const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
  windowsHide: true, stdio: 'ignore'
});
if (!parent.pid) throw new Error('Failed to launch the parent process fixture');

// Substitute only the hardware recognizer setup. The real while/Wait-Event
// loop, parent-PID check, cleanup/finally and stdout status are unchanged.
const script = original.replace(/  Add-Type -AssemblyName System\.Speech[\s\S]*?(?=  while\(\$true\) \{)/,
  "  Send 'status' 'listening'\r\n").replace('__COS_PARENT_PID__', String(parent.pid));
if (script === original || script.includes('__COS_PARENT_PID__') ||
    script.includes('SetInputToDefaultAudioDevice') ||
    !script.includes('Wait-Event -Timeout 1') ||
    !script.includes('Get-Process -Id $cosParentPid')) {
  parent.kill();
  throw new Error('Unsafe or invalid parent-watcher smoke script');
}

const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive',
  '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let buffer = '';
let stderr = '';
let listened = false;
let stopped = false;
let parentKilled = false;
const timer = setTimeout(() => {
  child.kill();
  parent.kill();
  console.error('FAIL: PowerShell did not exit after its parent disappeared');
  process.exitCode = 1;
}, 8000);
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'status' && event.status === 'listening' && !parentKilled) {
      listened = true;
      parentKilled = parent.kill();
    }
    if (event.type === 'status' && event.status === 'stopped') stopped = true;
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2048); });
child.once('error', error => {
  clearTimeout(timer);
  parent.kill();
  console.error(error);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  clearTimeout(timer);
  parent.kill();
  if (!listened || !parentKilled || !stopped || code !== 0 || signal) {
    console.error('FAIL: parent-watch smoke', { listened, parentKilled, stopped, code, signal, stderr });
    process.exitCode = 1;
  } else {
    console.log('PASS: PowerShell exited and released its resources after its parent PID disappeared (no microphone used)');
  }
});
