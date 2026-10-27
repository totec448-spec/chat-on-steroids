import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * #1469: a folder on a server is added from the sidebar's + menu. The dialog checks the address
 * and folder by connecting (the main process does), shows ssh's own explanation when that fails,
 * and hands the new project over only once it exists.
 */
let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event });
});
afterEach(() => dom.window.close());

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const project = { id: 'p1', name: 'app', path: 'me@devbox:/srv/app', remote: { host: 'me@devbox', path: '/srv/app' } };

async function submit(address: string, folder: string): Promise<void> {
  $<HTMLInputElement>('sshProjectAddress').value = address;
  $<HTMLInputElement>('sshProjectFolder').value = folder;
  $('sshProjectForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

it('adds the project once the server answers, and closes', async () => {
  const { initSshProjectDialog } = await import('../src/renderer/ssh-project-dialog.js');
  const addRemoteProject = vi.fn(async () => ({ ok: true as const, data: project }));
  const added = vi.fn();
  const dialog = initSshProjectDialog({ addRemoteProject } as any, added);
  dialog.open();
  expect($<HTMLDialogElement>('sshProjectDialog').open).toBe(true);
  await submit('  me@devbox ', ' /srv/app ');
  expect(addRemoteProject).toHaveBeenCalledWith('me@devbox', '/srv/app');
  // Without ChatGPT Projects to choose from (#1756) it is added as before.
  expect(added).toHaveBeenCalledWith(project, new Set(), false);
  expect($<HTMLDialogElement>('sshProjectDialog').open).toBe(false);
});

it("shows the main process's explanation inline and keeps what was typed", async () => {
  const { initSshProjectDialog } = await import('../src/renderer/ssh-project-dialog.js');
  const reason = 'This server is not trusted yet. Run `ssh <address>` once in a terminal and confirm its host key.';
  const addRemoteProject = vi.fn(async () => ({ ok: false as const, error: reason }));
  const added = vi.fn();
  initSshProjectDialog({ addRemoteProject } as any, added).open();
  await submit('me@new-server', '~/app');
  const error = $('sshProjectError');
  expect(error.hidden).toBe(false);
  expect(error.textContent).toBe(reason);
  expect($<HTMLInputElement>('sshProjectAddress').value).toBe('me@new-server');
  expect($<HTMLDialogElement>('sshProjectDialog').open).toBe(true);
  expect($<HTMLButtonElement>('sshProjectSubmit').disabled).toBe(false);
  expect(added).not.toHaveBeenCalled();
});

it("shows the main process's explanation in the chosen language, and ssh's own words as they are", async () => {
  const { initSshProjectDialog } = await import('../src/renderer/ssh-project-dialog.js');
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  try {
    let reason = 'Enter an SSH address such as dev, me@server or me@server:2222.';
    const addRemoteProject = vi.fn(async () => ({ ok: false as const, error: reason }));
    initSshProjectDialog({ addRemoteProject } as any, vi.fn()).open();
    await submit('not an address', '/srv/app');
    expect($('sshProjectError').textContent).toBe('Gib eine SSH-Adresse ein, etwa dev, me@server oder me@server:2222.');
    // The two sentences that name the folder keep it as it is, inside the translation.
    reason = 'Folder not found on the server: /srv/my app';
    await submit('me@devbox', '/srv/my app');
    expect($('sshProjectError').textContent).toBe('Ordner auf dem Server nicht gefunden: /srv/my app');
    reason = '~/notes.txt on the server is not a folder';
    await submit('me@devbox', '~/notes.txt');
    expect($('sshProjectError').textContent).toBe('~/notes.txt ist auf dem Server kein Ordner');
    // A line ssh printed itself has no translation and is shown unchanged.
    reason = 'kex_exchange_identification: read: Connection reset by peer';
    await submit('me@devbox', '/srv/app');
    expect($('sshProjectError').textContent).toBe(reason);
  } finally { setLanguage('en'); }
});

it('connects once per click and starts clean when opened again', async () => {
  const { initSshProjectDialog } = await import('../src/renderer/ssh-project-dialog.js');
  let finish!: (value: unknown) => void;
  const addRemoteProject = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const dialog = initSshProjectDialog({ addRemoteProject } as any, vi.fn());
  dialog.open();
  await submit('me@devbox', '/srv/app');
  expect($<HTMLButtonElement>('sshProjectSubmit').disabled).toBe(true);
  await submit('me@devbox', '/srv/app');
  expect(addRemoteProject).toHaveBeenCalledTimes(1);
  finish({ ok: false, error: 'The server did not answer in time.' });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  dialog.open();
  expect($('sshProjectError').hidden).toBe(true);
  expect($<HTMLInputElement>('sshProjectAddress').value).toBe('');
});
