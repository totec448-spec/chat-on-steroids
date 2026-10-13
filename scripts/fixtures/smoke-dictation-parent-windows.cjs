// Windows smoke test for the real PowerShell recognizer script, without any microphone.
// Run: node scripts/fixtures/smoke-dictation-parent-windows.cjs
//
// 1. The whole production script parses in Windows PowerShell, and its C# recognizer compiles.
// 2. With the recognizer setup cut out, the real event loop exits and reports "stopped" when
//    its parent PID disappears, and again when Stop's file appears.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync, spawn } = require('node:child_process');

if (process.platform !== 'win32') {
  console.log('Skipped: Windows PowerShell required');
  process.exit(0);
}

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/main/dictation.ts'), 'utf8');
const embedded = source.match(/const SCRIPT = (\[[\s\S]*?\])\.join\('\\r\\n'\)/);
if (!embedded) throw new Error('Could not locate the production recognizer script');
const original = vm.runInNewContext(embedded[1], Object.create(null)).join('\r\n');
const encode = script => Buffer.from(script, 'utf16le').toString('base64');

// 1. Syntax of the full script, as PowerShell itself reads it.
const scriptFile = path.join(os.tmpdir(), `cos-dictation-smoke-${process.pid}.ps1`);
fs.writeFileSync(scriptFile, '﻿' + original, 'utf8');
try {
  const parse = "$errors = $null; $tokens = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:COS_SMOKE_SCRIPT, [ref]$tokens, [ref]$errors); " +
    "if($errors.Count) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.ToString()) }; exit 1 }";
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encode(parse)], {
    env: { ...process.env, COS_SMOKE_SCRIPT: scriptFile }, encoding: 'utf8', timeout: 15_000
  });
} finally { fs.rmSync(scriptFile, { force: true }); }

// 1b. The C# recognizer compiles against this Windows' own metadata (what runs before any audio).
const definitions = original.slice(0, original.indexOf('\r\n$modern = $false'));
if (!definitions.includes('function CompileRecognizer')) throw new Error('Recognizer definitions not found');
const compiledOutput = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
  encode(definitions.replace('__COS_PARENT_PID__', String(process.pid)) + "\r\nCompileRecognizer\r\n'compiled'")], { encoding: 'utf8', timeout: 30_000 });
if (!compiledOutput.includes('compiled')) throw new Error('The recognizer did not compile: ' + compiledOutput.slice(-500));

// 2. Substitute only the recognizer setup. The real while/Wait-Event loop, parent-PID check,
// Stop file check, cleanup/finally and stdout status are unchanged.
function loopScript(parentPid, stopFile) {
  const script = original.replace(/  # BEGIN recognizer[\s\S]*?  # END recognizer\r\n/,
    "  $engine = 'fixture'\r\n  Send 'status' 'listening'\r\n")
    .replace('__COS_PARENT_PID__', String(parentPid)).replace('__COS_STOP_FILE__', () => stopFile.replaceAll("'", "''"));
  if (script === original || script.includes('__COS_') || script.includes('SetInputToDefaultAudioDevice') ||
      script.includes('[CosDictation]::Start()') || script.includes('RecognizeAsync(') || !script.includes('Wait-Event -Timeout 1') ||
      !script.includes('Get-Process -Id $cosParentPid') || !script.includes('Test-Path -LiteralPath $cosStopFile')) {
    throw new Error('Unsafe or invalid recognizer-loop smoke script');
  }
  return script;
}

function run(name, onListening) {
  return new Promise(resolve => {
    const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
    if (!parent.pid) throw new Error('Failed to launch the parent process fixture');
    const stopFile = path.join(os.tmpdir(), `cos-dictation-smoke-${process.pid}-${name}.stop`);
    fs.rmSync(stopFile, { force: true });
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive',
      '-EncodedCommand', encode(loopScript(parent.pid, stopFile))], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '', stderr = '', listened = false, acted = false, stopped = false;
    const finish = ok => { clearTimeout(timer); parent.kill(); fs.rmSync(stopFile, { force: true }); resolve(ok); };
    const timer = setTimeout(() => {
      child.kill();
      console.error(`FAIL (${name}): PowerShell did not exit`);
      finish(false);
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
        if (event.type === 'status' && event.status === 'listening' && !acted) {
          listened = true;
          acted = onListening({ parent, stopFile });
        }
        if (event.type === 'status' && event.status === 'stopped') stopped = true;
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2048); });
    child.once('error', error => { console.error(error); finish(false); });
    child.once('exit', (code, signal) => {
      const ok = listened && acted && stopped && code === 0 && !signal;
      if (!ok) console.error(`FAIL (${name})`, { listened, acted, stopped, code, signal, stderr });
      finish(ok);
    });
  });
}

(async () => {
  const parentGone = await run('parent', ({ parent }) => parent.kill());
  const stopAsked = await run('stop', ({ stopFile }) => { fs.writeFileSync(stopFile, ''); return true; });
  if (parentGone && stopAsked) {
    console.log('PASS: the recognizer script parses and its C# engine compiles; its loop exits and reports stopped when its parent disappears and on Stop (no microphone used)');
  } else {
    process.exitCode = 1;
  }
})();
