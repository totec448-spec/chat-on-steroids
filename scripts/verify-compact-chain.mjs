/**
 * Proves every Compact & Resume checkpoint survives the whole page → worker → app chain.
 *
 * Why this exists as its own check. The chain has three links written in three files, and each
 * one has a passing test of its own: content.js sends the message, background.js forwards the
 * fields it names, bridge.ts acts on them. Twice a field was added correctly to the first and
 * third and never to the second, and both times every test stayed green while the feature was
 * dead in production — `sourceLost` on the day it was written, and `destinationLost` from
 * 2026-09-02 until 2026-09-04. A unit test cannot see that, because the bug is not in any of the
 * three files; it is in the joins between them.
 *
 * The trick that makes it checkable is the isolated world. `chrome.runtime.sendMessage` exists
 * only inside the content script's own execution context, which the DevTools protocol can
 * address by `contextId` — so the message under test is sent from exactly where the real page
 * sends it, through the real service worker, to the real app.
 *
 * The assertion is the error code. Every checkpoint branch in `/compact` looks its token up and
 * refuses an unknown one with a message only that branch produces, so a distinct 409 proves the
 * request reached that exact branch. A checkpoint the worker dropped would arrive with neither
 * its flag nor its token and fall through to "start a compaction", which answers 200 with a job —
 * unmistakably different. No continuation is created and nothing is mutated: the tokens are
 * syntactically valid and deliberately name nothing.
 *
 * Usage: start the app (`npm run dev` or an installed build), then
 *     node scripts/verify-compact-chain.mjs
 * It launches its own Chrome over the CDP pipe, loads `extension/` unpacked, and cleans up.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const PORT = 9334;
const EXTENSION = path.resolve('extension');
const PAGE = 'https://chatgpt.com/';

/** Every checkpoint the worker claims to forward, with the refusal only its own branch emits. */
const CHECKPOINTS = [
  ['sourceAttempt', { sourceAttempt: true }, 'no_such_continuation'],
  ['sourceDispatch', { sourceDispatch: true }, 'no_such_continuation'],
  ['sourceLost', { sourceLost: true }, 'no_such_continuation'],
  ['sourceMessageId', { sourceMessageId: 'm-probe' }, 'no_such_continuation'],
  ['destinationAttempt', { destinationAttempt: true }, 'destination_send_not_available'],
  ['destinationDispatch', { destinationDispatch: true }, 'destination_send_reclaimed'],
  ['destinationLost', { destinationLost: true }, 'destination_send_not_releasable']
];

function chromePath() {
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  return 'google-chrome';
}

function pipeClient(child) {
  const out = child.stdio[3];
  const inn = child.stdio[4];
  let buffer = Buffer.alloc(0);
  let id = 1;
  const pending = new Map();
  inn.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let at;
    while ((at = buffer.indexOf(0)) !== -1) {
      const text = buffer.subarray(0, at).toString('utf8');
      buffer = buffer.subarray(at + 1);
      try {
        const message = JSON.parse(text);
        if (message.id && pending.has(message.id)) {
          pending.get(message.id)(message.result ?? message.error);
          pending.delete(message.id);
        }
      } catch {
        // Partial or non-JSON frames are not this client's business.
      }
    }
  });
  return (method, params = {}) =>
    new Promise((resolve) => {
      const mine = id++;
      pending.set(mine, resolve);
      out.write(`${JSON.stringify({ id: mine, method, params })}\0`);
    });
}

function socket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', reject);
  });
}

function talk(ws) {
  let id = 1;
  return (method, params = {}) =>
    new Promise((resolve) => {
      const mine = id++;
      const handler = (event) => {
        const data = JSON.parse(event.data);
        if (data.id === mine) {
          ws.removeEventListener('message', handler);
          resolve(data.result ?? data.error);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: mine, method, params }));
    });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * A profile of its own, per run, deleted afterwards.
 *
 * Reusing one directory made this script certify a build it should have failed: with
 * `destinationLost` deliberately deleted from the worker's forwarding list, every check still
 * passed, because Chrome kept serving the extension it had already registered in that profile
 * rather than re-reading the folder. A verifier that answers from a cache is worse than no
 * verifier — it is the same stale-code trap this whole chain of bugs has been hiding behind,
 * reproduced inside the tool built to expose it.
 */
