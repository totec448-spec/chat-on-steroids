// Executed only by the isolated Chromium verifier with an explicitly supplied
// React installation. These are synthetic public shapes, not exported page code.
import React, { memo, useMemo, Suspense, startTransition } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

window.verifyCommittedShellReact = async (fiberSource, domSource) => {
  const h = React.createElement;
  const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const user = '11111111-1111-4111-8111-111111111111';
  const turnId = '22222222-2222-4222-8222-222222222222';
  const call = '33333333-3333-4333-8333-333333333333';
  document.body.innerHTML = '<div id="react-verification-root"></div>';
  window.eval(fiberSource); window.eval(domSource);
  let serial = 0, suspended = false, entered, release;
  const pending = new Promise(resolve => { release = () => { suspended = false; resolve(); }; });
  const reached = new Promise(resolve => { entered = resolve; });
  function Exchange({ entry }) {
    return h('div', { 'data-turn-key': user },
      h('div', { 'data-content-search-turn-key': turnId },
        h('div', { 'data-content-search-unit-key': `${turnId}:0:user` },
          h('div', { 'data-user-message-bubble': '' }, 'Diagnostic task')),
        h('span', { 'data-chatgpt-agent-turn-start': '' }),
        h('div', { 'data-native-revision': entry.revision }, `Revision ${entry.revision}`)));
  }
  const MemoExchange = memo(Exchange);
  function Owner({ conversationId, entry, mapping, noise }) {
    useMemo(() => ({ renderedConversation: { mapping, current_node: call },
      renderedTurns: [{ id: turnId, turn: entry.turn }] }), [entry, mapping]);
    if (suspended) { entered(); throw pending; }
    return h('main', { 'data-app-shell-main-surface': '', 'data-noise': noise },
      h('div', { 'data-thread-find-target': 'conversation' }, h(MemoExchange, { entry })));
  }
  const root = createRoot(document.getElementById('react-verification-root'));
  const state = (revision, entry = null) => ({ conversationId, noise: revision,
    entry: entry || { id: turnId, conversationId, revision, turn: { status: 'in_progress',
      messageIds: [user, call], items: [
        { type: 'user-message', messageId: user, serverMessageId: user, message: 'Diagnostic task' },
        { type: 'chatgpt-reasoning-group', items: [{ type: 'mcp-tool-call', callId: call,
          completed: false, invocation: { server: 'Chat On Steroids Core', tool: 'read' } }] }
      ] } },
    mapping: {
      [user]: { id: user, parent: null, message: { id: user, author: { role: 'user' } } },
      [call]: { id: call, parent: user, message: { id: call, author: { role: 'assistant' },
        metadata: { request_id: `wfr_committed_${revision}` } } }
    }
  });
  const tree = props => h(Suspense, { fallback: h('div', null, 'Loading') }, h(Owner, props));
  const render = props => flushSync(() => root.render(tree(props)));
  const sample = () => new Promise((resolve, reject) => {
    const nonce = `committed-react-${++serial}`;
    const timeout = setTimeout(() => { window.removeEventListener('message', receive); reject(Error('React scan reply absent')); }, 2000);
    const receive = event => {
      if (event.source !== window || event.data?.source !== 'clf-fiber-reply' || event.data.nonce !== nonce) return;
      clearTimeout(timeout); window.removeEventListener('message', receive); resolve(event.data);
    };
    window.addEventListener('message', receive); window.postMessage({ source: 'clf-fiber-ask', nonce }, location.origin);
  });
  const observations = [];
  const expectRequest = async (expected, stage) => {
    const start = performance.now(), result = await sample();
    const requests = result.turns.flatMap(turn => turn.requests.map(request => request.requestId));
    if (requests.length !== 1 || requests[0] !== expected) throw Error(`${stage}: expected ${expected}, got ${JSON.stringify(requests)}`);
    observations.push({ stage, request: requests[0], durationMs: Math.round((performance.now() - start) * 100) / 100 });
  };
  try {
    render(state(0));
    const host = document.querySelector('[data-turn-key]');
    const retainedMain = document.querySelector('[data-app-shell-main-surface]');
    const hostKey = Object.keys(host).find(key => key.startsWith('__reactFiber$'));
    const originalPointer = host[hostKey];
    await expectRequest('wfr_committed_0', 'initial render');
    for (const revision of [1, 2]) {
      render(state(revision));
      if (host !== document.querySelector('[data-turn-key]') || host[hostKey] !== originalPointer)
        throw Error('React fixture did not reuse the original host pointer');
      await expectRequest(`wfr_committed_${revision}`, `committed update ${revision}`);
    }
    const held = state(3); render(held);
    render(state(4, held.entry));
    await expectRequest('wfr_committed_4', 'new ancestor metadata through memoized child');
    suspended = true;
    startTransition(() => root.render(tree(state(5))));
    await reached;
    await expectRequest('wfr_committed_4', 'uncommitted suspended render stays excluded');
    release(); render(state(5));
    await expectRequest('wfr_committed_5', 'resolved render becomes current');
    for (const revision of [6, 7, 8]) {
      render(state(revision));
      await expectRequest(`wfr_committed_${revision}`, `later request ${revision}`);
    }
    flushSync(() => root.unmount());
    // Serialized/stale DOM and its old pointer cannot restore an unmounted owner.
    host[hostKey] = originalPointer; document.body.append(retainedMain);
    if (!document.querySelector('[data-thread-find-target] [data-turn-key]')) throw Error('Unmount fixture lost its native anchors');
    if ((await sample()).turns.length) throw Error('Unmounted React owner was read');
    return { reactVersion: React.version, observations,
      checks: ['real React commits update request identity across retained DOM pointers',
        'memoized children use their committed ancestor metadata',
        'suspended uncommitted requests stay excluded',
        'unmounted host pointers cannot restore stale evidence'] };
  } finally { release(); try { flushSync(() => root.unmount()); } catch {} }
};
