/**
 * Vitest setup file that records the JSON the TypeScript app writes while its own tests run.
 *
 * Each hook calls the original first and only copies what the real code produced. Two things
 * change: random ids and tokens come from a seeded generator, so a rerun records the same ones,
 * and no two `Date.now()` reads return the same millisecond. Files are recognised by their path under a test's userData folder, except the
 * `state/*` ledgers, which are recorded as the app hands each generation to `durable.ts`.
 * HTTP exchanges are recognised by the server-side request line. Raw captures go to COS_FIXTURE_HARVEST and
 * select-fixtures.mjs turns them into the committed fixtures.
 */
import fs from 'node:fs';
import http from 'node:http';
import crypto, { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import { WebSocket } from 'ws';

const out = process.env.COS_FIXTURE_HARVEST;
const testFile = (): string => {
  const state = expect.getState();
  return state?.testPath ? path.basename(state.testPath) : 'unknown';
};

const FILE_KINDS: Array<[RegExp, (match: RegExpExecArray) => string]> = [
  [/[\\/]config\.json$/, () => 'config'],
  [/[\\/]state[\\/]([a-z0-9-]{1,40})\.json$/, (m) => `state/${m[1]}`],
  [/[\\/]sessions[\\/][0-9a-z-]{8,64}[\\/]meta\.json$/i, () => 'session/meta'],
  [/[\\/]sessions[\\/][0-9a-z-]{8,64}[\\/]messages[\\/][0-9a-f]{64}\.json$/i, () => 'session/message'],
  [/[\\/]sessions[\\/][0-9a-z-]{8,64}[\\/]messages\.json$/i, () => 'session/legacy-messages'],
  [/[\\/]sessions[\\/][0-9a-z-]{8,64}[\\/]plan\.json$/i, () => 'session/plan'],
  [/[\\/]sessions[\\/][0-9a-z-]{8,64}[\\/]traces[\\/][^\\/]+\.json$/i, () => 'session/trace'],
  [/[\\/]sessions[\\/][0-9a-z-]{8,64}[\\/]handoffs[\\/][^\\/]+\.json$/i, () => 'session/handoff'],
  [/[\\/]sessions[\\/][0-9a-z-]{8,64}[\\/]events\.jsonl$/i, () => 'session/events'],
  [/[\\/]control-api[\\/]endpoint\.json$/, () => 'control-api/endpoint']
];

function classify(file: string): string | null {
  for (const [pattern, name] of FILE_KINDS) {
    const match = pattern.exec(file);
    if (match) return name(match);
  }
  return null;
}

function record(kind: string, text: string, meta: Record<string, unknown> = {}): void {
  if (!out || !text) return;
  const digest = createHash('sha1').update(kind).update('\0').update(text).update('\0').update(String(meta.request ?? '')).digest('hex');
  const dir = path.join(out, 'raw', ...kind.split('/'));
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${digest}.json`), JSON.stringify({ kind, source: testFile(), ...meta, text }));
  } catch {
    // Harvesting is best effort and never fails the test that is running.
  }
}

/**
 * Who chose the bytes: `app` when app code produced them, `test` when a test wrote them itself
 * to seed a legacy or damaged input. `durable.ts` only stores what it is handed, so the frame
 * that called it decides. Seeded inputs describe what a loader must survive, not what the app
 * writes, and are kept apart from the round-trip fixtures.
 */
function writerOf(stack: string | undefined, viaDurable = false): 'app' | 'test' {
  let durable = viaDurable;
  const frames = (stack ?? '').split('\n').slice(1).map((line) => line.replace(/\\/g, '/'));
  for (const [index, frame] of frames.entries()) {
    if (/\/src\/main\/durable\.ts/.test(frame)) { durable = true; continue; }
    if (/harvest-setup|node:|node_modules/.test(frame)) continue;
    // A test can stand in for main/index.ts wiring: app code calls it back to persist a snapshot
    // the app made, as in `onSwarmPersist(() => writeDurableSoon('swarm', snapshotSwarm()))`.
    if (/\/test\/[^/]+\.ts/.test(frame)) {
      return viaDurable && frames.slice(index + 1).some((below) => /\/src\//.test(below)) ? 'app' : 'test';
    }
    // A generator stands in for main/index.ts wiring only when it hands a snapshot to durable.ts.
    if (/fixture-gen\/[^/]+\.gen\.ts/.test(frame)) return durable ? 'app' : 'test';
    if (/\/src\//.test(frame)) return 'app';
  }
  return 'app';
}

function isJson(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object';
  } catch {
    return false;
  }
}

function recordFile(file: string, stack: string | undefined, appended?: string): void {
  const kind = classify(String(file));
  // Ledgers are recorded at the durable.ts boundary below; their file writes are not.
  if (!kind || kind.startsWith('state/')) return;
  const writer = writerOf(stack);
  if (kind === 'session/events') {
    for (const line of (appended ?? '').split('\n')) if (line.trim()) record(kind, line, { writer });
    return;
  }
  try {
    record(kind, fs.readFileSync(file, 'utf8'), { writer });
  } catch {
    // The file may already have been replaced again; a later write is captured instead.
  }
}

/**
 * Makes the random ids and tokens the app draws repeat on every harvest. Each draw is derived
 * from the test that is running, the line of code that asked, and how many times that line has
 * asked in this test. A retry loop that draws a varying number of times then cannot shift the
 * ids drawn elsewhere. Nothing secret is made here.
 */
function seedRandomness(): void {
  const counters = new Map<string, number>();
  // A frame names its file by absolute path, so the checkout's own folder is cut out of the key:
  // otherwise every worktree would harvest different ids.
  const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..').replace(/\\/g, '/').toLowerCase();
  const draw = (size: number): Buffer => {
    const frame = (new Error().stack ?? '').split('\n').slice(1)
      .find((line) => !/harvest-setup|node:/.test(line))?.trim() ?? '';
    const slashed = frame.replace(/\\/g, '/');
    const at = slashed.toLowerCase().indexOf(checkout);
    const site = at < 0 ? slashed : slashed.slice(0, at) + slashed.slice(at + checkout.length);
    const test = expect.getState().currentTestName ?? '';
    const key = `${testFile()}\0${test}\0${site}`;
    const count = (counters.get(key) ?? 0) + 1;
    counters.set(key, count);
    const blocks: Buffer[] = [];
    for (let block = 0; blocks.length * 32 < size; block++) {
      blocks.push(createHash('sha256').update(`${key}\0${count}\0${block}`).digest());
    }
    return Buffer.concat(blocks).subarray(0, size);
  };
  const fill = <T extends ArrayBufferView>(view: T): T => {
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(draw(view.byteLength));
    return view;
  };
  const uuid = (): `${string}-${string}-${string}-${string}-${string}` => {
    const bytes = draw(16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const randomBytes = (size: number, callback?: (error: Error | null, bytes: Buffer) => void): Buffer | undefined => {
    const bytes = draw(size);
    if (!callback) return bytes;
    process.nextTick(callback, null, bytes);
    return undefined;
  };
  const patched = crypto as unknown as Record<string, unknown>;
  patched.randomUUID = uuid;
  patched.randomBytes = randomBytes;
  patched.randomFillSync = fill;
  globalThis.crypto.randomUUID = uuid;
  globalThis.crypto.getRandomValues = fill as typeof globalThis.crypto.getRandomValues;
  Math.random = () => draw(4).readUInt32LE(0) / 2 ** 32;

  // mkdtemp's six random characters end up in recorded paths, so they are drawn the same way.
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const mkdtempSync = (prefix: string): string => {
    for (;;) {
      const folder = `${prefix}${[...draw(6)].map((byte) => LETTERS[byte % LETTERS.length]).join('')}`;
      try {
        fs.mkdirSync(folder);
        return folder;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  };
  const sync = fs as unknown as Record<string, unknown>;
  sync.mkdtempSync = mkdtempSync;
  sync.mkdtemp = (prefix: string, ...rest: unknown[]) => {
    const callback = rest.at(-1) as (error: Error | null, folder?: string) => void;
    try {
      const folder = mkdtempSync(prefix);
      process.nextTick(callback, null, folder);
    } catch (error) {
      process.nextTick(callback, error as Error);
    }
  };
  (fs.promises as unknown as Record<string, unknown>).mkdtemp = async (prefix: string) => mkdtempSync(prefix);
  syncBuiltinESMExports();
}

/**
 * Makes every `Date.now()` read later than the one before it. The app compares times it took in
 * order, such as an offer and the call that acknowledges it (`offeredAt < callStartedAt` in
 * `agents.ts`). Two such reads share a millisecond in some runs and not in others, and that
 * decided whether `test/agents.test.ts` recorded the prime's `delivered` event, which shifted
 * every later `seq` in its shared prime session. With this clock, program order decides those
 * comparisons. A burst of reads runs ahead of the real clock by one millisecond per read and
 * rejoins it once the real clock passes.
 */
function orderClock(): void {
  const now = Date.now.bind(Date);
  let last = 0;
  Date.now = () => (last = Math.max(last + 1, now()));
}

/**
 * Every generation of a `state/*` ledger, recorded when the app hands it to `durable.ts`.
 *
 * A background write reaches the disk on a 300 ms timer that keeps only the newest generation,
 * so which generations a file write would show depends on how fast the test ran: one run caught
 * a swarm worker before its `revivable` flag flipped and the next did not. The generations the
 * app queues depend only on what the test did.
 */
const durableHarvest = { active: false };
function recordLedger(name: string, value: unknown, stack: string | undefined): void {
  if (!durableHarvest.active || value === null || value === undefined) return;
  record(`state/${name}`, JSON.stringify(value), { writer: writerOf(stack, true) });
}
/**
 * The swarm's critical lane (`persistCriticalSwarmNow`) snapshots whatever the broker holds when
 * the previous disk write returns, so it folds together the mutations that landed during that
 * write and its generations depend on disk timing. The snapshot `main/index.ts` also queues
 * after every mutation (`onSwarmPersist`) depends only on the mutations, so the swarm ledger is
 * recorded from that, at each change, and never from the durable writes.
 */
const SWARM_LEDGER = 'swarm';
vi.mock('../../../../src/main/agents.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../src/main/agents.ts')>();
  real.onSwarmChange(() => recordLedger(SWARM_LEDGER, real.snapshotSwarm(), new Error().stack));
  return real;
});
vi.mock('../../../../src/main/durable.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../src/main/durable.ts')>();
  return {
    ...real,
    initDurableStore: (dir: string) => { real.initDurableStore(dir); durableHarvest.active = true; },
    resetDurableForTests: () => { real.resetDurableForTests(); durableHarvest.active = false; },
    writeDurableSoon: (name: string, value: unknown) => {
      if (name !== SWARM_LEDGER) recordLedger(name, value, new Error().stack);
      real.writeDurableSoon(name, value);
    },
    writeDurableSnapshotSoon: (name: string, snapshot: () => unknown) => {
      if (name !== SWARM_LEDGER) recordLedger(name, snapshot(), new Error().stack);
      real.writeDurableSnapshotSoon(name, snapshot);
    },
    writeDurableNow: (name: string, value: unknown) => {
      if (name !== SWARM_LEDGER) recordLedger(name, value, new Error().stack);
      return real.writeDurableNow(name, value);
    },
    recoverDurable: (name: string, value: unknown) => {
      if (name !== SWARM_LEDGER) recordLedger(name, value, new Error().stack);
      return real.recoverDurable(name, value);
    }
  };
});

