// Own one UI check, its process tree and the deadline for releasing the runner.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const KILL_WAIT_MS = 1000;
const CLOSE_WAIT_MS = 1000;

/** Only called for the PID/group this runner spawned; never enumerates unrelated processes. */
export function terminateCheckTree(pid, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('UI check has no process to terminate');
  if (platform === 'win32') {
    const taskkill = path.win32.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'taskkill.exe');
    // Like the app's process owner: use the absolute helper and bound the helper itself.
    const result = spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true, stdio: 'ignore', timeout: KILL_WAIT_MS, killSignal: 'SIGKILL'
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 128) throw new Error(`UI check tree termination exited with ${result.status}`);
  } else {
    // detached below creates a group just for this check, including Electron helpers.
    try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export function runUiCheck(command, args, { cwd, env, timeoutMs, profile }) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd, env: profile ? { ...env, COS_TERMINAL_CHECK_PROFILE: profile.path } : env,
      windowsHide: true, detached: process.platform !== 'win32'
    });
    let output = '', unhandled = false, timedOut = false, settled = false, closed = false, treeStopped = false;
    let timer, closeTimer;
    const keep = chunk => { unhandled ||= /UnhandledPromiseRejection/.test(String(chunk)); output = (output + chunk).slice(-4000); };
    const killOnRunnerExit = () => {
      if (closed) return;
      console.error('UI runner exiting; stopping the active check process tree.');
      try { terminateCheckTree(child.pid); }
      catch (error) {
        console.error('UI runner exit cleanup failed:', error);
        try { profile?.markChild(null); } catch (error) { console.error(error); }
      }
    };
    const removeExitHandlers = () => {
      process.removeListener('exit', killOnRunnerExit);
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
    };
    const stopOnSignal = code => {
      removeExitHandlers();
      killOnRunnerExit();
      process.exit(code);
    };
    const onInterrupt = () => stopOnSignal(130);
    const onTerminate = () => stopOnSignal(143);
    process.once('exit', killOnRunnerExit);
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    const finish = code => {
      if (settled) return;
      settled = true;
      removeExitHandlers();
      clearTimeout(timer); clearTimeout(closeTimer);
      // A timeout is not proof of process exit. Keep uncertain profiles and mark the
      // child unknown so a future stale-profile sweep cannot remove an active tree.
      if (closed && (!timedOut || treeStopped)) {
        try { profile?.cleanup(); } catch (error) { keep(String(error)); code = 'profile cleanup failed'; }
      } else if (profile) {
        keep('\nUI profile retained: check process-tree exit was not confirmed.');
        try { profile.markChild(null); } catch (error) { keep(String(error)); }
      }
      if (!closed) {
        keep('\nUI check close deadline reached; releasing inherited output pipes.');
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
      }
      resolve({ code, output });
    };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('error', error => keep(String(error)));
    child.on('close', (code, signal) => {
      closed = true;
      finish(timedOut ? 'timeout' : code === 0 && unhandled ? 'unhandled rejection' : code ?? `signal ${signal}`);
    });
    timer = setTimeout(() => {
      timedOut = true;
      keep('\nUI check timed out; terminating its owned process tree.');
      try { terminateCheckTree(child.pid); treeStopped = true; }
      catch (error) { keep(`\nUI check tree termination failed: ${error}`); child.kill('SIGKILL'); }
      // Even a failed tree kill or a leaked inherited pipe must not stall later checks.
      closeTimer = setTimeout(() => finish('timeout'), CLOSE_WAIT_MS);
    }, timeoutMs);
    profile?.markChild(child.pid);
  });
}
