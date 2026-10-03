import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

const script = path.resolve('scripts/windows-signing-mode.mjs');
const clearedKeys = new Set([
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'COS_WINDOWS_SIGNER_SUBJECT',
  'COS_WINDOWS_CERTIFICATE_SHA1'
]);
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !clearedKeys.has(key)));

function run(extra: Record<string, string> = {}, args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...baseEnv, ...extra }
  });
}

it('keeps zero-secret contributor and canary mode unsigned-capable', () => {
  const result = run();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('windows-signing-mode=unsigned-capable');
});

it('fails zero-secret official mode closed when stable publishing requires signing', () => {
  const result = run({}, ['--require-official']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Official Windows signing is required');
  expect(result.stdout).not.toContain('windows-signing-mode=unsigned-capable');
});

it('publishes only the non-secret signing mode to GitHub step output', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cos-windows-signing-'));
  try {
    const output = path.join(directory, 'github-output');
    const result = spawnSync(process.execPath, [script, '--github-output'], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...baseEnv, GITHUB_OUTPUT: output }
    });
    expect(result.status).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('mode=unsigned-capable\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('fails signing closed on partial credentials without echoing secret values', () => {
  const partial = run({
    WIN_CSC_LINK: 'base64-secret-material',
    WIN_CSC_KEY_PASSWORD: 'private-password'
  });
  expect(partial.status).toBe(1);
  expect(partial.stderr).toContain('Windows signing credentials must be all present or all absent');
  expect(partial.stderr).toContain('COS_WINDOWS_SIGNER_SUBJECT');
  expect(partial.stderr).toContain('COS_WINDOWS_CERTIFICATE_SHA1');
  expect(partial.stderr).not.toContain('base64-secret-material');
  expect(partial.stderr).not.toContain('private-password');
});

it('accepts only a complete official signing set with a normalized SHA-1 fingerprint', () => {
  const complete = run({
    WIN_CSC_LINK: 'base64-secret-material',
    WIN_CSC_KEY_PASSWORD: 'private-password',
    COS_WINDOWS_SIGNER_SUBJECT: 'CN=Example Publisher, O=Example Org',
    COS_WINDOWS_CERTIFICATE_SHA1: 'aa bb cc dd ee ff 00 11 22 33 44 55 66 77 88 99 aa bb cc dd'
  });
  expect(complete.status).toBe(0);
  expect(complete.stdout).toContain('windows-signing-mode=official');
  expect(complete.stdout).toContain('certificate-sha1=AABBCCDDEEFF00112233445566778899AABBCCDD');
  expect(complete.stdout).not.toContain('base64-secret-material');
  expect(complete.stdout).not.toContain('private-password');
});

it('rejects fingerprint junk instead of silently normalizing it away', () => {
  const invalid = run({
    WIN_CSC_LINK: 'base64-secret-material',
    WIN_CSC_KEY_PASSWORD: 'private-password',
    COS_WINDOWS_SIGNER_SUBJECT: 'CN=Example Publisher, O=Example Org',
    COS_WINDOWS_CERTIFICATE_SHA1: 'AA BB CC DD EE FF 00 11 22 33 44 55 66 77 88 99 AA BB CC DD!'
  });
  expect(invalid.status).toBe(1);
  expect(invalid.stderr).toContain('only hex digits separated by whitespace, colon, or hyphen');
});
