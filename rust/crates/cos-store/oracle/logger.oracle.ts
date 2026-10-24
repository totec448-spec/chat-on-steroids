/**
 * app.log through logger.ts at a fixed clock: masking, the line bound, the file's line format,
 * the clipboard and JSON exports, the in-memory ring and one rotation.
 */
import { afterAll, beforeAll, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { record } from './record.js';

const agent = vi.hoisted(() => ({ name: undefined as string | undefined }));
vi.mock('../../../../src/main/mcp/call-context.js', () => ({ currentAgent: () => agent.name }));

const logger = await import('../../../../src/main/logger.js');
const { makeTempDir, removeTempDir } = await import('../../../../test/helpers.js');

let dir: string;
beforeAll(async () => {
  dir = await makeTempDir('cos-store-logger-');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterAll(async () => {
  vi.useRealTimers();
  await removeTempDir(dir);
});

const NOW = Date.UTC(2026, 9, 19, 8, 5, 3, 7);
const KEY = 'sk-proj-abcdefgh12345678';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVlLWhlcmU';

const redactions = [
  'plain text stays',
  `key ${KEY} in the middle`,
  'sk-short',
  `(${KEY})`,
  `jwt ${JWT} end`,
  `token ${'A'.repeat(40)} end`,
  `token ${'A'.repeat(39)} end`,
  `path C:\\Users\\x\\${'b'.repeat(45)}.txt`,
  `dashes ${'-'.repeat(50)} only`,
  `mixed ${'a1_-'.repeat(12)}-tail`,
  `${'é'.repeat(3)}${'Z'.repeat(41)}`,
  'tunnel_0123456789abcdef0123456789abcdef'
];

const lines: Array<{ level: 'info' | 'warn' | 'error'; message: string; agent?: string }> = [
  { level: 'info', message: 'app started' },
  { level: 'warn', message: `could not read swarm state: bad ${KEY}` },
  { level: 'error', message: 'multi\nline\tmessage' },
  { level: 'info', message: 'from a worker', agent: 'worker-1' },
  { level: 'info', message: 'agent with secret', agent: `prime ${KEY} ${'q'.repeat(300)}` },
  { level: 'info', message: 'word '.repeat(4000) },
  { level: 'info', message: 'é'.repeat(9000) },
  { level: 'info', message: `a${'😀'.repeat(9000)}` },
  { level: 'warn', message: 'ünïcödé ✓ 日本語' },
  { level: 'info', message: '' }
];

it('records the log', async () => {
  const file = path.join(dir, 'app.log');
  logger.initLogFile(file);
  for (const line of lines) {
    agent.name = line.agent;
    logger.log(line.level, line.message);
  }
  agent.name = undefined;
  await logger.flushLogFile();
  const entries = logger.getLog();
  logger.resetLoggerForTests();
  for (let i = 0; i < 505; i++) logger.logInfo(`line ${i}`);
  const ringEntries = logger.getLog();
  logger.resetLoggerForTests();

  const rotating = path.join(dir, 'rotate.log');
  writeFileSync(rotating, 'r'.repeat(4 * 1024 * 1024 - 10));
  logger.initLogFile(rotating);
  logger.logInfo('this line no longer fits');
  await logger.flushLogFile();
  logger.resetLoggerForTests();

  record('logger', {
    now: NOW,
    redactions: redactions.map((input) => ({ input, output: logger.redact(input) })),
    lines,
    file: readFileSync(file, 'utf8'),
    entries,
    ring: { written: 505, kept: ringEntries.length, first: ringEntries[0]?.message, last: ringEntries.at(-1)?.message },
    rotation: {
      before: 4 * 1024 * 1024 - 10,
      current: readFileSync(rotating, 'utf8'),
      previousLength: existsSync(`${rotating}.1`) ? readFileSync(`${rotating}.1`).length : null
    }
  });
});

it('records the exports', async () => {
  logger.resetLoggerForTests();
  for (const line of lines.slice(0, 4)) {
    agent.name = line.agent;
    logger.log(line.level, line.message);
  }
  agent.name = undefined;
  record('logger-exports', { clipboard: logger.formatLogForClipboard(), json: logger.formatLogAsJson() });
  logger.resetLoggerForTests();
});
