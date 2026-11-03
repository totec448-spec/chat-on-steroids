import { afterAll, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' } }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ ui: { language: 'vi' } }) }));
vi.mock('../src/main/projects.js', () => ({
  listProjects: async () => [
    { id: 'visible-id', name: '<Local & Project>', ungrouped: false },
    { id: 'hidden-id', name: 'Hidden workspace', ungrouped: true }
  ]
}));

import { openWebLocal, shutdownWebLocal } from '../src/main/web-local/index.js';

afterAll(async () => { await shutdownWebLocal(); });

test('native-open reaches the real owner projection without exposing paths or actions', async () => {
  let activation = '';
  await expect(openWebLocal(async url => { activation = url; })).resolves.toBe(true);
  expect(activation).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/activate\//);
  const response = await fetch(activation, { redirect: 'manual' });
  expect(response.status).toBe(303);
  const scope = response.headers.get('location')!;
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const page = await fetch(new URL(scope, activation), { headers: { cookie } });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('&lt;Local &amp; Project&gt;');
  expect(html).toContain('CHỈ ĐỌC');
  expect(html).not.toContain('Hidden workspace');
  expect(html).not.toContain('visible-id');
  expect(html).not.toContain('Send prompt');
});

test('failed native handoff revokes its disclosed one-use ticket', async () => {
  const { getLog } = await import('../src/main/logger.js');
  const loggedBefore = getLog().length;
  let failedTicket = '';
  await expect(openWebLocal(async url => {
    failedTicket = url;
    throw new Error('No native browser (synthetic-private-data) ' + url);
  })).rejects.toThrow('No native browser');
  expect((await fetch(failedTicket)).status).toBe(404);
  const entries = getLog().slice(loggedBefore).map(entry => entry.message).filter(message => message.startsWith('web local:'));
  expect(entries).toContain('web local: native browser handoff failed; activation revoked');
  expect(entries.join('\n')).not.toMatch(/synthetic-private-data|127\.0\.0\.1:\d+|\/activate\/|\/web\/|cos_local_/);
});
