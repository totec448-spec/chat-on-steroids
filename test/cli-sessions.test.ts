import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claudeAttachLooksReady,
  normalizeCliTranscriptLine,
  observeClaudeAttachSignals,
  readCliTranscriptFile,
  resolveClaudePtyCommand
} from '../src/main/cli-sessions.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const tempDirs: string[] = [];

async function tempFile(name: string, lines: unknown[]): Promise<string> {
  const dir = await makeTempDir('clf-cli-sessions-');
  tempDirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return file;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeTempDir(dir)));
});

describe('CLI session transcript bridge', () => {
  it('resolves Claude native Windows installs before PATH and fails closed when none exists', async () => {
    const checked: string[] = [];
    const probe = async (candidate: string) => {
      checked.push(candidate);
      return candidate.toLowerCase().endsWith('c:\\users\\test\\.local\\bin\\claude.exe'.toLowerCase());
    };
    await expect(
      resolveClaudePtyCommand(
        { Path: 'C:\\Tools;C:\\Other' },
        'C:\\Users\\test',
        'win32',
        probe
      )
    ).resolves.toBe(path.join('C:\\Users\\test', '.local', 'bin', 'claude.exe'));
    expect(checked).toHaveLength(1);

    await expect(resolveClaudePtyCommand({}, '/home/test', 'linux', async () => false)).resolves.toBe('claude');
    await expect(resolveClaudePtyCommand({}, 'C:\\Users\\none', 'win32', async () => false)).resolves.toBeNull();
  });

  it('waits for Claude interactive-screen readiness rather than its early terminal setup bytes', () => {
    expect(claudeAttachLooksReady('\x1b[?2004h Attaching…', 1_000, 2_000)).toBe(false);
    expect(claudeAttachLooksReady('\x1b[?2004h Claude Code v2.1.270', 149, 2_000)).toBe(false);
    expect(claudeAttachLooksReady('\x1b[?2004h Claude Code v2.1.270', 150, 1_499)).toBe(false);
    expect(claudeAttachLooksReady('\x1b[?2004h Claude Code v2.1.270', 150, 1_500)).toBe(true);
  });

  it('retains Claude readiness signals after earlier terminal redraws scroll out of the bounded tail', () => {
    let signals = observeClaudeAttachSignals(
      { brand: false, bracketedPaste: false, deviceHandshake: false },
      '\x1b[?2004h Claude Code v2.1.270'
    );
    signals = observeClaudeAttachSignals(signals, 'x'.repeat(40_000));
    signals = observeClaudeAttachSignals(signals, '\x1b[>0q');
    expect(signals).toEqual({ brand: true, bracketedPaste: true, deviceHandshake: true });
  });

  it('normalizes Claude user/assistant prose and compact tool headlines', () => {
    const line = JSON.stringify({
      timestamp: '2026-09-13T01:00:00.000Z',
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I found the issue.' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'src/app.ts' } }
        ]
      }
    });
    expect(normalizeCliTranscriptLine('claude', line)).toEqual([
      { at: '2026-09-13T01:00:00.000Z', kind: 'assistant', text: 'I found the issue.' },
      { at: '2026-09-13T01:00:00.000Z', kind: 'tool', text: 'Read {"file_path":"src/app.ts"}' }
    ]);
  });

  it('reads and then follows one exact Claude JSONL transcript with a checked cursor', async () => {
    const sessionId = '11111111-2222-4333-8444-555555555555';
    const file = await tempFile(`${sessionId}.jsonl`, [
      {
        timestamp: '2026-09-13T01:00:00.000Z',
        type: 'user',
        sessionId,
        message: { role: 'user', content: 'first question' }
      },
      {
        timestamp: '2026-09-13T01:00:01.000Z',
        type: 'assistant',
        sessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] }
      }
    ]);

    const first = await readCliTranscriptFile('claude', sessionId, file);
    expect(first.entries.map((entry) => `${entry.kind}:${entry.text}`)).toEqual([
      'user:first question',
      'assistant:first answer'
    ]);
    expect(first.caughtUp).toBe(true);

    await fs.appendFile(
      file,
      JSON.stringify({
        timestamp: '2026-09-13T01:00:02.000Z',
        type: 'assistant',
        sessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'follow-up answer' }] }
      }) + '\n',
      'utf8'
    );

    const update = await readCliTranscriptFile('claude', sessionId, file, first.cursor);
    expect(update.entries).toEqual([
      { at: '2026-09-13T01:00:02.000Z', kind: 'assistant', text: 'follow-up answer' }
    ]);
    expect(update.caughtUp).toBe(true);

    await expect(readCliTranscriptFile('claude', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', file, first.cursor)).rejects.toThrow(
      /cursor does not verify/i
    );
  });

  it('normalizes Codex conversation messages and tool calls without returning large tool output', async () => {
    const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff';
    const file = await tempFile(`rollout-2026-09-13T01-00-00-${sessionId}.jsonl`, [
      {
        timestamp: '2026-09-13T01:00:00.000Z',
        type: 'session_meta',
        payload: { session_id: sessionId, cwd: 'C:/Dev/demo' }
      },
      {
        timestamp: '2026-09-13T01:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inspect this' }] }
      },
      {
        timestamp: '2026-09-13T01:00:02.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call', name: 'exec', input: 'text(await tools.exec_command({cmd:"git status"}))' }
      },
      {
        timestamp: '2026-09-13T01:00:03.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', output: 'x'.repeat(50_000) }
      },
      {
        timestamp: '2026-09-13T01:00:04.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }
      },
      {
        timestamp: '2026-09-13T01:00:05.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete' }
      }
    ]);

    const page = await readCliTranscriptFile('codex', sessionId, file, 'start');
    expect(page.entries.map((entry) => entry.kind)).toEqual(['user', 'tool', 'assistant', 'event']);
    expect(page.entries[0]?.text).toBe('inspect this');
    expect(page.entries[1]?.text).toContain('git status');
    expect(page.entries[2]?.text).toBe('done');
    expect(page.entries[3]?.text).toBe('task_complete');
    expect(page.entries.some((entry) => entry.text.includes('x'.repeat(1000)))).toBe(false);
  });
});
