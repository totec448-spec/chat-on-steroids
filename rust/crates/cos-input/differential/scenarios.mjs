#!/usr/bin/env node
// Writes scenarios/*.json, the scripted outbox and command runs that run.mjs sends to both
// sides. Edit the scenarios here and rerun: node rust/crates/cos-input/differential/scenarios.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const C1 = 'c1c1c1c1-0000-4000-8000-000000000001';
const C2 = 'c2c2c2c2-0000-4000-8000-000000000002';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const U4 = '44444444-4444-4444-8444-444444444444';
const U5 = '55555555-5555-4555-8555-555555555555';

/** A chat whose first turn finished, on a model that is not Pro. */
const idle = (conversation, tag) => ({ route: '/events', request: { conversationId: conversation, events: [
  { kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: 1767225601000 },
  { kind: 'user_message', messageId: `m-u0-${tag}`, text: 'Hello', time: 1767225601100, authoredNow: true },
  { kind: 'turn_start', turnId: 't0', time: 1767225601200 },
  { kind: 'assistant_message', messageId: `m-a0-${tag}`, turnId: 't0', text: 'Hi', state: 'final', final: true, time: 1767225601300 },
  { kind: 'turn_end', turnId: 't0', outcome: 'completed', time: 1767225601400 }
] } });
const enqueue = (id, conversation, text, mode = 'auto') =>
  ({ enqueue: { id, sessionId: `<SESSION:${conversation}>`, text, mode, dueAt: 0, model: null, reasoningEffort: null } });
/** A message with no session: it opens a new chat, as the composer's New chat and the control API do. */
const open = (id, text) => ({ enqueue: { id, sessionId: null, text, mode: 'auto', dueAt: 0, model: null, reasoningEffort: null } });
const claim = (id, owner, conversation) =>
  ({ route: '/input/claim', request: { id, owner, conversationId: conversation, requiresAuthorization: true } });
const authorize = (id, owner, conversation) =>
  ({ route: '/input/claim', request: { id, owner, conversationId: conversation, authorize: true } });
const ack = (id, owner, conversation, messageId) =>
  ({ route: '/input/ack', request: { id, owner, conversationId: conversation, ...(messageId ? { messageId } : {}) } });
const fail = (id, owner, error, detail) =>
  ({ route: '/input/fail', request: { id, owner, error, ...(detail ? { detail } : {}) } });
const stop = (id, turnId, createdAt, leased) => ({ id, spec: { type: 'stop', sessionId: `<SESSION:${C1}>`, conversationId: C1, turnId },
  createdAt, phase: leased ? 'leased' : 'queued', claimedAt: leased ? createdAt : null, owner: leased ? 'doc-9' : null, lastError: null });
const receipt = (id, completedAt) =>
  ({ id, client: 'doc', conversationId: C1, outcome: 'committed', committed: true, error: null, completedAt });

