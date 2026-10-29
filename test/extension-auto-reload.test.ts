import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const code = background.slice(background.indexOf('let extensionReloadPending = false;'), background.indexOf('async function maintainOnce() {'));

function worker(options: { running?: string; pings?: Array<object | null>; prepared?: object; attempt?: string; firefox?: boolean; openings?: Record<string, object> } = {}) {
  const store: Record<string, unknown> = options.attempt ? { extensionReloadAttempt: options.attempt } : {};
  const reload = vi.fn();
  const call = vi.fn(async () => ({ ok: true, data: options.prepared ?? { build: 'bbbbbbbbbbbb', ready: true } }));
  const pings = options.pings ?? [{ ok: true, busy: false }];
  const context = vm.createContext({
    CHATGPT_TAB_URLS: ['https://chatgpt.com/*'], workerStampReady: Promise.resolve(), workerStampValue: options.running ?? 'aaaaaaaaaaaa', call,
    inputOpenings: options.openings ?? {},
    tabReply: async (id: number) => pings[id - 1] ?? null,
    chrome: { runtime: { reload, ...(options.firefox ? { getBrowserInfo: async () => ({ name: 'Firefox' }) } : {}) }, tabs: { query: async () => pings.map((_, index) => ({ id: index + 1 })) },
      storage: { local: { get: async (key: string) => ({ [key]: store[key] }), set: async (value: Record<string, unknown>) => Object.assign(store, value) } } }
  });
  vm.runInContext(`${code}\nglobalThis.run = reloadForExtensionUpdate; globalThis.hold = () => extensionUpdateHold;`, context);
  const run = (offer: unknown = { build: 'bbbbbbbbbbbb', busy: false }, busy: { inputs?: string[]; commands?: string[]; sending?: string[] } = {}) =>
    (context.run as Function)(offer, new Set(busy.inputs ?? []), new Set(busy.commands ?? []), busy.sending ? new Set(busy.sending) : null);
  return { run, reload, call, store, hold: () => (context.hold as Function)() as string | null };
}

it('reloads into the offered build once everything is idle and the folder is ready', async () => {
  const h = worker({ pings: [{ ok: true, busy: false }, null] }); // a tab without a receiver has nothing running
  await h.run();
  expect(h.call).toHaveBeenCalledWith('/extension/update', expect.objectContaining({ method: 'POST' }));
  expect(h.reload).toHaveBeenCalledTimes(1);
  expect(h.store.extensionReloadAttempt).toBe('aaaaaaaaaaaa>bbbbbbbbbbbb');
});

it.each([
  ['an input in flight', undefined, { inputs: ['i'] }],
  ['a command in flight', undefined, { commands: ['x'] }],
  ['a running tool call in the app', { build: 'bbbbbbbbbbbb', busy: true }, {}],
  ['an app that does not say', { build: 'bbbbbbbbbbbb' }, {}]
])('waits while there is %s', async (_label, offer, busy) => {
  const h = worker();
  await h.run(offer, busy);
  expect(h.call).not.toHaveBeenCalled();
  expect(h.reload).not.toHaveBeenCalled();
});

it('waits for a generating page and for an older page that cannot say whether it is busy', async () => {
  for (const ping of [{ ok: true, busy: true }, { ok: true, recorderVersion: 21 }]) {
    const h = worker({ pings: [ping] });
    await h.run();
    expect(h.reload).not.toHaveBeenCalled();
  }
});

it('never reloads for no offer, the same build, a folder that is not ready, or a repeated attempt', async () => {
  for (const [options, offer] of [
    [{}, null], [{}, { build: 'not-a-stamp', busy: false }], [{ running: 'bbbbbbbbbbbb' }, undefined],
    [{ prepared: { build: 'bbbbbbbbbbbb', ready: false } }, undefined],
    [{ attempt: 'aaaaaaaaaaaa>bbbbbbbbbbbb' }, undefined]
  ] as const) {
    const h = worker(options as never);
    await h.run(offer as never);
    expect(h.reload).not.toHaveBeenCalled();
  }
});