if (out) {
  seedRandomness();
  orderClock();
  const promises = fs.promises as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const rename = promises.rename!.bind(fs.promises);
  const writeFile = promises.writeFile!.bind(fs.promises);
  const appendFile = promises.appendFile!.bind(fs.promises);
  promises.rename = async (from: unknown, to: unknown) => {
    const stack = new Error().stack;
    const result = await rename(from, to);
    recordFile(String(to), stack);
    return result;
  };
  promises.writeFile = async (file: unknown, data: unknown, ...rest: unknown[]) => {
    const stack = new Error().stack;
    const result = await writeFile(file, data, ...rest);
    if (typeof file === 'string') {
      const kind = classify(file);
      if (kind === 'session/events' && typeof data === 'string') recordFile(file, stack, data);
      else if (kind) recordFile(file, stack);
    }
    return result;
  };
  promises.appendFile = async (file: unknown, data: unknown, ...rest: unknown[]) => {
    const stack = new Error().stack;
    const result = await appendFile(file, data, ...rest);
    if (typeof file === 'string' && typeof data === 'string') recordFile(file, stack, data);
    return result;
  };
  syncBuiltinESMExports();

  // Wake socket frames. The extension's first frame is its bearer token, so only its `pong` is kept.
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: WebSocket & { _isServer?: boolean }, data: unknown, ...rest: unknown[]) {
    if (typeof data === 'string') {
      if (this._isServer) record('ws/wake', JSON.stringify({ from: 'app', message: data }));
      else if (data === 'pong') record('ws/wake', JSON.stringify({ from: 'extension', message: data }));
    }
    return (send as (...a: unknown[]) => void).apply(this, [data, ...rest]);
  } as typeof WebSocket.prototype.send;

  // A text/event-stream reply is many writes; the whole body is recorded once the stream ends.
  type Streaming = http.ServerResponse & { __stream?: string[]; __streamDone?: boolean; req?: http.IncomingMessage };
  const recordStream = (res: Streaming, last?: unknown) => {
    if (!res.__stream || res.__streamDone) return;
    res.__streamDone = true;
    if (typeof last === 'string') res.__stream.push(last);
    const route = (res.req?.url ?? '').split('?')[0] ?? '';
    // MCP streams belong to the MCP SDK, and their path carries the connector secret.
    if (!route.startsWith('/v1/')) return;
    record('sse/control-api', JSON.stringify({ stream: res.__stream.join('') }), { method: res.req?.method, route, status: res.statusCode });
  };
  const writeHead = http.ServerResponse.prototype.writeHead;
  http.ServerResponse.prototype.writeHead = function (this: Streaming, ...args: unknown[]) {
    const headers = args.slice(1).find((arg) => arg && typeof arg === 'object') as Record<string, unknown> | undefined;
    if (String(headers?.['content-type'] ?? '').startsWith('text/event-stream')) {
      this.__stream = [];
      this.once('close', () => recordStream(this));
    }
    return (writeHead as (...a: unknown[]) => http.ServerResponse).apply(this, args);
  } as typeof http.ServerResponse.prototype.writeHead;
  const write = http.ServerResponse.prototype.write;
  http.ServerResponse.prototype.write = function (this: Streaming, ...args: unknown[]) {
    if (this.__stream && !this.__streamDone && typeof args[0] === 'string') this.__stream.push(args[0]);
    return (write as (...a: unknown[]) => boolean).apply(this, args);
  } as typeof http.ServerResponse.prototype.write;

  const push = http.IncomingMessage.prototype.push;
  http.IncomingMessage.prototype.push = function (this: http.IncomingMessage & { __harvest?: Buffer[] }, chunk: unknown, encoding?: BufferEncoding) {
    if (chunk !== null && chunk !== undefined) {
      (this.__harvest ??= []).push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding));
    }
    return push.call(this, chunk, encoding);
  };
  const end = http.ServerResponse.prototype.end;
  http.ServerResponse.prototype.end = function (this: http.ServerResponse & { req?: http.IncomingMessage & { __harvest?: Buffer[] } }, ...args: unknown[]) {
    try {
      const body = args[0];
      const req = this.req;
      if ((this as Streaming).__stream) recordStream(this as Streaming, body);
      if (req && (typeof body === 'string' || Buffer.isBuffer(body))) {
        const route = (req.url ?? '').split('?')[0] ?? '';
        const plane = route.startsWith('/v1/') ? 'control-api' : route === '/mcp' || route.startsWith('/mcp/') ? null : 'bridge';
        const responseText = Buffer.isBuffer(body) ? body.toString('utf8') : body;
        if (plane && isJson(responseText)) {
          const requestText = req.__harvest ? Buffer.concat(req.__harvest).toString('utf8') : '';
          record(`http/${plane}`, responseText, { method: req.method, route, status: this.statusCode, request: requestText });
        }
      }
    } catch {
      // See record(): never fail a test because a capture did not work.
    }
    return (end as (...a: unknown[]) => http.ServerResponse).apply(this, args);
  } as typeof http.ServerResponse.prototype.end;
}