const profile = path.join(
  process.env.TEMP || process.env.TMPDIR || '/tmp',
  `clf-compact-chain-${randomBytes(6).toString('hex')}`
);

const child = spawn(
  chromePath(),
  [
    '--remote-debugging-pipe',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
);
child.on('error', (err) => {
  console.error(`FAIL  could not start Chrome: ${err.message}`);
  process.exit(1);
});

let failures = 0;
const report = (ok, name, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

try {
  const browser = pipeClient(child);
  await wait(2500);
  // --load-extension is gone from branded Chrome since 137; loadUnpacked over the pipe replaces it.
  const loaded = await browser('Extensions.loadUnpacked', { path: EXTENSION });
  report(Boolean(loaded && loaded.id), 'extension loads unpacked', loaded && loaded.id);
  if (!loaded || !loaded.id) throw new Error('extension did not load');

  const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
  const target = list.find((entry) => entry.type === 'page');
  const ws = await socket(target.webSocketDebuggerUrl);
  const page = talk(ws);

  const contexts = [];
  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.method === 'Runtime.executionContextCreated') contexts.push(data.params.context);
  });
  await page('Page.enable');
  await page('Runtime.enable');
  await page('Page.navigate', { url: PAGE });
  await wait(9000);

  const world = contexts.find((context) => context.origin.startsWith('chrome-extension://'));
  report(Boolean(world), 'content script has its own isolated world', world && world.name);
  if (!world) throw new Error('no isolated world; the content script did not inject');

  const ask = async (fields) => {
    const message = {
      type: 'compact',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      token: '0123456789abcdef0123456789abcdef',
      navigationEpoch: 0,
      ...fields
    };
    const expression = `(async () => { try { return JSON.stringify(await chrome.runtime.sendMessage(${JSON.stringify(
      message
    )})); } catch (err) { return 'THREW ' + (err && err.message); } })()`;
    const result = await page('Runtime.evaluate', {
      expression,
      contextId: world.id,
      returnByValue: true,
      awaitPromise: true
    });
    try {
      return JSON.parse(result.result.value);
    } catch {
      return { ok: false, data: { error: String(result.result?.value) } };
    }
  };

  // The precondition, checked once and named.
  //
  // Every assertion below reads an error code out of the app's reply, so with no app running they
  // all failed identically with "got undefined" — seven failures that read as seven broken
  // checkpoints and said nothing about the one thing actually wrong. The worker reports a failed
  // discovery as `app_not_found` at the top level rather than inside `data`, which is precisely
  // the shape that produced that `undefined`.
  const reachable = await ask({ sourceAttempt: true });
  const appMissing = reachable?.error === 'app_not_found';
  report(
    !appMissing,
    'the app is running, so the chain can be checked at all',
    appMissing ? 'not reachable — start it (npm run dev, or an installed build) and run this again' : ''
  );

  if (!appMissing) {
    for (const [name, fields, expected] of CHECKPOINTS) {
      const reply = await ask(fields);
      const error = reply && reply.data ? reply.data.error : undefined;
      report(error === expected, `${name} reaches its own branch`, `got ${JSON.stringify(error)}`);
    }

    // A shape with no checkpoint at all must still be routed as an ordinary start request, or the
    // check above would pass for the wrong reason — every reply being a refusal proves nothing.
    const plain = await ask({ ticket: false });
    report(
      !plain?.data?.error || !String(plain.data.error).includes('no_such_continuation'),
      'a request with no checkpoint is not mistaken for one',
      JSON.stringify(plain?.data?.error ?? plain?.status ?? plain)
    );
  }

  const digest = createHash('sha256').update(await readFile(path.join(EXTENSION, 'background.js'))).digest('hex').slice(0, 12);
  console.log(`\nextension/background.js digest: ${digest}`);
  console.log("compare with the app's log line: bridge: browser extension <version> connected (build <digest>)");

  ws.close();
} catch (err) {
  report(false, 'chain verification ran to completion', err.message);
} finally {
  child.kill('SIGKILL');
  // Chrome needs a moment to release the profile's file locks before it can be removed.
  await wait(1500);
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}

console.log(`\n${failures === 0 ? 'compact chain verified' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
