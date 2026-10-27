import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it } from 'vitest';

// #1756: the Projects ChatGPT's sidebar lists, read from its links to each Project's home. Shape
// measured on chatgpt.com 2026-10-21 (German page): `nav` links `/g/g-p-<32 hex>-<slug>/project`
// with the Project's name as their text, a folder icon before it, and chats nested below.
const domSource = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const fiberSource = readFileSync(new URL('../extension/fiber.js', import.meta.url), 'utf8');
let page: JSDOM;
afterEach(() => { page?.window.close(); });

const id = (digit: string) => `g-p-${digit.repeat(32)}`;

function sidebar(html: string) {
  page = new JSDOM(`<nav>${html}</nav><main><a href="/g/${id('9')}/project">Mentioned in a reply</a></main>`,
    { url: 'https://chatgpt.com/', runScripts: 'outside-only' });
  page.window.eval(fiberSource);
  page.window.eval(domSource);
  return (page.window as any).CLF_DOM;
}

it('lists each sidebar Project once, in order, by id and visible name', () => {
  const api = sidebar(`
    <a href="/g/${id('a')}-kunden/project"><svg></svg><span>Kunden 🚀</span></a>
    <a href="/g/${id('a')}-kunden/c/6ad337fe-47a4-83ed-a21f-c2e24d5829a4">A chat inside it</a>
    <a href="https://chatgpt.com/g/${id('b')}/project">Größe &amp; Ä
      <span>3 chats</span></a>
    <a href="/g/${id('c')}/project"></a>
    <a href="/g/g-p-not-hex/project">Bad id</a>
    <a href="/g/${id('a')}/project">Kunden again</a>`);
  expect(api.projectsShown()).toEqual([{ id: id('a'), name: 'Kunden 🚀' }, { id: id('b'), name: 'Größe & Ä' }]);
});

it('reads collapsed Project rows by their id and label attributes, before any link', () => {
  const api = sidebar(`
    <div role="listitem"><div data-sidebar-project-kind="local" data-sidebar-project-container-id="project:${id('d')}">
      <div aria-expanded="false" data-app-action-sidebar-project-collapsed="true" data-app-action-sidebar-project-id="${id('d')}" data-app-action-sidebar-project-label="HsH"><span>HsH</span></div></div></div>
    <div role="listitem"><div data-app-action-sidebar-project-id="${id('e').toUpperCase().replace('G-P-', 'g-p-')}" data-app-action-sidebar-project-label="  Homelab   Development "></div></div>
    <div data-app-action-sidebar-project-id="codex:local-folder" data-app-action-sidebar-project-label="Not a ChatGPT Project"></div>
    <a href="/g/${id('d')}-hsh/project">HsH</a>
    <a href="/g/${id('a')}/project">Expanded</a>`);
  expect(api.projectsShown()).toEqual([{ id: id('d'), name: 'HsH' }, { id: id('e'), name: 'Homelab   Development' }, { id: id('a'), name: 'Expanded' }]);
});

it('reports nothing while the sidebar shows no Projects', () => {
  expect(sidebar('<a href="/c/6ad337fe-47a4-83ed-a21f-c2e24d5829a4">A chat</a>').projectsShown()).toEqual([]);
});

it('reports the sidebar Projects to the worker only when the list changed, and again after a failure', async () => {
  const vm = await import('node:vm');
  const { vi } = await import('vitest');
  const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
  const section = source.slice(source.indexOf('  const PROJECT_LIST_MS = '), source.indexOf('  /** Talks to the service worker.'));
  let shown: Array<{ id: string; name: string }> = [];
  let reply: unknown = { ok: true };
  const ask = vi.fn(async () => reply);
  const document = { cookie: 'oai-did=1; _account=team-account-0001; other=2' };
  const context = vm.createContext({ CLF_DOM: { projectsShown: () => shown }, ask, document });
  context.globalThis = context;
  context.top = context;
  vm.runInContext(`${section}\nglobalThis.report = reportProjectList;`, context);
  const report = async () => { (context.report as () => void)(); await new Promise(resolve => setTimeout(resolve, 0)); };
  await report(); await report();
  // An empty sidebar still says which workspace is in use, once (CodeRabbit on #1757).
  expect(ask).toHaveBeenCalledTimes(1);
  expect(ask).toHaveBeenLastCalledWith({ type: 'project_catalog', projects: [], workspace: 'team-account-0001' });
  shown = [{ id: id('a'), name: 'Kunden' }];
  await report(); await report();
  expect(ask).toHaveBeenCalledTimes(2);
  // The workspace ChatGPT shows them in comes along: its Projects open only there.
  expect(ask).toHaveBeenLastCalledWith({ type: 'project_catalog', projects: shown, workspace: 'team-account-0001' });
  shown = [{ id: id('a'), name: 'Kunden' }, { id: id('b'), name: 'New' }];
  reply = { ok: false };
  await report();
  reply = { ok: true };
  await report();
  expect(ask).toHaveBeenCalledTimes(4);
  // The same list in another workspace (no workspace cookie: a personal account) is reported again.
  document.cookie = 'oai-did=1';
  await report();
  expect(ask).toHaveBeenCalledTimes(5);
  expect(ask).toHaveBeenLastCalledWith({ type: 'project_catalog', projects: shown, workspace: null });
  // A frame inside the page never reports.
  context.top = {};
  shown = [{ id: id('c'), name: 'Other' }];
  await report();
  expect(ask).toHaveBeenCalledTimes(5);
  // A malformed account cookie neither throws nor stops the reports; it counts as given.
  context.top = context;
  document.cookie = '_account=100%zz';
  await report();
  expect(ask).toHaveBeenLastCalledWith({ type: 'project_catalog', projects: shown, workspace: '100%zz' });
});

it('reports an unchanged sidebar list again after a day, so a tab left open keeps its Projects in the picker', async () => {
  const vm = await import('node:vm');
  const { vi } = await import('vitest');
  const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
  const section = source.slice(source.indexOf('  const PROJECT_LIST_MS = '), source.indexOf('  /** Talks to the service worker.'));
  let now = Date.parse('2026-10-25T12:00:00Z');
  const ask = vi.fn(async () => ({ ok: true }));
  const context = vm.createContext({ CLF_DOM: { projectsShown: () => [{ id: id('a'), name: 'Kunden' }] }, ask, document: { cookie: '' }, Date: { now: () => now } });
  context.globalThis = context;
  context.top = context;
  vm.runInContext(`${section}\nglobalThis.report = reportProjectList;`, context);
  const report = async () => { (context.report as () => void)(); await new Promise(resolve => setTimeout(resolve, 0)); };
  await report();
  now += 23 * 3_600_000;
  await report();
  expect(ask).toHaveBeenCalledTimes(1);
  now += 2 * 3_600_000;
  await report();
  expect(ask).toHaveBeenCalledTimes(2);
});
