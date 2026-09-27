import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const code = background.slice(background.indexOf('let extensionReloadPending = false;'), background.indexOf('async function maintainOnce() {'));

function worker(options: { running?: string; pings?: Array<object | null>; prepared?: object; attempt?: string } = {}) {
  const store: Record<string, unknown> = options.attempt ? { extensionReloadAttempt: options.attempt } : {};
  const reload = vi.fn();
  const call = vi.fn(async () => ({ ok: true, data: options.prepared ?? { build: 'bbbbbbbbbbbb', ready: true } }));
  const pings = options.pings ?? [{ ok: true, busy: false }];
  const context = vm.createContext({
    CHATGPT_TAB_URLS: ['https://chatgpt.com/*'], workerStampReady: Promise.resolve(), workerStampValue: options.running ?? 'aaaaaaaaaaaa', call,
    tabReply: async (id: number) => pings[id - 1] ?? null,
    chrome: { runtime: { reload }, tabs: { query: async () => pings.map((_, index) => ({ id: index + 1 })) },
      storage: { local: { get: async (key: string) => ({ [key]: store[key] }), set: async (value: Record<string, unknown>) => Object.assign(store, value) } } }
  });
  vm.runInContext(`${code}\nglobalThis.run = reloadForExtensionUpdate;`, context);
  const run = (offer: unknown = { build: 'bbbbbbbbbbbb', busy: false }, busy: { inputs?: string[]; commands?: string[] } = {}) =>
    (context.run as Function)(offer, new Set(busy.inputs ?? []), new Set(busy.commands ?? []));
  return { run, reload, call, store };
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
