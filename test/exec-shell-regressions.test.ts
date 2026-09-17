import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bindBundledRipgrep, execRecoveryHints, nonZeroExitIsBenign, repairPowerShellQuoting } from '../src/main/exec-hints.js';
import { deriveExecArgs, getShellByModelProvidedPath } from '../src/main/codex/shell.js';
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

describe('native shell argument and batch parity', () => {
  // Every installed shell runs real child processes. macOS CI includes zsh; Linux
  // includes bash/sh. Windows exercises both PS generations when installed.
  for (const name of process.platform === 'win32' ? ['powershell', 'pwsh'] : ['bash', 'zsh', 'sh']) {
    const shell = getShellByModelProvidedPath(name);
    it.skipIf(!shell)(`${name}: preserves quotes followed by spaces and adjacent paths`, () => {
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