it.each([
  ['an input in flight', undefined, { inputs: ['i'] }, {}, 'sending'],
  ['a command in flight', undefined, { commands: ['x'] }, {}, 'commands'],
  ['a running tool call in the app', { build: 'bbbbbbbbbbbb', busy: true }, {}, {}, 'app-busy'],
  ['a generating page', undefined, {}, { pings: [{ ok: true, busy: true }] }, 'chat-busy'],
  ['a repeated attempt', undefined, {}, { attempt: 'aaaaaaaaaaaa>bbbbbbbbbbbb' }, 'already-tried'],
  ['a folder that is not ready', undefined, {}, { prepared: { build: 'bbbbbbbbbbbb', ready: false } }, 'folder-not-ready']
])('says why it waits to update: %s', async (_label, offer, busy, options, reason) => {
  // 2026-10-03: an idle browser kept the old build after an app update and nothing said why.
  const h = worker(options as never);
  await h.run(offer as never, busy);
  expect(h.reload).not.toHaveBeenCalled();
  expect(h.hold()).toBe(reason);
});

it('clears the reason once nothing is offered or the update goes ahead', async () => {
  const h = worker({ pings: [{ ok: true, busy: true }] });
  await h.run();
  expect(h.hold()).toBe('chat-busy');
  await h.run(null);
  expect(h.hold()).toBeNull();
  const ready = worker();
  await ready.run();
  expect(ready.reload).toHaveBeenCalledTimes(1);
  expect(ready.hold()).toBeNull();
});

// A signed Firefox add-on is installed from its .xpi: Firefox updates it through its update
// manifest, and reloading the worker only reloads the same build. Nothing is copied or reloaded.
it('leaves updating to Firefox itself', async () => {
  const h = worker({ firefox: true });
  await h.run();
  expect(h.call).not.toHaveBeenCalled();
  expect(h.reload).not.toHaveBeenCalled();
  expect(h.hold()).toBe('browser-updates-itself');
});

// 2.1.47 round (the user's Mac): an automatic Continue queued in a chat ChatGPT had blocked waited
// for hours, and the update waited with it: every open message counted as "being sent".
it('updates past a message that only waits in the queue, but not past one being sent or prepared', async () => {
  const queued = worker();
  await queued.run(undefined, { inputs: ['q'], sending: [] });
  expect(queued.reload).toHaveBeenCalledTimes(1);

  const claimed = worker();
  await claimed.run(undefined, { inputs: ['s'], sending: ['s'] });
  expect(claimed.reload).not.toHaveBeenCalled();
  expect(claimed.hold()).toBe('sending');

  // A tab this browser is opening or preparing for the queued message counts: reloading would drop it mid-way.
  for (const stage of ['opening', 'preparing']) {
    const preparing = worker({ openings: { q: { tab: 7, stage } } });
    await preparing.run(undefined, { inputs: ['q'], sending: [] });
    expect(preparing.reload).not.toHaveBeenCalled();
    expect(preparing.hold()).toBe('sending');
  }
  // A tab only kept for it (ready, the send check holding the message) prepares nothing (CodeRabbit).
  const kept = worker({ openings: { q: { tab: 7, stage: 'ready' } } });
  await kept.run(undefined, { inputs: ['q'], sending: [] });
  expect(kept.reload).toHaveBeenCalledTimes(1);

  // An app that does not list the messages being sent keeps the old, careful rule.
  const older = worker();
  await older.run(undefined, { inputs: ['q'] });
  expect(older.reload).not.toHaveBeenCalled();
  expect(older.hold()).toBe('sending');
});

it('waits when the app says a message went out since its last status (CodeRabbit on #1901)', async () => {
  const h = worker({ prepared: { ready: false, hold: 'sending' } });
  await h.run(undefined, { inputs: [], sending: [] });
  expect(h.reload).not.toHaveBeenCalled();
  expect(h.hold()).toBe('sending');
});
