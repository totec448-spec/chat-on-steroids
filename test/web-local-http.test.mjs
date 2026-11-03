import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';
import { createWebLocalServer } from '../src/main/web-local/http.mjs';

const services = [];
after(async () => { await Promise.all(services.map(service => service.stop())); });

async function start(read = async () => ({ connection: 'connected', projects: [{ name: 'Actual project' }] }), options = {}) {
  const service = createWebLocalServer({ read, ...options });
  services.push(service);
  await new Promise((resolve, reject) => {
    service.server.once('error', reject);
    service.server.listen(0, '127.0.0.1', () => {
      service.server.off('error', reject);
      resolve();
    });
  });
  const address = service.server.address();
  return { service, port: address.port, origin: 'http://127.0.0.1:' + address.port };
}

async function activate(owner, path = owner.service.issueActivation()) {
  const answer = await fetch(owner.origin + path, { redirect: 'manual' });
  return { answer, cookie: answer.headers.get('set-cookie')?.split(';')[0] ?? '', scope: answer.headers.get('location') };
}

function rawStatus(owner, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: owner.port, path, headers }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('one-time native activation protects a real owner read; dynamic names are HTML escaped', async () => {
  let reads = 0;
  const owner = await start(async () => {
    reads++;
    return { connection: 'connected', projects: [
      { name: '<script>untrusted</script>' },
      { name: '<SCRIPT>uppercase</SCRIPT>' },
      { name: 'Alpha & Beta' }
    ] };
  });
  const path = owner.service.issueActivation();
  const locked = await fetch(owner.origin + '/');
  assert.equal(locked.status, 401);
  assert.equal(reads, 0);
  const { answer, cookie, scope } = await activate(owner, path);
  assert.equal(answer.status, 303);
  assert.match(scope, /^\/web\/[A-Za-z0-9_-]{43}\/$/);
  assert.match(answer.headers.get('set-cookie'), /; HttpOnly; SameSite=Strict; Path=\/web\/[A-Za-z0-9_-]{43}\//);
  assert.equal((await fetch(owner.origin + path)).status, 404);
  assert.equal((await fetch(owner.origin + scope)).status, 401);
  const response = await fetch(owner.origin + scope, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(response.headers.get('referrer-policy'), /no-referrer/);
  const body = await response.text();
  assert.match(body, /&lt;script&gt;untrusted&lt;\/script&gt;/);
  assert.ok(body.includes('&lt;SCRIPT&gt;uppercase&lt;/SCRIPT&gt;'));
  assert.match(body, /Alpha &amp; Beta/);
  // Verify both lowercase and uppercase tags cannot become HTML elements.
  // String matching avoids a misleading case-sensitive HTML-filtering regexp.
  assert.equal(body.toLowerCase().includes('<script'), false);
  assert.equal(reads, 1);
});

test('Host, Origin, Fetch Metadata, methods and bodies fail before owner reads', async () => {
  let reads = 0;
  const owner = await start(async () => { reads++; return { connection: 'connected', projects: [] }; });
  const { scope, cookie } = await activate(owner);
  const target = owner.origin + scope;
  // fetch() rewrites Host to match its URL; raw HTTP tests the forged wire header.
  assert.equal(await rawStatus(owner, scope, { cookie, host: 'localhost:' + owner.port }), 403);
  assert.equal(await rawStatus(owner, scope, { cookie, host: '127.0.0.1:' + (owner.port + 1) }), 403);
  assert.equal((await fetch(target, { headers: { cookie, origin: 'http://evil.invalid' } })).status, 403);
  assert.equal((await fetch(target, { headers: { cookie, 'sec-fetch-site': 'same-site' } })).status, 403);
  assert.equal((await fetch(target, { method: 'POST', body: 'x', headers: { cookie } })).status, 405);
  assert.equal(await rawStatus(owner, scope, { cookie, 'content-length': '1' }), 413);
  assert.equal((await fetch(target + 'api', { headers: { cookie } })).status, 401);
  assert.equal((await fetch(owner.origin + '/activate/not-a-ticket')).status, 401);
  assert.equal(reads, 0);
});

test('tickets are independent, bounded and expire; newest browser activation rotates session', async () => {
  let time = 100_000;
  const owner = await start(undefined, { now: () => time });
  const tickets = Array.from({ length: 4 }, () => owner.service.issueActivation());
  assert.equal(new Set(tickets).size, 4);
  assert.throws(() => owner.service.issueActivation(), /busy/);
  const first = await activate(owner, tickets[0]);
  const second = await activate(owner, tickets[1]);
  assert.equal(first.answer.status, 303);
  assert.equal(second.answer.status, 303);
  assert.equal((await fetch(owner.origin + second.scope, { headers: { cookie: first.cookie } })).status, 401);
  assert.equal((await fetch(owner.origin + second.scope, { headers: { cookie: second.cookie } })).status, 200);
  time += 91_000;
  assert.equal((await fetch(owner.origin + tickets[2])).status, 404);
  const revoked = owner.service.issueActivation();
  owner.service.revokeActivation(revoked);
  assert.equal((await fetch(owner.origin + revoked)).status, 404);
  time += 30 * 60_000;
  assert.equal((await fetch(owner.origin + second.scope, { headers: { cookie: second.cookie } })).status, 401);
});

test('distinct loopback listeners reject each other\'s cookie, but Path is not a port security boundary', async () => {
  let bReads = 0;
  const a = await start();
  const b = await start(async () => { bReads++; return { connection: 'connected', projects: [] }; });
  const aSession = await activate(a);
  const bSession = await activate(b);
  assert.notEqual(a.port, b.port);
  assert.notEqual(aSession.scope, bSession.scope);
  assert.notEqual(aSession.cookie.split('=')[0], bSession.cookie.split('=')[0]);
  assert.equal((await fetch(b.origin + bSession.scope, { headers: { cookie: aSession.cookie } })).status, 401);
  assert.equal((await fetch(b.origin + aSession.scope, { headers: { cookie: aSession.cookie } })).status, 401);
  assert.equal(bReads, 0);
  // This checks authorization only. A hostile listener at the known A path
  // could receive A's cookie because the browser does not partition by port.
  // A future sensitive browser surface needs listener-bound proof or fails closed.
});

test('unfinished owner reads retain their slots after HTTP timeout, and shutdown is bounded', async () => {
  let release;
  const stuck = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const owner = await start(async () => {
    calls++;
    await stuck;
    return { connection: 'connected', projects: [] };
  }, { readDeadlineMs: 30, drainMs: 30 });
  const { scope, cookie } = await activate(owner);
  const requests = [1, 2].map(() => fetch(owner.origin + scope, { headers: { cookie } }));
  assert.deepEqual((await Promise.all(requests)).map(x => x.status), [503, 503]);
  assert.equal(calls, 2);
  assert.equal((await fetch(owner.origin + scope, { headers: { cookie } })).status, 503);
  assert.equal(calls, 2);
  await owner.service.stop(); // no owner await, bounded sockets
  release();
});

test('an in-flight page read cannot publish after another activation rotates the session', async () => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const owner = await start(async () => {
    entered();
    await held;
    return { projects: [{ name: 'Private project' }] };
  });
  const first = await activate(owner);
  const request = fetch(owner.origin + first.scope, { headers: { cookie: first.cookie } });
  await started;
  const next = await activate(owner);
  assert.equal(next.answer.status, 303);
  release();
  const old = await request;
  assert.equal(old.status, 503);
  assert.doesNotMatch(await old.text(), /Private project/);
});

test('missing owner coverage is a 503, not an invented empty project catalog', async () => {
  const owner = await start(async () => ({ projects: null }));
  const { cookie, scope } = await activate(owner);
  const result = await fetch(owner.origin + scope, { headers: { cookie } });
  assert.equal(result.status, 503);
  assert.equal((await result.json()).error, 'read_unavailable');
});

test('large valid catalogs stay bounded and explicitly disclose pagination', async () => {
  const owner = await start(async () => ({ projects: Array.from({ length: 200 },
    (_, index) => ({ name: String(index).padStart(3, '0') + '<&>"'.repeat(40) })) }));
  const { cookie, scope } = await activate(owner);
  const response = await fetch(owner.origin + scope, { headers: { cookie } });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Showing the first 50 projects only/);
  assert.match(html, /000/);
  assert.doesNotMatch(html, /199/);
});

