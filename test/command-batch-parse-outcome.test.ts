import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { composeCommandBatch, parseCommandBatchSections } from '../src/main/codex/command-batch.js';
import { deriveExecArgs, getShellByModelProvidedPath } from '../src/main/codex/shell.js';
import { execRecoveryHints } from '../src/main/exec-hints.js';

const marker = 'a'.repeat(24);
it('recognizes a parse failure only inside a completed, exactly framed batch section', () => {
  const start = `--- command 1/1 --- [clf-batch:${marker}]`;
  const failed = `--- PowerShell parse failed --- [clf-batch:${marker}]`;
  const end = `--- exit code 1 --- [clf-batch:${marker}]`;
  expect(parseCommandBatchSections([start, failed, 'localized diagnostic', end].join('\n'), marker))
    .toEqual([{ index: 1, exitCode: 1, text: 'localized diagnostic', parseFailed: true }]);
  const foreign = `--- PowerShell parse failed --- [clf-batch:${'b'.repeat(24)}]`;
  expect(parseCommandBatchSections([start, foreign, end].join('\n'), marker))
    .toEqual([{ index: 1, exitCode: 1, text: foreign }]);
  expect(parseCommandBatchSections([start, failed].join('\n'), marker)).toEqual([]);
});

it.each([
  'ParserError: nested script failed after an earlier statement',
  'Exception calling "Create" with "1" argument(s): "At line:1 char:14',
  "The token '&&' is not a valid statement separator"
])('does not claim no execution when the batch proves parsing succeeded: %s', diagnostic => {
  expect(execRecoveryHints('Write-Output started; Invoke-NestedScript', diagnostic, 'powershell', false))
    .toEqual([]);
});

const powershell = getShellByModelProvidedPath('powershell');
it.skipIf(!powershell).each(['fr-FR', 'en-US'])('records pre-execution parse failure independently of %s diagnostics', culture => {
  const commands = [
    `[Threading.Thread]::CurrentThread.CurrentUICulture = [Globalization.CultureInfo]'${culture}'; $earlier = 'saved'; Write-Output 'ParserError: source text only'`,
    "Write-Output 'unterminated",
    "Write-Output 'runtime-started'; [ScriptBlock]::Create([string][char]39)",
    'Write-Output $earlier'
  ];
  const batch = composeCommandBatch(commands, 'powershell');
  const args = deriveExecArgs(powershell!, batch.command, false);
  const result = spawnSync(args[0]!, args.slice(1), { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  const sections = parseCommandBatchSections(result.stdout, batch.marker);
  expect(sections.map(section => section.exitCode)).toEqual([0, 1, 1, 0]);
  expect(sections.map(section => section.parseFailed === true)).toEqual([false, true, false, false]);
  expect(sections[2]!.text).toContain('runtime-started');
  expect(sections[3]!.text.trim()).toBe('saved');
  expect(execRecoveryHints(commands[1]!, sections[1]!.text, 'powershell', sections[1]!.parseFailed === true).join(' '))
    .toContain('PowerShell parsed none of the command');
});
