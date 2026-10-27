import { expect, it, vi } from 'vitest';
import { createSendCheck, sendCheckUrl, type SendCheckDeps, type SendCheckRequest } from '../src/main/send-check.js';

/**
 * #1794 phase 1: before a message the app sends by itself, an optional local program is asked.
 * Veto-only: it can hold the send back, never change it. Off while no address is set; once set,
 * anything but a clear "allow" holds the send, so a crashed checker never quietly opens the gate.
 */
const request: SendCheckRequest = {
  kind: 'recovery', id: 'input-1', chat: { session: 'session-1', project: null, worker: null }, text: 'Continue', attempt: 1
};

function check(url: string, answer: (body: unknown) => Promise<Response> | Response, over: Partial<SendCheckDeps> = {}) {
  const log = vi.fn<SendCheckDeps['log']>();
  const bodies: unknown[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); bodies.push(body);
    return answer(body);
  });
  const run = createSendCheck({ url: () => url, fetch: fetch as unknown as SendCheckDeps['fetch'], log, timeoutMs: 50, ...over });
  return { run, fetch, log, bodies };
}
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

it('accepts only an http address on this computer with a port', () => {
  expect(sendCheckUrl('http://127.0.0.1:8123/check')).toBe('http://127.0.0.1:8123/check');
  expect(sendCheckUrl('  http://localhost:9000/  ')).toBe('http://localhost:9000/');
  expect(sendCheckUrl('http://[::1]:7000/v1/send')).toBe('http://[::1]:7000/v1/send');
  for (const bad of ['', 'https://127.0.0.1:8123/', 'http://127.0.0.1/check', 'http://example.com:80/', 'http://10.0.0.2:8000/',
    'http://127.0.0.1.example.com:80/', 'http://user:pw@127.0.0.1:8000/', 'ftp://localhost:21/', 'not a url']) {
    expect(sendCheckUrl(bad), bad).toBeNull();
  }
});

it('asks nothing and allows everything while no address is set', async () => {
  const { run, fetch, log } = check('', () => json(200, { allow: false }));
  expect(await run(request)).toEqual({ allowed: true });
  expect(fetch).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});

it('posts version 1 with the kind, id, chat, text and attempt, and lets an allowed send go', async () => {
  const { run, bodies, log } = check('http://127.0.0.1:8123/check', () => json(200, { allow: true }));
  expect(await run({ ...request, attempt: 2 })).toEqual({ allowed: true });
  expect(bodies).toEqual([{ version: 1, kind: 'recovery', id: 'input-1', chat: { session: 'session-1', project: null, worker: null }, text: 'Continue', attempt: 2 }]);
  // One line per decision, never with the message in it.
  expect(log.mock.calls.map(call => call[0])).toEqual(['send check: recovery input-1 attempt 2 allowed']);
});

it('holds a send the program refuses, with its short reason, and logs it', async () => {
  const { run, log } = check('http://localhost:8123/', () => json(200, { allow: false, reason: '  budget\nexceeded  ' }));
  expect(await run(request)).toEqual({ allowed: false, reason: 'budget exceeded', answered: true });
  expect(log.mock.calls[0]![0]).toBe('send check: recovery input-1 attempt 1 held (budget exceeded)');
  const long = check('http://localhost:8123/', () => json(200, { allow: false, reason: 'x'.repeat(500) }));
  expect(((await long.run(request)) as { reason: string }).reason).toHaveLength(200);
  const none = check('http://localhost:8123/', () => json(200, { allow: false }));
  expect(await none.run(request)).toEqual({ allowed: false, reason: '', answered: true });
});

it('holds the send when the program does not answer clearly: timeout, error, other status or body', async () => {
  const cases: Array<() => Promise<Response> | Response> = [
    () => new Promise<Response>(() => undefined),
    () => { throw new TypeError('fetch failed'); },
    () => json(500, { allow: true }),
    () => json(200, { allow: 'yes' }),
    () => json(200, ['allow']),
    () => new Response('ok', { status: 200 })
  ];
  for (const answer of cases) {
    const { run, log } = check('http://127.0.0.1:8123/', answer);
    expect(await run(request)).toEqual({ allowed: false, reason: '', answered: false });
    expect(log.mock.calls[0]![0]).toBe('send check: recovery input-1 attempt 1 held (the send check did not answer)');
  }
});

it('never contacts a saved address that is not on this computer, and holds instead', async () => {
  const { run, fetch, log } = check('http://example.com:80/', () => json(200, { allow: true }));
  expect(await run(request)).toEqual({ allowed: false, reason: '', answered: false });
  expect(fetch).not.toHaveBeenCalled();
  expect(log.mock.calls[0]![0]).toBe('send check: recovery input-1 attempt 1 held (the send check address is not on this computer)');
});

it('does not follow a redirect away from the local program', async () => {
  const { run, fetch } = check('http://127.0.0.1:8123/', () => new Response(null, { status: 302, headers: { location: 'http://example.com/' } }));
  expect(await run(request)).toEqual({ allowed: false, reason: '', answered: false });
  expect((fetch.mock.calls[0]![1] as RequestInit).redirect).toBe('manual');
});

it('keeps a damaged saved address set, so the gate holds instead of opening', async () => {
  const { promises: fs } = await import('node:fs');
  const os = await import('node:os'); const path = await import('node:path');
  const { defaultConfig, initConfigPath, loadConfig } = await import('../src/main/config.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-send-check-'));
  try {
    initConfigPath(dir);
    const saved = async (value: unknown) => {
      const base = defaultConfig();
      await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ ...base, ui: { ...base.ui, sendCheckUrl: value } }), 'utf8');
      return (await loadConfig()).ui.sendCheckUrl;
    };
    expect(await saved(undefined)).toBeUndefined();
    expect(await saved('  ')).toBeUndefined();
    expect(await saved(' http://127.0.0.1:8123/check ')).toBe('http://127.0.0.1:8123/check');
    expect(await saved(42)).toBe('damaged');
    // The app never saves null (an empty field is omitted), so a null is damage, not Off (CodeRabbit).
    expect(await saved(null)).toBe('damaged');
    expect(sendCheckUrl('damaged')).toBeNull();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
