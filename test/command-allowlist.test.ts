import { describe, expect, it } from 'vitest';
import {
  commandHasSameArguments,
  evaluateCommandAllowlist,
  parseCommandAllowlistText,
  validateCommandAllowlistRule
} from '../src/shared/command-allowlist.js';
import { normalizeShellCommand } from '../src/main/exec-hints.js';

const enabled = (rules: string[], mode: 'allow' | 'deny' = 'allow') => ({ enabled: true, mode, rules });

describe('command allowlist', () => {
  it('matches exact argument boundaries and rejects additions', () => {
    expect(evaluateCommandAllowlist(enabled(['git status']), ['git status'], 'powershell').allowed).toBe(true);
    expect(evaluateCommandAllowlist(enabled(['git status']), ['git status-other'], 'powershell').allowed).toBe(false);
    expect(evaluateCommandAllowlist(enabled(['git status']), ['git status --short'], 'powershell').allowed).toBe(false);
  });

  it('allows zero or more additional arguments only for a final standalone wildcard', () => {
    for (const command of ['git diff', 'git diff --stat', 'git diff -- src/file.ts']) {
      expect(evaluateCommandAllowlist(enabled(['git diff *']), [command], 'powershell').allowed).toBe(true);
    }
    expect(validateCommandAllowlistRule('git * diff')).toMatch(/wildcard/i);
    expect(validateCommandAllowlistRule('*')).toMatch(/wildcard/i);
    expect(validateCommandAllowlistRule('git diff*')).toMatch(/syntax/i);
  });

  it('supports quoted literal arguments and full executable paths without basename matching', () => {
    const rule = '"C:\\Program Files\\Git\\bin\\git.exe" status';
    expect(evaluateCommandAllowlist(enabled([rule]), ['& "C:\\Program Files\\Git\\bin\\git.exe" status'], 'powershell').allowed).toBe(true);
    expect(evaluateCommandAllowlist(enabled([rule]), ['git status'], 'powershell').allowed).toBe(false);
    expect(evaluateCommandAllowlist(enabled(['tool "argument with spaces"']), ['tool "argument with spaces"'], 'bash').allowed).toBe(true);
    expect(evaluateCommandAllowlist(enabled(['git diff *']), ['git diff -- "some file.txt"'], 'powershell').allowed).toBe(true);
  });

  it.each([
    'git status; whoami',
    'git status && whoami',
    'git status | more',
    'git status > out.txt',
    'git $(whoami)',
    'git `whoami`',
    'git *.ts',
    'git status\nwhoami'
  ])('rejects unsupported shell syntax: %s', (command) => {
    const decision = evaluateCommandAllowlist(enabled(['git status *']), [command], 'bash');
    expect(decision).toMatchObject({ allowed: false, kind: 'unsupported' });
  });

  it('distinguishes quoted operators from shell operators', () => {
    expect(evaluateCommandAllowlist(enabled(['tool "a|b"']), ['tool "a|b"'], 'bash').allowed).toBe(true);
  });

  it('rejects shell forms whose effective arguments differ from the parsed literals', () => {
    expect(evaluateCommandAllowlist(enabled(['Write-Output ab']), ["Write-Output 'a''b'"], 'powershell')).toMatchObject({
      allowed: false, kind: 'unsupported'
    });
    expect(evaluateCommandAllowlist(enabled(['Write-Output "one,two"']), ['Write-Output one,two'], 'powershell')).toMatchObject({
      allowed: false, kind: 'unsupported'
    });
    expect(evaluateCommandAllowlist(enabled(['printf "%s" "~"']), ['printf "%s" ~'], 'bash')).toMatchObject({
      allowed: false, kind: 'unsupported'
    });
  });

  it('fails closed for an enabled empty or malformed policy but bypasses a disabled policy', () => {
    expect(evaluateCommandAllowlist(enabled([]), ['git status'], 'powershell')).toMatchObject({ allowed: false, kind: 'unmatched' });
    expect(evaluateCommandAllowlist({ enabled: false, mode: 'allow', rules: [] }, ['git status; whoami'], 'powershell').allowed).toBe(true);
    expect(evaluateCommandAllowlist(enabled(['git status; whoami']), ['git status'], 'powershell')).toMatchObject({ allowed: false, kind: 'invalid-policy' });
  });

  it('preflights every batch command and reports the denied index', () => {
    expect(evaluateCommandAllowlist(enabled(['git status']), ['git status', 'git diff'], 'powershell')).toMatchObject({
      allowed: false, commandIndex: 1, kind: 'unmatched'
    });
  });

  it('denies exact and wildcard matches while allowing ordinary non-matches', () => {
    expect(evaluateCommandAllowlist(enabled(['git status'], 'deny'), ['git status'], 'powershell')).toMatchObject({
      allowed: false, kind: 'denied'
    });
    expect(evaluateCommandAllowlist(enabled(['git status'], 'deny'), ['git status --short'], 'powershell').allowed).toBe(true);
    expect(evaluateCommandAllowlist(enabled(['dotnet *'], 'deny'), ['dotnet --list-sdks'], 'powershell')).toMatchObject({
      allowed: false, kind: 'denied'
    });
    expect(evaluateCommandAllowlist(enabled(['dotnet *'], 'deny'), ['dotnet --info'], 'powershell')).toMatchObject({
      allowed: false, kind: 'denied'
    });
    expect(evaluateCommandAllowlist(enabled(['dotnet *'], 'deny'), ['git status'], 'powershell').allowed).toBe(true);
    expect(evaluateCommandAllowlist(enabled([], 'deny'), ['git status'], 'powershell').allowed).toBe(true);
  });

  it('keeps unsupported syntax and malformed policies fail-closed in denylist mode', () => {
    for (const command of ['git status; whoami', 'git status && whoami', 'git status | more', 'git $(whoami)']) {
      expect(evaluateCommandAllowlist(enabled([], 'deny'), [command], 'powershell'), command).toMatchObject({
        allowed: false, kind: 'unsupported'
      });
    }
    expect(evaluateCommandAllowlist(enabled(['git status; whoami'], 'deny'), ['git status'], 'powershell')).toMatchObject({
      allowed: false, kind: 'invalid-policy'
    });
    expect(evaluateCommandAllowlist({ enabled: true, mode: 'other' as 'deny', rules: [] }, ['git status'], 'powershell')).toMatchObject({
      allowed: false, kind: 'invalid-policy'
    });
  });

  it('rejects an entire denylist batch at the matching command index', () => {
    expect(evaluateCommandAllowlist(enabled(['git diff *'], 'deny'), ['git status', 'git diff --stat'], 'powershell')).toMatchObject({
      allowed: false, commandIndex: 1, kind: 'denied'
    });
  });

  it('returns line-specific editor errors and enforces rewrite parity in both modes', () => {
    expect(parseCommandAllowlistText('git status\ngit diff *\ngit status; whoami').issues).toEqual([
      expect.objectContaining({ line: 3 })
    ]);
    expect(commandHasSameArguments(['git', 'status'], 'git status', 'powershell')).toBe(true);
    expect(commandHasSameArguments(['git', 'status'], 'git status --short', 'powershell')).toBe(false);
    expect(evaluateCommandAllowlist(enabled(['git status']), ['git status'], 'powershell')).toEqual({
      allowed: true, args: [['git', 'status']]
    });
    expect(evaluateCommandAllowlist(enabled(['dotnet *'], 'deny'), ['git status'], 'powershell')).toEqual({
      allowed: true, args: [['git', 'status']]
    });

    const normalized = normalizeShellCommand('rg needle *.txt', 'powershell', () => ['one.txt', 'two.txt']).cmd;
    expect(normalized).toBe("rg needle 'one.txt' 'two.txt'");
    expect(commandHasSameArguments(['rg', 'needle', '*.txt'], normalized, 'powershell')).toBe(false);
  });
});