const scenarios = {
  lifecycle: [
    idle(C1, 'a'),
    enqueue(U1, C1, '  Read one file  '),
    enqueue(U1, C1, '  Read one file  '),
    enqueue(U2, C1, 'A second message'),
    { pending: true },
    claim(U1, 'page-1', C1),
    authorize(U1, 'page-1', C1),
    authorize(U1, 'page-1', C1),
    ack(U1, 'page-1', C1, 'native-1'),
    { pending: true },
    ack(U1, 'page-1', C1, 'native-1')
  ],
  restart: [
    idle(C1, 'a'),
    enqueue(U2, C1, 'Survive a restart'),
    claim(U2, 'lost-page', C1),
    { restart: true },
    { pending: true },
    claim(U2, 'replacement-page', C1),
    authorize(U2, 'lost-page', C1),
    authorize(U2, 'replacement-page', C1),
    { restart: true },
    { pending: true },
    claim(U2, 'late-page', C1),
    ack(U2, 'replacement-page', C1, 'native-2')
  ],
  failures: [
    idle(C1, 'a'),
    idle(C2, 'b'),
    enqueue(U3, C1, 'Take it'),
    claim(U3, 'page', C1),
    authorize(U3, 'page', C1),
    fail(U3, 'page', 'Native Send did not take the message.'),
    { pending: true },
    claim(U3, 'page', C1),
    authorize(U3, 'page', C1),
    fail(U3, 'page', 'Native Send did not take the message.'),
    enqueue(U4, C1, 'Next try'),
    claim(U4, 'page', C1),
    fail(U4, 'page', 'Model picker failed', 'model-picker'),
    enqueue(U5, C2, 'For a chat about to be deleted'),
    { route: '/conversation-deleted', request: { conversationId: C2 } },
    fail(U5, 'stranger', 'x'),
    ack(U4, 'page', C2),
    { route: '/input/claim', request: { id: 'not-an-id', owner: 'page' } },
    { pending: true }
  ],
  'after-turn': [
    idle(C1, 'a'),
    { route: '/events', request: { conversationId: C1, events: [
      { kind: 'user_message', messageId: 'm-u1', text: 'Go', time: 1767225602000, authoredNow: true },
      { kind: 'turn_start', turnId: 't1', time: 1767225602100 }
    ] } },
    enqueue(U1, C1, 'Then do this', 'after-turn'),
    { pending: true },
    claim(U1, 'page', C1),
    { route: '/events', request: { conversationId: C1, events: [
      { kind: 'assistant_message', messageId: 'm-a1', turnId: 't1', text: 'Done', state: 'final', final: true, time: 1767225603000 },
      { kind: 'turn_end', turnId: 't1', outcome: 'completed', time: 1767225603100 }
    ] } },
    { pending: true },
    claim(U1, 'page', C1),
    authorize(U1, 'page', C1),
    ack(U1, 'page', C1, 'native-after')
  ],
  'new-chat': [
    open(U1, 'Start something new'),
    open(U1, 'Start something new'),
    { pending: true },
    claim(U1, 'page', null),
    authorize(U1, 'page', null),
    ack(U1, 'page', null, 'native-open'),
    { route: '/input/bind', request: { id: U1, owner: 'page', conversationId: C1 } },
    ack(U1, 'page', C1, 'native-open'),
    { route: '/events', request: { conversationId: C1, events: [
      { kind: 'user_message', messageId: 'native-open', text: 'Start something new', time: 1767225602000 },
      { kind: 'turn_start', turnId: 't1', time: 1767225602100 }
    ] } },
    { restart: true },
    { pending: true },
    open(U1, 'Start something new'),
    ack(U1, 'page', C2, 'native-other')
  ],
  commands: [
    idle(C1, 'a'),
    { route: '/events', request: { conversationId: C1, events: [
      { kind: 'user_message', messageId: 'm-u1', text: 'Long job', time: 1767225602000, authoredNow: true },
      { kind: 'turn_start', turnId: 't1', time: 1767225602100 }
    ] } },
    { seed: 'bridge-commands', value: { version: 4, commands: [
      stop('fresh-stop', 't1', '<NOW-1000>', true),
      stop('old-stop', 't0', '<NOW-3600000>', false),
      { id: 'worker', spec: { type: 'worker', agent: 'w1', task: 'Do it', model: null, reasoningEffort: null, runId: 'run-1' },
        createdAt: '<NOW-1000>', phase: 'queued', claimedAt: null, owner: null, lastError: null }
    ], receipts: [receipt('kept', '<NOW-60000>'), receipt('expired', '<NOW-3600000>')] } },
    { restart: true },
    { route: '/commands/redeem', request: { id: 'fresh-stop', client: 'doc-2', conversationId: C1 } },
    { route: '/commands/redeem', request: { id: 'fresh-stop', client: 'doc-9', conversationId: C1 } },
    { route: '/commands/step', request: { id: 'fresh-stop', client: 'doc-9', step: 'sending' } },
    { route: '/commands/ack', request: { id: 'fresh-stop', client: 'doc-9', conversationId: C1, turnId: 't1', status: 'sent' } },
    { route: '/commands/ack', request: { id: 'fresh-stop', client: 'doc-9', conversationId: C1, turnId: 't1', status: 'sent' } },
    { route: '/commands/ack', request: { id: 'fresh-stop', client: 'doc-2', conversationId: C1, turnId: 't1' } },
    { route: '/commands/ack', request: { id: 'kept', client: 'doc', conversationId: C1 } },
    { route: '/commands/revivals/pending', request: { entries: [{ id: 'worker', conversationId: C1 }] } },
    { route: '/commands/redeem', request: { id: 'worker', client: 'doc' } }
  ]
};

mkdirSync(path.join(here, 'scenarios'), { recursive: true });
for (const [name, ops] of Object.entries(scenarios)) {
  writeFileSync(path.join(here, 'scenarios', `${name}.json`), `${JSON.stringify(ops, null, 2)}\n`);
}
console.log(`wrote ${Object.keys(scenarios).length} scenarios`);