test('only actual browser activation emits a credential-free decision, not probing or refreshing', async () => {
  const decisions = [];
  const owner = await start(async () => ({ projects: [{ name: 'Synthetic private project' }] }), {
    onDecision: decision => decisions.push(decision)
  });
  const ticket = owner.service.issueActivation();
  assert.equal((await fetch(owner.origin + '/')).status, 401);
  assert.equal(await rawStatus(owner, '/', { host: 'localhost:' + owner.port }), 403);
  assert.deepEqual(decisions, []);

  const { answer, cookie, scope } = await activate(owner, ticket);
  assert.equal(answer.status, 303);
  assert.equal((await fetch(owner.origin + ticket)).status, 404);
  assert.equal((await fetch(owner.origin + scope)).status, 401);
  for (let i = 0; i < 3; i++) {
    assert.equal((await fetch(owner.origin + scope, { headers: { cookie } })).status, 200);
  }
  assert.deepEqual(decisions, ['activation_accepted', 'projects_view_served']);
  assert.equal(JSON.stringify(decisions).includes(ticket), false);
  assert.equal(JSON.stringify(decisions).includes(scope), false);
  assert.equal(JSON.stringify(decisions).includes(cookie), false);
  assert.equal(JSON.stringify(decisions).includes('Synthetic private project'), false);
});

test('repeated owner-read failures report one fixed reason without logging sensitive errors', async () => {
  const decisions = [];
  const owner = await start(async () => { throw new Error('synthetic-private-owner-error'); }, {
    onDecision: decision => decisions.push(decision)
  });
  const { cookie, scope } = await activate(owner);
  for (let i = 0; i < 3; i++) {
    const response = await fetch(owner.origin + scope, { headers: { cookie } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'read_unavailable');
  }
  assert.deepEqual(decisions, ['activation_accepted', 'owner_read_unavailable']);
  assert.equal(JSON.stringify(decisions).includes('synthetic-private-owner-error'), false);
});
