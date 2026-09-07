/**
 * Compact & Resume has to create the replacement chat inside the Project the source chat is in.
 *
 * A ChatGPT Project is expressed only in the address. `/g/<project>/c/<id>` is a chat filed
 * under a Project, and a conversation created from anywhere else is not in it — there is no
 * parameter, header or later call that moves it. So the successor's URL is the whole mechanism,
 * and issue #84 is that all three places that build one hardcoded the site root.
 *
 * Two details drive most of what is asserted here:
 *
 * The slug in a chat's path is not the Project's identity. ChatGPT appends the Project's current
 * display name to it, so the same Project reads as `g-p-<hex>-example-project` on a chat and
 * as `g-p-<hex>` on the Project's own page. Carrying the chat's slug across verbatim would build
 * an address containing a name that a rename invalidates, so only the `g-p-<hex>` head is ever
 * stored or emitted.
 *
 * And the browser is the only thing that can see it, while the app is the only thing that
 * survives a restart. That is why the Project is observed from the page, written onto the
 * continuation, and read back from there by the fallback that runs when no page is left.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { commandUrl } = await import('../src/main/bridge.js');
const {
  continuationByToken,
  beginContinuationSourceSendNow,
  dispatchContinuationSourceSendNow,
  normalizeProjectId,
  openContinuationNow,
  resetContinuationsForTests,
  restoreContinuations,
  snapshotContinuations
} = await import('../src/main/session/continuation.js');
const { createSession, initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;

const vm = await import('node:vm');
const { readFileSync } = await import('node:fs');

const backgroundSource = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
// The worker is evaluated as a classic script, where an ES import is a parse error. There is
// none today; strip any that appears rather than failing on a change unrelated to this file,
// and supply the binding through the context, as test/extension.test.ts does.
const workerSource = backgroundSource.replace(/^import .*$/gm, '');


/** Synthetic identifiers preserving the observed Project route shape. */
const PROJECT = 'g-p-11111111222233334444555555555555';
const NAMED_SLUG = 'g-p-11111111222233334444555555555555-example-project';
const CHAT_IN_PROJECT = 'abababab-1111-4222-8333-444444444444';
const CHAT_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

beforeAll(async () => {
  dir = await makeTempDir('clf-project-successor-');
  initConfigPath(dir);
  initSessionStore(dir);
  await saveConfig(defaultConfig());
});

afterAll(async () => {
  await removeTempDir(dir);
});

beforeEach(async () => {
  resetContinuationsForTests();
  await resetSessionStoreForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the Project identity carried between a chat and its successor', () => {
  it('accepts only the routing id, and never the display name appended to it', () => {
    expect(normalizeProjectId(PROJECT)).toBe(PROJECT);
    // The form that actually appears in a Project chat's own path. Normalising it is the whole
    // point: the app stores what `/g/<id>/project` is addressed by, not what a rename can change.
    expect(normalizeProjectId(NAMED_SLUG)).toBeNull();
    expect(normalizeProjectId(PROJECT.toUpperCase())).toBe(PROJECT);
  });

  it.each([
    ['a custom GPT, which is served from /g/ but is not a Project', 'g-abc123def456'],
    ['a path segment escape', `${PROJECT}/../../etc`],
    ['a query smuggled into the id', `${PROJECT}?x=1`],
    ['too few hex digits', 'g-p-6a93d6fe7f008191be6262248831c7d'],
    ['too many hex digits', 'g-p-11111111222233334444555555555555a'],
    ['non-hex characters', 'g-p-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'],
    ['an empty value', ''],
    ['a non-string', 42]
  ])('refuses %s', (_why, value) => {
    expect(normalizeProjectId(value)).toBeNull();
  });
});

