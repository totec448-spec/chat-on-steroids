/**
 * state/<name>.json through durable.ts: what a plain and a strict read return for each file,
 * the bytes a write leaves, and how one ledger owner (blocked chats) keeps the valid rows of a
 * partly damaged file.
 */
import { afterAll, beforeAll, it, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { contents, record } from './record.js';

const { makeTempDir, removeTempDir } = await import('../../../../test/helpers.js');

let dir: string;
beforeAll(async () => { dir = await makeTempDir('cos-store-durable-'); });
afterAll(async () => { await removeTempDir(dir); });

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const ID_A = '68f1c2d4-1111-4bbb-8ccc-0123456789ab';
const ID_B = 'abcdef01-2222-4ccc-8ddd-0123456789ab';

async function fresh(folder: string) {
  vi.resetModules();
  const durable = await import('../../../../src/main/durable.js');
  const logger = await import('../../../../src/main/logger.js');
  const blocked = await import('../../../../src/main/session/blocked-chats.js');
  mkdirSync(folder, { recursive: true });
  durable.initDurableStore(folder);
  return { durable, logger, blocked };
}

/** File contents under state/<name>.json; `null` means no file, `{ directory: true }` a folder. */
const reads: Record<string, string | Buffer | null | { directory: true }> = {
  'missing': null,
  'directory-in-place': { directory: true },
  'valid-object': JSON.stringify({ version: 1, entries: [{ conversationId: ID_A, blockedAt: 5 }] }),
  'valid-array': '[1,"two",{"three":3}]',
  'valid-pretty-with-trailing-newline': '{\n  "a": [1, 2]\n}\n',
  'json-null': 'null',
  'json-number': '42',
  'empty-file': '',
  'whitespace-only': ' \n',
  'truncated': '{"version":1,"entries":[{"conversationId":"68f1c2d4-1111',
  'corrupted-bytes': Buffer.from([0x00, 0x13, 0x37, 0xff, 0x7b]),
  'trailing-garbage': '{"a":1}x',
  'bom-prefixed': '﻿{"a":1}',
  'invalid-utf8-in-string': Buffer.concat([Buffer.from('{"a":"x', 'utf8'), Buffer.from([0xc3, 0x28]), Buffer.from('y"}', 'utf8')]),
  'duplicate-keys': '{"a":1,"b":2,"a":3}'
};

it('records durable reads', async () => {
  const results: Record<string, unknown> = {};
  for (const [name, input] of Object.entries(reads)) {
    const folder = path.join(dir, 'reads', name);
    const { durable, logger } = await fresh(folder);
    const file = path.join(folder, 'state', 'probe.json');
    mkdirSync(path.dirname(file), { recursive: true });
    const directory = input !== null && typeof input === 'object' && 'directory' in input;
    if (directory) mkdirSync(file);
    else if (input !== null) writeFileSync(file, input as string | Buffer);
    const plain = await durable.readDurable('probe');
    let strict: unknown;
    try { strict = { value: await durable.readDurable('probe', { strict: true }) }; }
    catch (error) { strict = { error: (error as Error).message }; }
    results[name] = {
      input: input === null ? null : directory ? { directory: true } : contents(Buffer.isBuffer(input) ? input : Buffer.from(input as string, 'utf8')),
      plain,
      strict,
      warned: logger.getLog().some((entry) => entry.level === 'warn' && entry.message.startsWith('could not read probe state: '))
    };
  }
  record('durable-read', { cases: results });
});

const writes: Record<string, unknown> = {
  'object': { version: 1, entries: [{ conversationId: ID_A, blockedAt: NOW }] },
  'text-escapes': { text: 'quote " backslash \\ newline \n tab \t nul \u0000 bell \u0007 del \u007f ls   é 😀 </script>' },
  'numbers': { ints: [0, -1, 9007199254740991], fractions: [0.5, -2.25, 1e-7, 123456.789], big: 1e21 },
  'empty-containers': { a: [], o: {}, s: '' },
  'array-root': [true, false, null, 'x'],
  'null-removes-file': null
};

it('records durable writes', async () => {
  const results: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(writes)) {
    const folder = path.join(dir, 'writes', name);
    const { durable } = await fresh(folder);
    const file = path.join(folder, 'state', 'probe.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '"previous"');
    await durable.writeDurableNow('probe', value);
    results[name] = {
      value,
      file: existsSync(file) ? readFileSync(file, 'utf8') : null,
      leftovers: readdirSync(path.dirname(file)).filter((entry) => entry !== 'probe.json').sort()
    };
  }
  record('durable-write', { cases: results });
});

it('records durable name checks and recovery', async () => {
  const folder = path.join(dir, 'names');
  const { durable } = await fresh(folder);
  const names: Record<string, boolean> = {};
  for (const name of ['swarm', 'request-plans', 'a', 'a'.repeat(40), 'a'.repeat(41), '', 'Swarm', 'x_y', '../x', 'state.json', 'tab\t']) {
    try { await durable.writeDurableNow(name, { ok: true }); names[name] = true; } catch { names[name] = false; }
  }
  const recoveryFolder = path.join(dir, 'recovery');
  const recovery = await fresh(recoveryFolder);
  const state = path.join(recoveryFolder, 'state');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'probe.json'), '{"damaged":');
  await recovery.durable.recoverDurable('probe', { version: 1, entries: [] });
  const files = readdirSync(state).sort();
  const copy = files.find((file) => file.startsWith('probe.recovery-'));
  record('durable-names', {
    names,
    recovery: {
      original: '{"damaged":',
      replacement: { version: 1, entries: [] },
      file: readFileSync(path.join(state, 'probe.json'), 'utf8'),
      copyPattern: copy?.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, '<uuid>'),
      copy: copy ? readFileSync(path.join(state, copy), 'utf8') : null,
      fileCount: files.length
    }
  });
});

