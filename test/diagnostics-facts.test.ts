import { mkdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

/**
 * 2026-10-15, user: the diagnostics report should answer more on its own, so a bug report needs no
 * follow-up questions, while still holding nothing personal. Every fact here is a number, a state
 * or a short option name.
 */
const facts = await import('../src/main/diagnostics-facts.js');

afterEach(() => facts.resetDiagnosticsFactsForTests());

describe('tool call statistics', () => {
  it('counts the last 24 hours per tool, with errors, timeouts and the median time', () => {
    const now = Date.UTC(2026, 9, 15, 12);
    facts.noteToolCall('read', 'ok', 10, now - 1000);
    facts.noteToolCall('read', 'ok', 30, now - 1000);
    facts.noteToolCall('read', 'error', 20, now - 1000);
    facts.noteToolCall('exec_command', 'timeout', 120_000, now - 2000);
    facts.noteToolCall('apply_patch', 'ok', 5, now - 25 * 3_600_000); // older than a day
    expect(facts.toolCallLines(now)).toEqual([
      'read: 3 call(s), 1 error(s), 0 timeout(s), median 20 ms',
      'exec_command: 1 call(s), 0 error(s), 1 timeout(s), median 120000 ms'
    ]);
    expect(facts.toolCallLines(now + 2 * 86_400_000)).toEqual(['(no tool calls in the last 24 hours)']);
  });

  it('reads the outcome from the result a tool returned', () => {
    expect(facts.toolOutcome({ content: [{ type: 'text', text: 'done' }] })).toBe('ok');
    expect(facts.toolOutcome({ isError: true, content: [{ type: 'text', text: 'ENOENT: not found' }] })).toBe('error');
    expect(facts.toolOutcome({ isError: true, content: [{ type: 'text', text: 'Command timed out after 120000 ms' }] })).toBe('timeout');
    expect(facts.toolOutcome({ isError: true, content: [{ type: 'text', text: 'TIMEOUT: the page did not answer' }] })).toBe('timeout');
  });
});

describe('error summary', () => {
  it('groups warnings and errors that differ only in numbers and ids, most frequent first', () => {
    facts.tallyLogEntry({ time: Date.UTC(2026, 9, 15, 10, 0), level: 'warn', message: 'bridge: input 4f3a9c21 not confirmed after 3000 ms' });
    facts.tallyLogEntry({ time: Date.UTC(2026, 9, 15, 10, 5), level: 'warn', message: 'bridge: input 9b8c7d6e not confirmed after 4500 ms' });
    facts.tallyLogEntry({ time: Date.UTC(2026, 9, 15, 10, 6), level: 'error', message: 'update: download failed' });
    facts.tallyLogEntry({ time: Date.UTC(2026, 9, 15, 10, 7), level: 'info', message: 'ordinary line' });
    expect(facts.errorSummaryLines()).toEqual([
      '2× warn 10:00–10:05 UTC: bridge: input 4f3a9c21 not confirmed after 3000 ms',
      '1× error 10:06–10:06 UTC: update: download failed'
    ]);
  });

  it('keeps at most 20 kinds and stays bounded however many distinct lines arrive', () => {
    for (let index = 0; index < 2000; index += 1) {
      facts.tallyLogEntry({ time: 0, level: 'warn', message: `kind ${'abcdefghijklmnopqrstuvwxyz'[index % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(index / 26) % 26]}` });
    }
    expect(facts.errorSummaryLines()).toHaveLength(20);
    expect(facts.errorKindsForTests()).toBeLessThanOrEqual(500);
  });
});

describe('crashes and restarts', () => {
  let dir: string | null = null;
  afterEach(async () => { if (dir) await removeTempDir(dir); dir = null; });

  it('lists crash reports from the last 30 days by date, never their names or contents', async () => {
    dir = await makeTempDir('cos-crashes-');
    const now = Date.UTC(2026, 9, 15, 12);
    await mkdir(path.join(dir, 'completed'), { recursive: true });
    const recent = path.join(dir, 'completed', 'a1b2c3.dmp');
    const old = path.join(dir, 'completed', 'old.dmp');
    await writeFile(recent, 'x'); await writeFile(old, 'x'); await writeFile(path.join(dir, 'settings.dat'), 'x');
    await utimes(recent, new Date(now - 3_600_000), new Date(now - 3_600_000));
    await utimes(old, new Date(now - 40 * 86_400_000), new Date(now - 40 * 86_400_000));
    expect(await facts.crashLines(dir, now)).toEqual(['Crash reports in the last 30 days: 1 (2026-10-15T11:00Z)', 'This run: no restarts or sleep recorded']);
    expect(await facts.crashLines(path.join(dir, 'missing'), now)).toEqual(['Crash reports in the last 30 days: 0', 'This run: no restarts or sleep recorded']);
  });

  it('counts page and helper restarts and sleep this run', async () => {
    facts.noteRuntimeEvent('renderer gone: crashed');
    facts.noteRuntimeEvent('renderer gone: crashed');
    facts.noteRuntimeEvent('sleep');
    expect((await facts.crashLines(null, 0)).slice(1)).toEqual(['This run: renderer gone: crashed ×2, sleep ×1']);
  });
});

describe('install and system', () => {
  it('names how the app was installed without its folder', () => {
    expect(facts.installKind('win32', 'C:\\Program Files\\Chat On Steroids\\Chat On Steroids.exe', { ProgramFiles: 'C:\\Program Files' })).toBe('Windows installer, for all users (Program Files)');
    expect(facts.installKind('win32', 'C:\\Users\\jane\\AppData\\Local\\Programs\\chat-on-steroids\\Chat On Steroids.exe', { ProgramFiles: 'C:\\Program Files' })).toBe('Windows installer, for this user');
    expect(facts.installKind('win32', 'D:\\chat on Steroids\\Chat On Steroids.exe', { ProgramFiles: 'C:\\Program Files' })).toBe('Windows installer, custom folder');
    expect(facts.installKind('darwin', '/Applications/Chat On Steroids.app/Contents/MacOS/Chat On Steroids', {})).toBe('macOS app in /Applications');
    expect(facts.installKind('darwin', '/private/var/folders/x/AppTranslocation/1/d/Chat On Steroids.app/Contents/MacOS/Chat On Steroids', {})).toBe('macOS app run from a translocated copy (not moved to Applications)');
    expect(facts.installKind('darwin', '/Users/jane/Downloads/Chat On Steroids.app/Contents/MacOS/Chat On Steroids', {})).toBe('macOS app outside /Applications');
    expect(facts.installKind('linux', '/tmp/.mount_x/chat-on-steroids', { APPIMAGE: '/home/jane/Apps/cos.AppImage' })).toBe('Linux AppImage');
    expect(facts.installKind('linux', '/opt/Chat On Steroids/chat-on-steroids', {})).toBe('Linux package (/opt)');
    for (const line of [facts.installKind('win32', 'C:\\Users\\jane\\x.exe', {}), facts.installKind('darwin', '/Users/jane/Downloads/x', {})]) {
      expect(line).not.toContain('jane');
    }
  });

  it('says whether updates can install and how the last one went', () => {
    const now = Date.UTC(2026, 9, 15, 12);
    expect(facts.installLines({ kind: 'Windows installer, custom folder', packaged: true, folderWritable: false, quarantined: null,
      update: { current: '2.1.38', latest: '2.1.39', stage: 'failed', error: 'download failed', checkedAt: now - 7 * 60_000, notInstalled: '2.1.37' }, now })).toEqual([
      'Installed as: Windows installer, custom folder (packaged)',
      'App folder writable by the app: no',
      'Update: failed, latest 2.1.39, checked 7 min ago',
      'Last update error: download failed',
      'Handed to the installer but not installed: 2.1.37'
    ]);
    expect(facts.installLines({ kind: 'macOS app in /Applications', packaged: true, folderWritable: true, quarantined: true,
      update: { current: '2.1.38', latest: '2.1.38', stage: 'idle', error: null, checkedAt: null }, now })).toEqual([
      'Installed as: macOS app in /Applications (packaged)',
      'App folder writable by the app: yes',
      'macOS download quarantine still set: yes',
      'Update: idle, latest 2.1.38, not checked yet'
    ]);
    // After a check, no `latest` means nothing newer was published (seen on the 2.1.39 RC).
    expect(facts.installLines({ kind: 'macOS app in /Applications', packaged: true, folderWritable: true, quarantined: null,
      update: { current: '2.1.39', latest: null, stage: 'idle', error: null, checkedAt: now - 4 * 60_000 }, now })[2]).toBe('Update: up to date (2.1.39), checked 4 min ago');
  });

  it('describes the machine in numbers', () => {
    expect(facts.systemLines({ totalBytes: 16 * 2 ** 30, freeBytes: 3.5 * 2 ** 30, cpuModel: 'Apple M3', cpuCount: 8, diskFreeBytes: 120 * 2 ** 30,
      uptimeSeconds: 3 * 3600 + 120, scaleFactors: [2, 1] })).toEqual([
      'Memory: 16.0 GB total, 3.5 GB free',
      'CPU: Apple M3, 8 cores',
      'Free disk space where the app keeps its data: 120.0 GB',
      'App running for 3 h 2 min',
      'Display scale: 2, 1'
    ]);
  });
});

describe('chats', () => {
  it('describes each active chat by kind and state, numbered instead of named', () => {
    const now = Date.UTC(2026, 9, 15, 12);
    const lines = facts.chatLines([
      { id: 's1', title: 'Secret plan', updatedAt: now - 5 * 60_000, endedAt: null, toolCalls: 12, processExitNonzero: 1, toolRejected: 0,
        selectedModel: { model: 'gpt-6' }, lastToolCallAt: now - 5 * 60_000 },
      { id: 's2', title: 'Worker', updatedAt: now - 60_000, endedAt: null, toolCalls: 3, processExitNonzero: 0, toolRejected: 2,
        workerAssignment: { role: 'worker' }, lastToolCallAt: null },
      { id: 's3', title: 'Old', updatedAt: now - 3 * 86_400_000, endedAt: null, toolCalls: 1, processExitNonzero: 0, toolRejected: 0, lastToolCallAt: null },
      { id: 's4', title: 'Ended', updatedAt: now - 60_000, endedAt: now - 60_000, toolCalls: 1, processExitNonzero: 0, toolRejected: 0, lastToolCallAt: null }
    ], [{ sessionId: 's1', state: 'queued' }, { sessionId: 's1', state: 'sending' }, { sessionId: null, state: 'queued' }], now);
    expect(lines).toEqual([
      '#1 worker chat: active 1 min ago, 3 tool call(s), 0 failed command(s), 2 refused, inputs: none',
      '#2 main chat, model gpt-6: active 5 min ago, 12 tool call(s), 1 failed command(s), 0 refused, inputs: queued 1, sending 1',
      'Older or ended chats: 2; inputs without a chat: 1'
    ]);
    expect(lines.join('\n')).not.toMatch(/Secret|s1|s2/);
  });

  // Seen on the 2.1.39 RC (Windows): the oldest of a day's chats came first and the list had no end.
  it('lists the most recently active chats first, at most 15', () => {
    const now = Date.UTC(2026, 9, 15, 12);
    const many = Array.from({ length: 20 }, (_, index) => ({ id: `c${index}`, updatedAt: now - (index + 1) * 60_000, endedAt: null, toolCalls: index,
      processExitNonzero: 0, toolRejected: 0, lastToolCallAt: null }));
    const lines = facts.chatLines(many, [], now);
    expect(lines[0]).toMatch(/^#1 main chat: active 1 min ago, 0 tool call/);
    expect(lines.filter(line => line.startsWith('#'))).toHaveLength(15);
    expect(lines.at(-1)).toBe('Older or ended chats: 0; inputs without a chat: 0; 5 more active chat(s) not listed');
  });
});
