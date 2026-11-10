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

/** A closed Windows root cannot identify its remaining descendants safely. */
export async function retireClosedCheckTree(pid, platform = process.platform, deadline = performance.now() + CLOSE_WAIT_MS) {
  if (platform === 'win32') return false;
  terminateCheckTree(pid, platform);
  for (;;) {
    try { process.kill(-pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    if (performance.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, Math.min(20, deadline - performance.now())));
  }
}

export function runUiCheck(command, args, { cwd, env, timeoutMs, profile, inheritStdio = false }) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd, env: profile ? { ...env, COS_TERMINAL_CHECK_PROFILE: profile.path } : env,
      windowsHide: true, detached: process.platform !== 'win32',
      stdio: inheritStdio ? 'inherit' : 'pipe'
    });
    let output = '', unhandled = false, timedOut = false, settled = false, closed = false, treeConfirmed = false;
    let timer, closeTimer, closeDeadline;
    const keep = chunk => { unhandled ||= /UnhandledPromiseRejection/.test(String(chunk)); output = (output + chunk).slice(-4000); };
    const killOnRunnerExit = () => {
      if (closed && treeConfirmed) return;
      // Never run taskkill against a dead/recycled root PID. POSIX can still stop
      // the owned group while asynchronous post-close confirmation is pending.
      if (closed && process.platform === 'win32') {
        try { profile?.markChild(null); } catch (error) { console.error(error); }
        return;
      }
      console.error('UI runner exiting; stopping the active check process tree.');
      try { terminateCheckTree(child.pid); }
      catch (error) {
        console.error('UI runner exit cleanup failed:', error);
      }
      // An exiting runner cannot wait for retirement, even after a successful kill.
      try { profile?.markChild(null); } catch (error) { console.error(error); }
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
    const finish = (code, canCleanup = false, reason = 'check process-tree exit was not confirmed.') => {
      if (settled) return;
      settled = true;
      treeConfirmed = canCleanup;
      removeExitHandlers();
      clearTimeout(timer); clearTimeout(closeTimer);
      // A timeout is not proof of process exit. Keep uncertain profiles and mark the
      // child unknown so a future stale-profile sweep cannot remove an active tree.
      if (closed && canCleanup) {
        // Disposable-profile cleanup is advisory, separate from both the child result
        // and its output: verify-ui hides passing output and scans it for rejections.
        try { profile?.cleanup(); } catch (error) { console.warn('UI profile cleanup deferred; check result unchanged:', error); }
      } else if (profile) {
        keep(`\nUI profile retained: ${reason}`);
        console.warn('UI profile retained:', reason);
        try { profile.markChild(null); } catch (error) { keep(String(error)); }
      }
      if (!closed) {
        keep('\nUI check close deadline reached; releasing inherited output pipes.');
        child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
      }
      resolve({ code, output });
    };
    child.stdout?.on('data', keep); child.stderr?.on('data', keep);
    child.on('error', error => keep(String(error)));
    child.on('close', (code, signal) => {
      if (closed || settled) return;
      closed = true;
      clearTimeout(timer); clearTimeout(closeTimer);
      const outcome = timedOut ? 'timeout' : code === 0 && unhandled ? 'unhandled rejection' : code ?? `signal ${signal}`;
      // Success retains its existing fixture contract. A failed spawn created no
      // tree. Every other close must prove descendant retirement before deletion.
      if (outcome === 0 || !Number.isSafeInteger(child.pid) || child.pid <= 0) { finish(outcome, true); return; }
      const reason = process.platform === 'win32'
        ? 'Windows descendant exit cannot be confirmed after the root has exited.'
        : 'owned process-group exit was not confirmed after the abnormal check exit.';
      retireClosedCheckTree(child.pid, process.platform, timedOut ? closeDeadline : undefined).then(confirmed => finish(outcome, confirmed, reason), error => {
        keep(`\nUI check tree retirement failed: ${error}`);
        finish(outcome, false, reason);
      });
    });
    // Direct invocation has no extra deadline; verify-ui supplies its existing per-check bound.
    if (timeoutMs !== undefined) timer = setTimeout(() => {
      timedOut = true;
      keep('\nUI check timed out; terminating its owned process tree.');
      try { terminateCheckTree(child.pid); }
      catch (error) { keep(`\nUI check tree termination failed: ${error}`); child.kill('SIGKILL'); }
      // Even a failed tree kill or a leaked inherited pipe must not stall later checks.
      closeDeadline = performance.now() + CLOSE_WAIT_MS;
      closeTimer = setTimeout(() => finish('timeout'), CLOSE_WAIT_MS);
    }, timeoutMs);
    // Only this detached POSIX spawn establishes child.pid as an owned PGID.
    profile?.markChild(child.pid, process.platform === 'win32' ? null : child.pid);
  });
}
