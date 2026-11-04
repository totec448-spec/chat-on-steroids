// The shell-runtime fixture can be SIGKILLed by verify-ui's timeout. Its
// Chromium profile must still be retired when the verifier's finally cannot run.
// Linux/Snap only: a detached watcher follows the exact parent PID + start time.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const snapRoot = () => path.join(os.homedir(), 'snap/chromium/common');

function procInfo(pid) {
  try {
    // /proc/<pid>/stat fields start at #3 after the comm (which may contain spaces).
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
    return { state: fields[0], start: fields[19] }; // #3 state, #22 starttime
  } catch { return null; }
}

function verifyProfile(profile) {
  if (path.dirname(profile) !== snapRoot() || !/^cos-shell-runtime-[\w-]+$/.test(path.basename(profile))) {
    throw new Error('Refusing to clean an unrelated Chromium profile');
  }
}

function chromiumWithProfile(profile) {
  const argument = `--user-data-dir=${profile}`;
  let entries;
  try { entries = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)); }
  catch { return []; }
  return entries.map(Number).filter(pid => {
    if (pid === process.pid) return false;
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(argument); }
    catch { return false; }
  });
}

async function retire(profile) {
  // This is an exclusively test-owned mkdtemp profile, never a normal Snap profile.
  for (const pid of chromiumWithProfile(profile)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* process already exited */ }
  }
  for (let n = 0; n < 15 && chromiumWithProfile(profile).length; n++) await sleep(100);
  for (const pid of chromiumWithProfile(profile)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* process already exited */ }
  }
  // The snap launcher and children can briefly write caches after closing.
  for (let n = 0; n < 12; n++) {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); return; }
    catch (error) { if (n === 11) throw error; await sleep(250); }
  }
}

function startSnapProfileWatchdog(profile) {
  verifyProfile(profile);
  const start = procInfo(process.pid)?.start;
  if (!start) throw new Error('Cannot establish verifier process identity');
  // Unref before starting the browser. Even SIGKILL of this verifier leaves the
  // watcher alive; it checks the start time to avoid a recycled PID.
  const watcher = spawn(process.execPath, [__filename, profile, String(process.pid), start],
    { detached: true, stdio: 'ignore', windowsHide: true });
  if (!watcher.pid) throw new Error('Could not start the Snap profile watchdog');
  watcher.unref();
}

if (require.main === module) {
  const [profile, rawPid, parentStart] = process.argv.slice(2);
  verifyProfile(profile);
  const pid = Number(rawPid);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !parentStart) process.exit(2);
  const poll = setInterval(() => {
    const parent = procInfo(pid);
    if (parent && parent.start === parentStart && parent.state !== 'Z') return;
    clearInterval(poll);
    void retire(profile).then(() => process.exit(0), () => process.exit(1));
  }, 200);
}

module.exports = { startSnapProfileWatchdog };
