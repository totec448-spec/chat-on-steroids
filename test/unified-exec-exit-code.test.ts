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
