import type { ChildProcess } from 'node:child_process';

export const CHILD_PID_PREFIX = 'COS_TEST_CHILD_PID=';
const MAX_DIAGNOSTIC_CHARS = 4096;

/** The lifetime fixture reports the child it owns; a PID file is not a startup receipt. */
export function waitForChildPid(child: ChildProcess, timeoutMs: number): Promise<number> {
  if (!child.stdout || !child.stderr) return Promise.reject(new Error('Process readiness requires piped stdout and stderr'));
  const stdout = child.stdout, stderr = child.stderr;
  stdout.setEncoding('utf8'); stderr.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    let line = '', discardLine = false;
    let settled = false;
    let exited = child.exitCode !== null || child.signalCode !== null;
    let exitCode = child.exitCode, signalCode = child.signalCode;
    const exitReason = (): string => `Process fixture exited before readiness (code=${exitCode}, signal=${signalCode})`;
    const finish = (reason: string | null, pid?: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout.off('data', onOut); stderr.off('data', onErr);
      stdout.off('end', onDrained); stderr.off('end', onDrained);
      child.off('error', onError); child.off('exit', onExit); child.off('close', onClose);
      if (reason) reject(new Error(`${reason}\nstdout: ${out || '(empty)'}\nstderr: ${err || '(empty)'}`));
      else resolve(pid!);
    };
    const onOut = (chunk: string): void => {
      out = (out + chunk).slice(-MAX_DIAGNOSTIC_CHARS);
      if (exited) return;
      // Parse actual line boundaries independently of the truncated diagnostic tail.
      for (const [index, part] of chunk.split('\n').entries()) {
        if (index > 0) {
          const receipt = discardLine || !line.startsWith(CHILD_PID_PREFIX)
            ? null : line.slice(CHILD_PID_PREFIX.length).replace(/\r$/, '');
          line = ''; discardLine = false;
          if (receipt !== null) {
            const pid = Number(receipt);
            if (!/^[1-9]\d*$/.test(receipt) || !Number.isSafeInteger(pid)) finish('Process fixture reported an invalid child PID');
            else finish(null, pid);
            return;
          }
        }
        if (discardLine) continue;
        line += part;
        if (line.length > MAX_DIAGNOSTIC_CHARS) {
          if (line.startsWith(CHILD_PID_PREFIX)) { finish('Process fixture reported an invalid child PID (oversized line)'); return; }
          line = ''; discardLine = true;
        }
      }
    };
    const onErr = (chunk: string): void => { err = (err + chunk).slice(-MAX_DIAGNOSTIC_CHARS); };
    const onError = (error: Error): void => finish(`Process fixture failed to start: ${error.message}`);
    // Exit precedes pipe drainage; keep collecting diagnostics until close (or the same deadline).
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      exited = true; exitCode = code; signalCode = signal;
      onDrained();
    };
    const onDrained = (): void => {
      if (exited && stdout.readableEnded && stderr.readableEnded) finish(exitReason());
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      exitCode = code; signalCode = signal;
      finish(exitReason());
    };
    const timer = setTimeout(() => finish(exited
      ? `${exitReason()}; diagnostic pipes did not close within ${timeoutMs} ms`
      : `Process fixture did not report its child PID within ${timeoutMs} ms`), timeoutMs);
    stdout.on('data', onOut); stderr.on('data', onErr);
    stdout.on('end', onDrained); stderr.on('end', onDrained);
    child.once('error', onError); child.once('exit', onExit); child.once('close', onClose);
    onDrained();
  });
}
