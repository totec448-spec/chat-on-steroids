import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { createProfile, removeProfile } from './ui-check-profile.cjs';

const CLOSE_WAIT_MS = 2_000;
const FIXTURE_FAILURE_MARKER = 'COS_QA_TEST_FAILED:';
const UNHANDLED_REJECTION_MARKER = 'UnhandledPromiseRejection';
const STREAM_TAIL_LENGTH = Math.max(FIXTURE_FAILURE_MARKER.length, UNHANDLED_REJECTION_MARKER.length) - 1;

function stopTree(child) {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    // Only the group created for this check, including Electron helpers.
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    return;
  }
  // A root that already exited can still have open pipes, but no longer owns its PID.
  if (child.exitCode !== null || child.signalCode !== null) return;
  const system = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const result = spawnSync(path.win32.join(system, 'System32', 'taskkill.exe'),
    ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 1_000 });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 128) throw new Error(`taskkill exited with ${result.status}`);
}

export function runUiCheck(command, args, { cwd, env, timeoutMs, profileRoot }) {
  return new Promise(resolve => {
    let profile, child;
    try {
      if (profileRoot) profile = createProfile(profileRoot);
      child = spawn(command, args, {
        cwd, env: profile ? { ...env, COS_TERMINAL_CHECK_PROFILE: profile } : env,
        windowsHide: true, detached: process.platform !== 'win32'
      });
    } catch (error) {
      if (profile) removeProfile(profile);
      resolve({ code: 'start failed', output: String(error) });
      return;
    }
    let output = '', unhandled = false, fixtureFailed = false, timedOut = false, settled = false, closeTimer;
    const streamTails = { stdout: '', stderr: '' };
    // Keep Ctrl-C/termination working after placing the check in a separate group.
    const interrupt = signal => {
      try { stopTree(child); } catch (error) { console.warn('Could not stop interrupted UI check:', error.message); }
      process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    // Pipe data events can split a sentinel. Keep a short overlap for each
    // stream, without accidentally joining unrelated stdout/stderr data.
    const keep = (chunk, stream = 'stderr') => {
      const value = String(chunk);
      const recent = streamTails[stream] + value;
      unhandled ||= recent.includes(UNHANDLED_REJECTION_MARKER);
      fixtureFailed ||= recent.includes(FIXTURE_FAILURE_MARKER);
      streamTails[stream] = recent.slice(-STREAM_TAIL_LENGTH);
      output = (output + value).slice(-4000);
    };
    const finish = (code, closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(closeTimer);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      if (closed && profile) removeProfile(profile);
      if (!closed) {
        keep('\nUI check did not close after termination; releasing its output pipes.');
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
      }
      resolve({ code, output });
    };
    child.stdout.on('data', chunk => keep(chunk, 'stdout'));
    child.stderr.on('data', chunk => keep(chunk, 'stderr'));
    child.on('error', error => keep(String(error)));
    child.once('close', (code, signal) => {
      finish(timedOut ? 'timeout' : code === 0 && fixtureFailed ? 'fixture assertion failed'
        : code === 0 && unhandled ? 'unhandled rejection' : code ?? `signal ${signal}`, true);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      closeTimer = setTimeout(() => finish('timeout', false), CLOSE_WAIT_MS);
      try { stopTree(child); }
      catch (error) { keep(`\nUI check tree termination failed: ${error}`); }
    }, timeoutMs);
  });
}
