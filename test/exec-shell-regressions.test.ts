import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bindBundledRipgrep, execRecoveryHints, nonZeroExitIsBenign, repairPowerShellQuoting } from '../src/main/exec-hints.js';
import { deriveExecArgs, getShellByModelProvidedPath, withPosixPathPrefix } from '../src/main/codex/shell.js';
import { composeCommandBatch, parseCommandBatchSections } from '../src/main/codex/command-batch.js';
import { locateRipgrep } from '../src/main/ripgrep.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cos-shell-regression-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'sample.txt'), 'history="older"\nLoad older\nnot a match\n');
  writeFileSync(join(dir, 'second.txt'), 'not a match\n');
  return dir;
}

/**
 * Whether a ripgrep exists for these cases to run at all.
 *
 * They execute the real binary, bound by `bindBundledRipgrep`, which needs one: the copy under
 * `resources/rg` that packaging prepares, or one on PATH. A checkout that has not run that
 * preparation and a host with no system ripgrep have neither, and then every one of these fails
 * with `Command failed: /bin/sh -c rg …` — a missing tool reported as a quoting regression.
 * Measured on macOS 27 from a fresh worktree, and reported from a Windows machine as the
 * "bundled-rg shell-path assertion" failing identically on unmodified `main`.
 *
 * The parity these cases assert is about argument handling, not about shipping ripgrep, so the
 * honest answer without one is to skip and say so — the same shape as the `!shell` guard below.
 */
const ripgrep = locateRipgrep();

describe('native shell argument and batch parity', () => {
  // Every installed shell runs real child processes. macOS CI includes zsh; Linux
  // includes bash/sh. Windows exercises both PS generations when installed.
  for (const name of process.platform === 'win32' ? ['powershell', 'pwsh'] : ['bash', 'zsh', 'sh']) {
    const shell = getShellByModelProvidedPath(name);
    it.skipIf(!shell || !ripgrep)(`${name}: preserves quotes followed by spaces and adjacent paths`, () => {
      const cwd = fixture();
      const original = String.raw`rg -n "history=\"older\"|Load older" sample.txt second.txt`;
      const repaired = repairPowerShellQuoting(original, shell!.shellType);
      if (shell!.shellType !== 'powershell') expect(repaired).toEqual({ cmd: original, notes: [] });
      const command = bindBundledRipgrep(repaired.cmd, shell!.shellType, locateRipgrep());
      const args = deriveExecArgs(shell!, command, false);
      const output = execFileSync(args[0]!, args.slice(1), { cwd, encoding: 'utf8', windowsHide: true });
      expect(output.trim().split(/\r?\n/)).toEqual(['sample.txt:1:history="older"', 'sample.txt:2:Load older']);
      const batch = composeCommandBatch([command, command], shell!.shellType);
      const batchArgs = deriveExecArgs(shell!, batch.command, false);
      const batched = execFileSync(batchArgs[0]!, batchArgs.slice(1), { cwd, encoding: 'utf8', windowsHide: true });
      expect(parseCommandBatchSections(batched, batch.marker).map(row => ({ exit: row.exitCode, text: row.text.trim() })))
        .toEqual([{ exit: 0, text: output.trim() }, { exit: 0, text: output.trim() }]);
    });
  }
});

const zsh = getShellByModelProvidedPath('zsh');
it.skipIf(!zsh)('restores bundled command discovery after a login profile rewrites PATH', () => {
  const dir = fixture();
  const bundled = join(dir, "app's bundled tools");
  mkdirSync(bundled);
  writeFileSync(join(bundled, 'rg'), '#!/bin/sh\nprintf bundled-rg\n', { mode: 0o755 });
  writeFileSync(join(dir, '.zprofile'), 'export PATH=/usr/bin:/bin\n');
  const command = withPosixPathPrefix('command -v rg; rg; printf "\\n%s" "$PATH"', 'zsh', bundled);
  const args = deriveExecArgs(zsh!, command, true);
  const result = spawnSync(args[0]!, args.slice(1), { encoding: 'utf8', env: { ...process.env, ZDOTDIR: dir } });
  expect(result.status).toBe(0);
  expect(result.stdout.trim().split('\n')).toEqual([join(bundled, 'rg'), 'bundled-rg', `${bundled}:/usr/bin:/bin`]);
});

it('leaves other shell languages and missing bundled paths unchanged', () => {
  expect(withPosixPathPrefix('Get-Command rg', 'powershell', '/bundle')).toBe('Get-Command rg');
  expect(withPosixPathPrefix('where rg', 'cmd', '/bundle')).toBe('where rg');
  expect(withPosixPathPrefix('command -v rg', 'sh', null)).toBe('command -v rg');
});

it.skipIf(!zsh)('preserves native zsh unmatched-glob failure instead of reporting no search matches', () => {
  const command = bindBundledRipgrep('rg needle missing/*.ts', 'zsh', locateRipgrep());
  const args = deriveExecArgs(zsh!, command, false);
  const result = spawnSync(args[0]!, args.slice(1), { cwd: fixture(), encoding: 'utf8', windowsHide: true });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  const output = result.stdout + result.stderr;
  expect(output).toContain('no matches found');
  expect(nonZeroExitIsBenign(command, result.status!, output)).toBe(false);
});

it('does not reinterpret fixed-string flags, quoted flag spellings, or PCRE literal regions as regex escapes', () => {
  for (const command of [
    String.raw`rg -F "history=\"older|Load older" sample.txt`,
    String.raw`rg "history=\"older|Load older" -F sample.txt`,
    String.raw`rg "history=\"older|Load older" '--fixed-strings' sample.txt`,
    String.raw`rg "history=\"older|Load older" -iF sample.txt`,
    String.raw`rg "history=\"older|Load older" -e "foo\"|bar" -F sample.txt`,
    String.raw`rg "history=\"older|Load older" $options sample.txt`,
    String.raw`rg -P "\Qhistory=\"older\E|Load older" sample.txt`
  ]) expect(repairPowerShellQuoting(command, 'powershell').cmd).not.toContain('\\x22');
});

it('keeps the Windows repair out of POSIX shell syntax', () => {
  for (const shell of ['bash', 'zsh', 'sh'] as const) {
    const cmd = String.raw`rg "history=\"older|Load older" src/*.ts && printf '%s\n' done`;
    expect(repairPowerShellQuoting(cmd, shell)).toEqual({ cmd, notes: [] });
  }
});

it('explains zsh glob refusal without suggesting replay of earlier statements', () => {
  const output = 'zsh:1: no matches found: missing/*.ts';
  const hints = execRecoveryHints('rg needle missing/*.ts', output, 'zsh');
  expect(hints).toHaveLength(1);
  expect(hints[0]).toContain("rg -g '<glob>'");
  expect(hints[0]).toContain('Earlier statements may already have run');
  expect(hints[0]).not.toContain('PowerShell');
  expect(execRecoveryHints('rg needle sample.txt', 'sample.txt:1:zsh: no matches found:', 'zsh')).toEqual([]);
});
