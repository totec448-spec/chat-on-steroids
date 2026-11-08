import type { ChildProcess } from 'node:child_process';

export const CHILD_PID_PREFIX = 'COS_TEST_CHILD_PID=';
const PID_LINE = new RegExp(`(?:^|\\n)${CHILD_PID_PREFIX}([^\\r\\n]*)\\r?\\n`);
const MAX_DIAGNOSTIC_CHARS = 4096;

/** The lifetime fixture reports the child it owns; a PID file is not a startup receipt. */
export function waitForChildPid(child: ChildProcess, timeoutMs: number): Promise<number> {
  if (!child.stdout || !child.stderr) return Promise.reject(new Error('Process readiness requires piped stdout and stderr'));
  const stdout = child.stdout, stderr = child.stderr;
  stdout.setEncoding('utf8'); stderr.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const finish = (reason: string | null, pid?: number): void => {
      clearTimeout(timer);
      stdout.off('data', onOut); stderr.off('data', onErr);
      child.off('error', onError); child.off('exit', onExit);
      if (reason) reject(new Error(`${reason}\nstdout: ${out || '(empty)'}\nstderr: ${err || '(empty)'}`));
      else resolve(pid!);
    };
    const onOut = (chunk: string): void => {
      const text = out + chunk;
      out = text.slice(-MAX_DIAGNOSTIC_CHARS);
      const match = PID_LINE.exec(text);
      if (!match) return;
      const pid = Number(match[1]);
      if (!/^[1-9]\d*$/.test(match[1]!) || !Number.isSafeInteger(pid)) finish('Process fixture reported an invalid child PID');
      else finish(null, pid);
    };
    const onErr = (chunk: string): void => { err = (err + chunk).slice(-MAX_DIAGNOSTIC_CHARS); };
    const onError = (error: Error): void => finish(`Process fixture failed to start: ${error.message}`);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => finish(`Process fixture exited before readiness (code=${code}, signal=${signal})`);
    const timer = setTimeout(() => finish(`Process fixture did not report its child PID within ${timeoutMs} ms`), timeoutMs);
    stdout.on('data', onOut); stderr.on('data', onErr);
    child.once('error', onError); child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
  });
}
