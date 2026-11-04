import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const watchdog = fileURLToPath(new URL('../scripts/fixtures/snap-chromium-watchdog.cjs', import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it.runIf(process.platform === 'linux')('retires only its own Snap profile and browser after a forced verifier SIGKILL', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'cos-snap-watchdog-test-'));
  const verifierCode = `
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const { spawn } = require('node:child_process');
    const root = path.join(os.homedir(), 'snap/chromium/common');
    fs.mkdirSync(root, { recursive: true });
    const profile = fs.mkdtempSync(path.join(root, 'cos-shell-runtime-'));
    require(${JSON.stringify(watchdog)}).startSnapProfileWatchdog(profile);
    // This helper stands in for Chromium: only this unique test profile can
    // identify it, and SIGKILL of the verifier leaves it orphaned.
    const browser = spawn(process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', '--', '--user-data-dir=' + profile],
      { detached: true, stdio: 'ignore' });
    browser.unref();
    console.log(JSON.stringify({ profile, browserPid: browser.pid }));
    setInterval(() => {}, 1000);
  `;
  const verifier = spawn(process.execPath, ['-e', verifierCode], {
    env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let browserPid: number | undefined;
  try {
    const { profile, browserPid: pid } = await new Promise<{ profile: string; browserPid: number }>((resolve, reject) => {
      let stdout = '', stderr = '';
      const timer = setTimeout(() => reject(new Error('Verifier did not start: ' + stderr)), 5000);
      verifier.stderr.on('data', chunk => { stderr += String(chunk); });
      verifier.stdout.on('data', chunk => {
        stdout += String(chunk);
        const newline = stdout.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(stdout.slice(0, newline))); } catch (error) { reject(error); }
      });
      verifier.once('exit', () => { clearTimeout(timer); reject(new Error('Verifier exited before reporting its profile: ' + stderr)); });
    });
    browserPid = pid;
    expect(profile).toMatch(/cos-shell-runtime-/);
    expect(existsSync(profile)).toBe(true);
    expect(readFileSync(`/proc/${pid}/cmdline`, 'utf8')).toContain(`--user-data-dir=${profile}`);
    const exited = once(verifier, 'exit');
    verifier.kill('SIGKILL'); // Exactly what verify-ui.mjs does on timeout.
    await exited;
    let removed = false;
    for (let i = 0; i < 160; i++) {
      if (!existsSync(profile)) { removed = true; break; }
      await sleep(50);
    }
    expect(removed, 'watchdog must delete the private profile even after SIGKILL').toBe(true);
    // The watchdog also sends TERM/KILL to the process with the exact profile.
    let stillRunning = false;
    try {
      const cmdline = readFileSync(`/proc/${browserPid}/cmdline`, 'utf8');
      stillRunning = cmdline.includes(`--user-data-dir=${profile}`);
    } catch { /* exited, already reaped */ }
    expect(stillRunning, 'orphaned Chromium must not continue using the profile').toBe(false);
  } finally {
    verifier.kill('SIGKILL');
    if (browserPid) { try { process.kill(browserPid, 'SIGKILL'); } catch { /* already gone */ } }
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000);
