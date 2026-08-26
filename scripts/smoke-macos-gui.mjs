import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

if (process.platform !== 'darwin') {
  throw new Error(`smoke-macos-gui.mjs must run on macOS, got ${process.platform}`);
}

const arch = process.argv[2];
if (arch !== 'x64' && arch !== 'arm64') throw new Error(`Expected x64 or arm64, got ${arch ?? '(missing)'}`);
const unpackedDir = arch === 'arm64' ? 'mac-arm64' : 'mac';
const executable = path.resolve(
  'release',
  unpackedDir,
  'Chat On Steroids.app',
  'Contents',
  'MacOS',
  'Chat On Steroids'
);
if (!existsSync(executable)) throw new Error(`Could not find unpacked macOS ${arch} app executable`);

const child = spawn(executable, [], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CLF_DEBUG: '1' }
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

let exitResult;
const exitPromise = new Promise((resolve) => {
  child.once('exit', (code, signal) => {
    exitResult = { code, signal };
    resolve(exitResult);
  });
});

const startedAt = Date.now();
const startupDeadlineMs = 15_000;
const minimumSurvivalMs = 10_000;

let startupError = null;
try {
  await new Promise((resolve, reject) => {
  let settled = false;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearInterval(poll);
    clearTimeout(deadline);
    child.off('error', onError);
    child.off('exit', onExit);
    error ? reject(error) : resolve();
  };
  const onError = (error) => finish(error);
  const onExit = (code, signal) =>
    finish(new Error(`macOS GUI exited before startup proof completed: code=${code} signal=${signal}`));
  const startupFailure = () => {
    if (output.includes('[error] window failed to load')) return 'the BrowserWindow reported a load failure';
    if (output.includes('[error] renderer:')) return 'the renderer reported a console error';
    return null;
  };
  const ready = () =>
    output.includes('[info] app started') &&
    output.includes('[info] window loaded') &&
    output.includes('[info] renderer state ready') &&
    Date.now() - startedAt >= minimumSurvivalMs;

  child.on('error', onError);
  child.on('exit', onExit);
  const poll = setInterval(() => {
    const failure = startupFailure();
    if (failure) finish(new Error(`macOS GUI startup failed: ${failure}`));
    else if (ready()) finish();
  }, 50);
  const deadline = setTimeout(() => {
    const failure = startupFailure();
    if (failure) finish(new Error(`macOS GUI startup failed: ${failure}`));
    else if (ready()) finish();
    else finish(new Error('macOS GUI did not report app started, window loaded and renderer state ready within 15 seconds'));
  }, startupDeadlineMs);
  });
} catch (error) {
  startupError = error;
}

async function terminateChild() {
  if (exitResult) return true;
  child.kill('SIGTERM');
  let exited = await Promise.race([
    exitPromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000))
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    exited = await Promise.race([
      exitPromise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 3_000))
    ]);
  }
  return exited;
}

// Whether startup passed or failed, never leave an Electron child behind on the hosted runner.
// This tests launch readiness, not the application's own quit flow.
const exited = await terminateChild();
process.stdout.write(output);
if (startupError) {
  if (!exited) startupError.message += '; child also resisted SIGTERM/SIGKILL';
  throw startupError;
}
if (!exited) throw new Error('macOS GUI process did not terminate after SIGTERM/SIGKILL');
process.stdout.write(
  `macos-gui-startup-ok arch=${arch} exit=${exitResult?.code ?? 'null'} signal=${exitResult?.signal ?? 'null'}\n`
);