describe('the URL the app opens when no page places the chat', () => {
  it('starts a successor from the Project page so the new chat is created inside it', () => {
    const url = commandUrl('cmd-1', null, null, PROJECT);
    expect(url.startsWith(`https://chatgpt.com/g/${PROJECT}/project?`)).toBe(true);
    // The marker still rides in both places, for the same reason it always did: ChatGPT
    // rewrites its own query during boot and which of the two survives has changed between
    // builds. Carrying a Project must not quietly cost the fragment.
    expect(url).toContain('clf=cmd-1');
    expect(url.endsWith('#clf=cmd-1')).toBe(true);
  });

  it('keeps opening at the site root for a chat that is in no Project', () => {
    expect(commandUrl('cmd-2')).toBe('https://chatgpt.com/?clf=cmd-2#clf=cmd-2');
    expect(commandUrl('cmd-2', null, null, null)).toBe('https://chatgpt.com/?clf=cmd-2#clf=cmd-2');
  });

  it('falls back to the root rather than building an address from an unusable value', () => {
    // Degrading to exactly the old behaviour is the point. A value this app does not recognise
    // must never become a path, because a wrong Project page is worse than no Project at all.
    for (const bad of [NAMED_SLUG, 'g-abc123', '../evil', `${PROJECT}/x`, '']) {
      expect(commandUrl('cmd-3', null, null, bad)).toBe('https://chatgpt.com/?clf=cmd-3#clf=cmd-3');
    }
  });

  it('carries a Project alongside a requested model and reasoning level', () => {
    const url = commandUrl('cmd-4', 'gpt-5.6-sol', 'high', PROJECT);
    expect(url.startsWith(`https://chatgpt.com/g/${PROJECT}/project?`)).toBe(true);
    expect(url).toContain('model=gpt-5.6-sol');
    expect(url).toContain('reasoning_effort=high');
  });
});

describe('the Project surviving a restart', () => {
  it('captures Project scope at source-send admission even when an automatic ticket predates the page', async () => {
    const session = await createSession({ title: 'Restarted automatic ticket', conversationId: CHAT_A });
    const opened = await openContinuationNow(session.id, CHAT_A, true);
    expect(opened.project).toBeNull();
    expect((await beginContinuationSourceSendNow(opened.token, PROJECT))?.allowed).toBe(true);
    expect(continuationByToken(opened.token)?.project).toBe(PROJECT);
    await dispatchContinuationSourceSendNow(opened.token);
    expect((await beginContinuationSourceSendNow(opened.token, null))?.allowed).toBe(false);
    const snapshot = snapshotContinuations();
    resetContinuationsForTests();
    await restoreContinuations(snapshot);
    expect(continuationByToken(opened.token)?.project).toBe(PROJECT);
  });

  it('writes the Project onto the continuation and restores it', async () => {
    const session = await createSession({ title: 'Compacting inside a Project', conversationId: CHAT_A });
    const opened = await openContinuationNow(session.id, CHAT_A, false, PROJECT);
    expect(opened.project).toBe(PROJECT);

    // The process ends here. Nothing in the app's own session record says which Project the
    // chat is filed under, and the tab that could have said so is gone with the browser.
    const snapshot = snapshotContinuations();
    resetContinuationsForTests();
    expect(continuationByToken(opened.token)).toBeNull();

    await restoreContinuations(snapshot);
    expect(continuationByToken(opened.token)?.project).toBe(PROJECT);
    expect(commandUrl('cmd-5', null, null, continuationByToken(opened.token)?.project)).toContain(
      `/g/${PROJECT}/project?`
    );
  });

  it('opens a non-Project chat with no Project, before and after a restart', async () => {
    const session = await createSession({ title: 'Compacting at the root', conversationId: CHAT_A });
    const opened = await openContinuationNow(session.id, CHAT_A, false, null);
    expect(opened.project).toBeNull();

    const snapshot = snapshotContinuations();
    resetContinuationsForTests();
    await restoreContinuations(snapshot);
    expect(continuationByToken(opened.token)?.project).toBeNull();
  });

  it('reads a record written before Project affinity existed as no Project', async () => {
    const session = await createSession({ title: 'Older record', conversationId: CHAT_A });
    const opened = await openContinuationNow(session.id, CHAT_A, false, PROJECT);
    const snapshot = JSON.parse(JSON.stringify(snapshotContinuations()));
    // Exactly what an older build wrote: the field is simply not there.
    for (const entry of snapshot.entries) delete entry.project;

    resetContinuationsForTests();
    await restoreContinuations(snapshot);
    // Restored and usable, just without a Project — never dropped, and never a crash.
    expect(continuationByToken(opened.token)).not.toBeNull();
    expect(continuationByToken(opened.token)?.project).toBeNull();
  });

  it('refuses a Project value that a tampered or corrupt record carries', async () => {
    const session = await createSession({ title: 'Corrupt record', conversationId: CHAT_A });
    const opened = await openContinuationNow(session.id, CHAT_A, false, PROJECT);
    const snapshot = JSON.parse(JSON.stringify(snapshotContinuations()));
    for (const entry of snapshot.entries) entry.project = `${PROJECT}/../../../attacker`;

    resetContinuationsForTests();
    await restoreContinuations(snapshot);
    // The continuation is still honoured; only the unusable Project is dropped, which puts the
    // successor back at the root instead of at an address assembled from a stored string.
    expect(continuationByToken(opened.token)).not.toBeNull();
    expect(continuationByToken(opened.token)?.project).toBeNull();
  });

  it('normalizes at the boundary, so a named slug never reaches a stored record', async () => {
    const session = await createSession({ title: 'Named slug offered', conversationId: CHAT_A });
    const opened = await openContinuationNow(session.id, CHAT_A, false, NAMED_SLUG);
    expect(opened.project).toBeNull();
  });
});

