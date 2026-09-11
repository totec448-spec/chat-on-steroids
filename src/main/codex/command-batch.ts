/**
 * Builds one shell program from several model-visible commands.
 *
 * This is intentionally not process-level batching: every item runs sequentially in the
 * same shell, so variables, environment changes and the working directory survive between
 * sections. The wrapper keeps going after a normal non-zero result, labels each section,
 * and exits with the first non-zero code after all commands have had a chance to run.
 */

import { randomBytes } from 'node:crypto';
import type { ShellType } from './shell.js';

const BATCH_MARKER_BYTES = 12;

function batchMarker(): string {
  return randomBytes(BATCH_MARKER_BYTES).toString('hex');
}

function commandBanner(index: number, count: number, marker: string): string {
  return `--- command ${index}/${count} --- [clf-batch:${marker}]`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powershellBatch(commands: readonly string[], marker: string): string {
  const encoded = commands.map((command) => Buffer.from(command, 'utf8').toString('base64'));
  return [
    `$__cos_batch_commands = @(${encoded.map((item) => `'${item}'`).join(', ')})`,
    '$__cos_batch_exit = 0',
    'for ($__cos_batch_index = 0; $__cos_batch_index -lt $__cos_batch_commands.Count; $__cos_batch_index++) {',
    `  [Console]::Out.WriteLine(("--- command {0}/{1} --- [clf-batch:${marker}]" -f ($__cos_batch_index + 1), $__cos_batch_commands.Count))`,
    '  $global:LASTEXITCODE = 0',
    '  try {',
    '    $__cos_batch_text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($__cos_batch_commands[$__cos_batch_index]))',
    '    . ([ScriptBlock]::Create($__cos_batch_text))',
    '    $__cos_batch_succeeded = $?',
    '    $__cos_batch_code = if ($LASTEXITCODE -ne 0) { [int]$LASTEXITCODE } elseif ($__cos_batch_succeeded) { 0 } else { 1 }',
    '  } catch {',
    '    [Console]::Error.WriteLine($_.ToString())',
    '    $__cos_batch_code = 1',
    '  }',
    `  [Console]::Out.WriteLine(("--- exit code {0} --- [clf-batch:${marker}]" -f $__cos_batch_code))`,
    '  if ($__cos_batch_code -ne 0 -and $__cos_batch_exit -eq 0) { $__cos_batch_exit = $__cos_batch_code }',
    '}',
    'exit $__cos_batch_exit'
  ].join('\n');
}

function posixBatch(commands: readonly string[], marker: string): string {
  const lines = ['__cos_batch_exit=0'];
  commands.forEach((command, index) => {
    lines.push(
      `printf '%s\\n' ${shellSingleQuote(commandBanner(index + 1, commands.length, marker))}`,
      `eval ${shellSingleQuote(command)}`,
      '__cos_batch_code=$?',
      `printf '%s\\n' "--- exit code $__cos_batch_code --- [clf-batch:${marker}]"`,
      'if [ "$__cos_batch_code" -ne 0 ] && [ "$__cos_batch_exit" -eq 0 ]; then __cos_batch_exit=$__cos_batch_code; fi'
    );
  });
  lines.push('exit "$__cos_batch_exit"');
  return lines.join('\n');
}

function cmdBatch(commands: readonly string[], marker: string): string {
  const lines = ['@echo off', 'set "__cos_batch_exit=0"'];
  commands.forEach((command, index) => {
    lines.push(
      `echo ${commandBanner(index + 1, commands.length, marker)}`,
      `call ${command}`,
      'set "__cos_batch_code=%errorlevel%"',
      `echo --- exit code %__cos_batch_code% --- [clf-batch:${marker}]`,
      'if not "%__cos_batch_code%"=="0" if "%__cos_batch_exit%"=="0" set "__cos_batch_exit=%__cos_batch_code%"'
    );
  });
  lines.push('exit /b %__cos_batch_exit%');
  return lines.join('\r\n');
}

export function composeCommandBatch(commands: readonly string[], shellType: ShellType): { command: string; marker: string } {
  if (commands.length === 0) throw new Error('a command batch must contain at least one command');
  const marker = batchMarker();
  switch (shellType) {
    case 'powershell':
      return { command: powershellBatch(commands, marker), marker };
    case 'cmd':
      return { command: cmdBatch(commands, marker), marker };
    case 'bash':
    case 'zsh':
    case 'sh':
      return { command: posixBatch(commands, marker), marker };
  }
}

/** Remove only this invocation's private delimiter, before either retention or token limits.
 * At most one delimiter's prefix waits for the next chunk; arbitrary stdout is never buffered.
 * The raw stream remains available to the authenticated section parser below.
 */
export class CommandBatchDisplay {
  private readonly delimiter: Buffer;
  private pending = Buffer.alloc(0);

  constructor(marker: string) {
    if (!/^[0-9a-f]{24}$/.test(marker)) throw new Error('invalid command batch marker');
    this.delimiter = Buffer.from(` [clf-batch:${marker}]`);
  }

  push(chunk: Buffer, final = false): Buffer {
    const input = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const parts: Buffer[] = [];
    let start = 0;
    for (let at = input.indexOf(this.delimiter); at >= 0; at = input.indexOf(this.delimiter, start)) {
      parts.push(input.subarray(start, at));
      start = at + this.delimiter.length;
    }
    let end = input.length;
    if (!final) {
      for (let length = Math.min(this.delimiter.length - 1, end - start); length > 0; length--) {
        if (input.subarray(end - length).equals(this.delimiter.subarray(0, length))) {
          end -= length;
          break;
        }
      }
    }
    this.pending = Buffer.from(input.subarray(end));
    parts.push(input.subarray(start, end));
    return Buffer.concat(parts);
  }
}

/** One command's slice of a batch result, recovered from the markers written above. */
export interface CommandBatchSection {
  /** 1-based position, as the marker states it. */
  index: number;
  exitCode: number;
  /** Output between this command's banner and its exit-code marker. */
  text: string;
}

/**
 * Reads the sections back out of a batch result.
 *
 * The wrapper gives each invocation a random framing marker. Fixed marker text is not a safe
 * delimiter because the command's own stdout is mixed into the same stream: an ordinary tool
 * can print `--- exit code 0 ---` and must not thereby close its section early. Callers use the
 * authenticated-by-construction framing to classify each command's exit on its own evidence: a
 * batch of searches must not be reported as a failure because one of them found nothing, which
 * is the single most common thing a batch will contain.
 *
 * Sections are returned only when a banner and its exit-code marker were both seen, so a
 * truncated tail yields fewer sections rather than a section with an invented status.
 */
export function parseCommandBatchSections(output: string, marker: string): CommandBatchSection[] {
  const sections: CommandBatchSection[] = [];
  const lines = output.split('\n').map((line) => line.replace(/\r$/, ''));
  if (!/^[0-9a-f]{24}$/.test(marker)) return sections;
  const firstPattern = new RegExp(`^--- command 1\\/(\\d+) --- \\[clf-batch:${marker}\\]$`);
  const firstIndex = lines.findIndex((line) => firstPattern.test(line));
  if (firstIndex < 0) return sections;
  const first = firstPattern.exec(lines[firstIndex]!);
  if (!first) return sections;
  const count = Number(first[1]);
  const pattern = new RegExp(`^--- command (\\d+)\\/${count} --- \\[clf-batch:${marker}\\]$`);
  const exitPattern = new RegExp(`^--- exit code (-?\\d+) --- \\[clf-batch:${marker}\\]$`);
  let open: { index: number; body: string[] } | null = null;
  for (const line of lines.slice(firstIndex)) {
    const banner = pattern.exec(line);
    if (banner) {
      open = { index: Number(banner[1]), body: [] };
      continue;
    }
    if (!open) continue;
    const exit = exitPattern.exec(line);
    if (exit) {
      sections.push({ index: open.index, exitCode: Number(exit[1]), text: open.body.join('\n') });
      open = null;
      continue;
    }
    open.body.push(line);
  }
  return sections;
}
