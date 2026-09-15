import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import { setImmediate as nextLoopTurn } from 'node:timers/promises';

// Unchanged projectHomeId / enterProject excerpt from the pinned published source.
// Synthetic DOM dependencies and deterministic timers isolate the readiness budget.
const implementation = await readFile(new URL('./project-entry-published.js', import.meta.url), 'utf8');
const projectId = 'g-p-' + 'a'.repeat(32);
function harness({ readyAt = Infinity, cancelledAt = Infinity, interruptedAt = Infinity, attachments = false, duplicateLinks = false, navigate = true } = {}) {
  let now = 0, next = 1, clicks = 0, observer;
  let connected = false, alive = true, currentEditor = null;
  const source = { isConnected: true }, destination = { isConnected: true };
  const sourceId = 'source-conversation';
  const timers = new Map(), events = new Map();
  const location = { pathname: `/c/${sourceId}`, href: `https://chatgpt.com/c/${sourceId}`, origin: 'https://chatgpt.com' };
  function timeout(callback, delay) { const id = next++; timers.set(id, { at: now + delay, callback }); return id; }
  const link = {
    href: `https://chatgpt.com/g/${projectId}/project`,
    querySelector: () => ({}), closest: () => null,
    click() {
      clicks++;
      if (navigate) {
        location.pathname = `/g/${projectId}/project`;
        location.href = `https://chatgpt.com${location.pathname}`;
        currentEditor = destination;
      }
    }
  };
  const context = vm.createContext({
    location, URL, OWN_SURFACES: '.cos',
    conversationId: () => location.pathname === `/c/${sourceId}` ? sourceId : null,
    composer: () => currentEditor,
    composerSubmitReady: () => currentEditor !== null,
    hasComposerAttachments: () => attachments,
    turns: () => currentEditor === destination ? [] : [{}],
    setTimeout: timeout, clearTimeout: id => timers.delete(id),
    document: {
      documentElement: {},
      querySelectorAll: () => duplicateLinks ? [link, link] : [link],
      addEventListener: (name, callback) => events.set(name, callback),
      removeEventListener: name => events.delete(name)
    },
    MutationObserver: class {
      constructor(callback) { observer = callback; }
      observe() { connected = true; }
      disconnect() { connected = false; }
    }
  });
  vm.runInContext(implementation, context);
  if (Number.isFinite(readyAt)) timeout(() => { currentEditor = source; if (connected) observer(); }, readyAt);
  if (Number.isFinite(cancelledAt)) timeout(() => { alive = false; if (connected) observer(); }, cancelledAt);
  if (Number.isFinite(interruptedAt)) timeout(() => events.get('pointerdown')?.({ isTrusted: true }), interruptedAt);
  return {
    start: () => context.enterProject({ id: projectId, sourceConversationId: sourceId }, () => alive),
    async advance(end) {
      while (true) {
        const event = [...timers.entries()].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!event) break;
        now = event[1].at; timers.delete(event[0]); event[1].callback();
        await nextLoopTurn();
      }
      now = end;
      await nextLoopTurn();
    },
    get clicks() { return clicks; },
    get now() { return now; },
    get listeners() { return events.size; },
    get observing() { return connected; }
  };
}
const checks = [];
for (const [name, options, expected, expectedClicks, settledAt] of [
  ['Source hydrates at 11 seconds', { readyAt: 11000 }, true, 1, 11000],
  ['Source hydrates at 13 seconds; enclosing operation still has budget', { readyAt: 13000 }, false, 0, 12000],
  ['Source never hydrates', {}, false, 0, 12000],
  ['User interrupts before readiness', { readyAt: 11000, interruptedAt: 5000 }, false, 0, 5000],
  ['Operation cancelled before readiness', { readyAt: 11000, cancelledAt: 5000 }, false, 0, 5000],
  ['Source contains attachment', { readyAt: 1000, attachments: true }, false, 0, 12000],
  ['Native project links ambiguous', { readyAt: 1000, duplicateLinks: true }, false, 0, 12000],
  ['One click swallowed; no second click', { readyAt: 1000, navigate: false }, false, 1, 13000]
]) {
  const fixture = harness(options);
  let result, finishedAt;
  fixture.start().then(value => { result = value; finishedAt = fixture.now; });
  await fixture.advance(50000);
  assert.equal(result, expected, name);
  assert.equal(fixture.clicks, expectedClicks, name);
  assert.equal(finishedAt, settledAt, name);
  assert.equal(fixture.listeners, 0, 'Listeners must be removed');
  assert.equal(fixture.observing, false, 'Observer must be disconnected');
  checks.push({ name, result, clicks: fixture.clicks, finishedAtMs: finishedAt });
}
const report = {
  issue: 212,
  sourceCommit: '2f9be7eb9d6d1f13ccac9019e20965af15d4e4be',
  sourceFileBlob: 'c7effab569d84ccd227d735c6e766efe4debda3b',
  scope: 'Unchanged published function excerpt with synthetic dependencies and virtual timers. No signed-in browser or current dirty-worktree verification.',
  summary: { checks: checks.length, originalPrematureTimeoutReproduced: true, fixVerified: false },
  checks
};
await writeFile(new URL('./reproduction-212.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.summary, null, 2));