const ledgers: Record<string, unknown> = {
  'valid': { version: 1, entries: [{ conversationId: ID_A, blockedAt: 10 }, { conversationId: ID_B, blockedAt: 20 }] },
  'partly-invalid-rows': {
    version: 1,
    entries: [
      { conversationId: ID_A, blockedAt: 10 }, null, 7, 'x', { conversationId: 'short' }, { conversationId: 'has space in it' },
      { conversationId: ID_B, blockedAt: 'yesterday' }, { conversationId: 'UPPER-case-ID-1234', blockedAt: 1.5 }, { blockedAt: 3 },
      { conversationId: ID_A, blockedAt: 99 }, { conversationId: 'z'.repeat(65), blockedAt: 1 }
    ]
  },
  'wrong-version': { version: 2, entries: [{ conversationId: ID_A, blockedAt: 10 }] },
  'entries-not-array': { version: 1, entries: { conversationId: ID_A } },
  'not-an-object': [1, 2],
  'over-the-cap': { version: 1, entries: Array.from({ length: 205 }, (_, i) => ({ conversationId: `conv-${String(i).padStart(4, '0')}`, blockedAt: i })) }
};

it('records blocked-chats restores', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  try {
    const results: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(ledgers)) {
      const folder = path.join(dir, 'ledgers', name);
      const { blocked } = await fresh(folder);
      mkdirSync(path.join(folder, 'state'), { recursive: true });
      writeFileSync(path.join(folder, 'state', 'blocked-chats.json'), JSON.stringify(value));
      await blocked.restoreBlockedChats();
      results[name] = { file: value, restored: blocked.blockedChatIds().map((id) => [id, blocked.chatBlockedAt(id)]) };
    }
    record('blocked-chats', { now: NOW, cases: results });
  } finally {
    vi.useRealTimers();
  }
});

/**
 * durableRevision over a script of ledger operations: after each step, whether each ledger's
 * revision differs from the one read after the step before.
 */
const revisionSteps: { step: string; name?: string }[] = [
  { step: 'start' },
  { step: 'write-now', name: 'a' },
  { step: 'write-now-same-value', name: 'a' },
  { step: 'write-soon', name: 'b' },
  { step: 'flush' },
  { step: 'flush' },
  { step: 'remove-now', name: 'a' },
  { step: 'remove-now-missing', name: 'a' },
  { step: 'recover', name: 'b' },
  { step: 'recover-missing', name: 'a' },
  { step: 'write-now-blocked-by-folder', name: 'a' },
  { step: 'unblock-and-flush', name: 'a' },
  { step: 'reopen' }
];

it('records durable revisions', async () => {
  const folder = path.join(dir, 'revisions');
  let { durable } = await fresh(folder);
  const state = path.join(folder, 'state');
  mkdirSync(state, { recursive: true });
  const names = ['a', 'b'] as const;
  let seen = Object.fromEntries(names.map(name => [name, durable.durableRevision(name)]));
  const steps: unknown[] = [];
  for (const { step, name } of revisionSteps) {
    let failed = false;
    const attempt = async (work: () => Promise<void>) => { try { await work(); } catch { failed = true; } };
    switch (step) {
      case 'start': break;
      case 'write-now': case 'write-now-same-value': await attempt(() => durable.writeDurableNow(name!, { v: 1 })); break;
      case 'write-soon': durable.writeDurableSoon(name!, { v: 2 }); break;
      case 'flush': await attempt(() => durable.flushDurable()); break;
      case 'remove-now': case 'remove-now-missing': await attempt(() => durable.writeDurableNow(name!, null)); break;
      case 'recover': await attempt(() => durable.recoverDurable(name!, { v: 3 })); break;
      case 'recover-missing': await attempt(() => durable.recoverDurable(name!, { v: 4 })); break;
      case 'write-now-blocked-by-folder':
        mkdirSync(path.join(state, `${name}.json`));
        writeFileSync(path.join(state, `${name}.json`, 'keep'), '');
        await attempt(() => durable.writeDurableNow(name!, { v: 5 }));
        break;
      case 'unblock-and-flush':
        rmSync(path.join(state, `${name}.json`), { recursive: true });
        await attempt(() => durable.flushDurable());
        break;
      case 'reopen': ({ durable } = await fresh(folder)); break;
    }
    const now = Object.fromEntries(names.map(name => [name, durable.durableRevision(name)]));
    steps.push({ step, ...(name ? { name } : {}), failed, changed: Object.fromEntries(names.map(name => [name, now[name] !== seen[name]])) });
    seen = now;
  }
  record('durable-revisions', { steps, files: readdirSync(state).filter(file => !file.includes('.recovery-')).sort() });
});
