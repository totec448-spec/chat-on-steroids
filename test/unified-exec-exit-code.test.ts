import { expect, it } from 'vitest';
import { signedExitCode } from '../src/main/codex/unified-exec.js';

// Live 2026-10-16 on the Windows VM: ssh.exe ended by a dropped connection exits with -1, which
// Windows hands over as the unsigned DWORD 4294967295 and the model read as "exited with code
// 4294967295". Codex reports the signed value (Rust's ExitStatus::code() is an i32).
it('reports a Windows exit status as the signed number Codex shows', () => {
  expect(signedExitCode(4294967295)).toBe(-1);
  expect(signedExitCode(3221225477)).toBe(-1073741819); // 0xC0000005, an access violation
  expect(signedExitCode(2147483647)).toBe(2147483647);
  expect(signedExitCode(255)).toBe(255);
  expect(signedExitCode(0)).toBe(0);
  expect(signedExitCode(-1)).toBe(-1);
  expect(signedExitCode(null)).toBeNull();
});

// Found by driving the Linux app: `kill -9 $$` (and an out-of-memory kill, the common real case) ended a command with no
// exit status at all, so the model saw "Completed session" with an empty body and could not tell a crash from success.
// A shell reports a signal as 128 plus its number; so does this now.
it('reports a process ended by a signal as 128 plus the signal number, like a shell', async () => {
  const { exitStatusOf } = await import('../src/main/codex/unified-exec.js');
  expect(exitStatusOf(null, 'SIGKILL')).toBe(137);
  expect(exitStatusOf(null, 'SIGTERM')).toBe(143);
  expect(exitStatusOf(null, 'SIGSEGV')).toBe(139);
  expect(exitStatusOf(3, null)).toBe(3);
  expect(exitStatusOf(0, null)).toBe(0);
  expect(exitStatusOf(null, null)).toBeNull();
  expect(exitStatusOf(null, 'SIGNOTREAL' as NodeJS.Signals)).toBeNull();
});