/**
 * The path the reported bug actually takes.
 *
 * Compact & Resume names chat A's own conversation on its placement offer, so the successor is
 * created by the extension in chat A's window — not by the OS opener. Asserted by running the
 * real service worker and reading the tab it creates, because the whole failure was that a URL
 * built correctly everywhere else was still built at the root here.
 */
describe('the chat the extension creates beside its source', () => {
  type Created = { id: number; url?: string; pendingUrl?: string; windowId?: number; index?: number };
  interface Probe {
    placeSuccessorChat(raw: unknown, tabId: number | null): Promise<void>;
    projectFromUrl(value: unknown): string | null;
    successorChatBase(offered: unknown, observed: unknown): string;
  }

  function worker(home: Created | null) {
    const created: Created[] = [];
    const tabs: Created[] = home ? [home] : [];
    const event = { addListener: () => {} };
    const store = (saved: Record<string, unknown>) => ({
      get: async () => ({ ...saved }),
      set: async (value: object) => { Object.assign(saved, value); },
      remove: async () => {}
    });
    const makeTab = async (options: Created) => {
      const tab = { ...options, id: 100 + created.length };
      created.push(tab);
      return tab;
    };
    const context = vm.createContext({
      chrome: {
        storage: { local: store({ port: 8765, token: 'test-pairing' }), session: store({}) },
        windows: {
          get: async (id: number) => ({ id }),
          // The minimized window a background worker chat is created in, with its first tab.
          create: async ({ url }: { url: string }) => ({ id: 80, tabs: [await makeTab({ url, windowId: 80 } as Created)] }),
          update: () => {}
        },
        tabs: {
          query: async () => [...tabs],
          get: async (id: number) => {
            const tab = tabs.find(entry => entry.id === id);
            if (!tab) throw new Error('no such tab');
            return tab;
          },
          create: makeTab,
          update: async () => undefined,
          remove: async () => undefined,
          sendMessage: async () => ({ ok: true }),
          onCreated: event, onUpdated: event, onRemoved: event
        },
        runtime: { getManifest: () => ({ version: '2.0.6' }), onMessage: event, onInstalled: event, onStartup: event },
        alarms: { onAlarm: event, create: () => {}, clear: async () => true },
        scripting: { executeScript: async () => [], insertCSS: async () => {} }
      },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
      URL, URLSearchParams, AbortController, setTimeout, clearTimeout, TextEncoder, console,
      browserDriverModule: { installBrowserDriverLifecycle() {}, sweepStaleDrivenGroups: async () => {} }
    });
    vm.runInContext(`${workerSource}
globalThis.probe = { placeSuccessorChat, projectFromUrl, successorChatBase };`, context);
    return { api: (context as unknown as { probe: Probe }).probe, created };
  }

  const chatInProject = `https://chatgpt.com/g/${NAMED_SLUG}/c/${CHAT_IN_PROJECT}`;
  const offer = (extra: Record<string, unknown> = {}) => ({ id: 'cmd-9', model: null, reasoningEffort: null, ...extra });

  it('creates the successor on the Project page when the source chat is in one', async () => {
    const h = worker({ id: 7, url: chatInProject, windowId: 3, index: 1 });
    await h.api.placeSuccessorChat(offer({ project: PROJECT }), 7);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.url!.startsWith(`https://chatgpt.com/g/${PROJECT}/project?`)).toBe(true);
    expect(h.created[0]!.url).toContain('clf=cmd-9');
    // Still beside the chat it continues, and still in that chat's own window.
    expect(h.created[0]!.windowId).toBe(3);
    expect(h.created[0]!.index).toBe(2);
  });

  it('does not inherit a Project from the visible tab when the command names none', async () => {
    // An app that predates the offer field, or a path with no continuation to record it on.
    const h = worker({ id: 7, url: chatInProject, windowId: 3, index: 0 });
    await h.api.placeSuccessorChat(offer({ project: null, active: false }), 7);
    expect(h.created[0]!.url!.startsWith('https://chatgpt.com/?')).toBe(true);
  });

  it('trusts the app over the tab, because only the app remembers across a restart', async () => {
    // Chat A has already been navigated away to the root in this tab; the offer is still right.
    const h = worker({ id: 7, url: 'https://chatgpt.com/', windowId: 3, index: 0 });
    await h.api.placeSuccessorChat(offer({ project: PROJECT }), 7);
    expect(h.created[0]!.url!.startsWith(`https://chatgpt.com/g/${PROJECT}/project?`)).toBe(true);
  });

  it('creates a background worker chat in the Project the app named', async () => {
    const h = worker(null);
    await h.api.placeSuccessorChat(offer({ project: PROJECT, background: true }), null);
    expect(h.created[0]!.url!.startsWith(`https://chatgpt.com/g/${PROJECT}/project?`)).toBe(true);
  });

  it('leaves a chat outside any Project exactly where it was created before', async () => {
    const h = worker({ id: 7, url: `https://chatgpt.com/c/${CHAT_IN_PROJECT}`, windowId: 3, index: 0 });
    await h.api.placeSuccessorChat(offer(), 7);
    expect(h.created[0]!.url!.startsWith('https://chatgpt.com/?')).toBe(true);
  });

  it('refuses a named slug and an unrelated /g/ route from either source', () => {
    // A custom GPT is served from /g/ too and is not a Project.
    expect(h1(`https://chatgpt.com/g/g-abc123/c/${CHAT_IN_PROJECT}`)).toBeNull();
    expect(h1(`http://chatgpt.com/g/${NAMED_SLUG}/c/x`)).toBeNull();
    expect(h1(`https://evil.example/g/${NAMED_SLUG}/c/x`)).toBeNull();
    expect(h1(chatInProject)).toBe(PROJECT);

    const { api } = worker(null);
    // The display-name form is refused as an offered value and falls back to what was observed.
    expect(api.successorChatBase(NAMED_SLUG, chatInProject)).toBe(
      'https://chatgpt.com/'
    );
    expect(api.successorChatBase(NAMED_SLUG, null)).toBe('https://chatgpt.com/');
  });

  function h1(url: string): string | null {
    return worker(null).api.projectFromUrl(url);
  }
});
