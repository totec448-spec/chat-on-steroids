import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * The ChatGPT Project picker on its own (#1756, Haz on #1757): nothing is ever created behind the
 * person's back, and a linked project can change to another or a new one.
 */
let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event });
});
afterEach(() => dom.window.close());

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });
const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3', name: 'Local', path: '/local', createdAt: 3 };
const listed = [{ id: 'g-p-1', name: 'Existing', linkedTo: null }, { id: 'g-p-2', name: 'Current', linkedTo: { id: project.id, name: 'Local' } }];

async function picker(anchor: HTMLElement | null) {
  const api = {
    chatgptProjectChoices: vi.fn(() => ok(listed)),
    linkChatgptProject: vi.fn(() => ok(project)),
    createChatgptProject: vi.fn(() => ok(project))
  };
  const onNotice = vi.fn(), onError = vi.fn(), onUpdated = vi.fn();
  const { createChatgptProjectPicker } = await import('../src/renderer/chatgpt-project-picker.js');
  const created = createChatgptProjectPicker({ api: api as any, anchor: () => anchor, onUpdated, onError, onNotice });
  await created.hasChoices();
  return { api, created, onNotice, onError, onUpdated };
}
const button = () => { const node = document.createElement('button'); document.body.append(node); return node; };
const options = () => [...document.querySelectorAll<HTMLButtonElement>('.chatgpt-project-picker [role="option"]')];

it('creates nothing right after adding when there is no row to open the choice from, and says where to choose later', async () => {
  const { api, created, onNotice } = await picker(null);
  await created.offer(project, 'added');
  await settle();
  expect(api.createChatgptProject).not.toHaveBeenCalled();
  expect(api.linkChatgptProject).not.toHaveBeenCalled();
  expect(onNotice).toHaveBeenCalledWith('Choose its ChatGPT Project later from the project’s ⋯ menu.');
});

it('changes a linked project to a new ChatGPT Project in place of the old one', async () => {
  const { api, created } = await picker(button());
  await created.offer({ ...project, chatgpt: { state: 'linked', id: 'g-p-2', updatedAt: 1 } }, 'menu');
  expect(options().map(option => option.textContent)).toEqual(['New ChatGPT Project “Local”', 'Existing', 'Current']);
  expect(options()[2]!.getAttribute('aria-selected')).toBe('true');
  expect(document.querySelector('.chatgpt-project-picker')!.textContent).not.toContain('Or choose later');
  options()[0]!.click();
  await settle();
  expect(api.createChatgptProject).toHaveBeenCalledWith(project.id, { replace: true });
});

it('changes a linked project to another ChatGPT Project the account has', async () => {
  const { api, created } = await picker(button());
  await created.offer({ ...project, chatgpt: { state: 'linked', id: 'g-p-2', updatedAt: 1 } }, 'menu');
  options()[1]!.click();
  await settle();
  expect(api.linkChatgptProject).toHaveBeenCalledWith(project.id, 'g-p-1');
  expect(api.createChatgptProject).not.toHaveBeenCalled();
});

it('never offers a new one while one is being created', async () => {
  const { created } = await picker(button());
  await created.offer({ ...project, chatgpt: { state: 'creating', requestId: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee', updatedAt: 1 } } as any, 'menu');
  expect(options().map(option => option.textContent)).toEqual(['Existing', 'Current']);
});

it('picks the matching ChatGPT Project on Enter, and a new one only when nothing else matches', async () => {
  // The local project shares its name with a Project the account has: Enter means that one.
  const { api, created } = await picker(button());
  const local = { ...project, name: 'Existing' };
  await created.offer(local, 'menu');
  const type = (text: string) => {
    const search = document.querySelector<HTMLInputElement>('.chatgpt-project-picker input')!;
    search.value = text;
    search.dispatchEvent(new dom.window.Event('input'));
    search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };
  type('exist');
  await settle();
  expect(api.linkChatgptProject).toHaveBeenCalledWith(local.id, 'g-p-1');
  expect(api.createChatgptProject).not.toHaveBeenCalled();
  // With a query only the new one's label matches, Enter still creates it.
  await created.offer({ ...project, name: 'Fresh name' }, 'menu');
  type('fresh');
  await settle();
  expect(api.createChatgptProject).toHaveBeenCalledWith(project.id, {});
});
