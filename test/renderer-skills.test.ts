import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';

let dom: JSDOM;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const library = (skills = [
  { id: 'review', name: 'Code review', description: 'Review a change for correctness.' },
  { id: 'docs', name: 'Docs helper', description: 'Write concise documentation.' }
]) => ({ directory: 'C:\\skills', skills, errors: [] as string[] });

async function mount(initial = library(), overrides: Record<string, unknown> = {}) {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'), { url: 'http://localhost' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () {
    if (!this.open) return;
    this.open = false; this.dispatchEvent(new dom.window.Event('close'));
  };
  let identity = '1:new';
  const api = {
    skillsList: vi.fn(async () => ({ ok: true as const, data: initial })),
    skillsImport: vi.fn(async () => ({ ok: true as const, data: null })),
    skillsOpenFolder: vi.fn(async () => ({ ok: true as const, data: undefined })),
    skillsRemove: vi.fn(async (id: string) => ({ ok: true as const, data: { ...initial, skills: initial.skills.filter(skill => skill.id !== id) } })),
    ...overrides
  };
  const module = await import('../src/renderer/skills.js');
  const input = dom.window.document.getElementById('chatInput') as HTMLTextAreaElement;
  const controller = module.createSkills({ api: api as any, input, getDraftIdentity: () => identity });
  return { module, api, input, controller, setIdentity: (next: string) => { identity = next; } };
}

afterEach(() => {
  dom?.window.close();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('puts Skills third in the Plus menu and provides a narrow dialog shell', async () => {
  const mounted = await mount();
  const ids = [...dom.window.document.querySelectorAll<HTMLButtonElement>('#attachmentMenu .composer-popover > button')].map(button => button.id);
  expect(ids).toEqual(['attachImages', 'composerFolder', 'composerSkills']);
  expect(dom.window.document.getElementById('skillsDialog')).toBeInstanceOf(dom.window.HTMLDialogElement);
  expect(dom.window.document.getElementById('skillsSearch')?.getAttribute('type')).toBe('search');
  expect(mounted.api.skillsList).not.toHaveBeenCalled();
});

it('recognizes slash completion only in the leading command block', async () => {
  const { module } = await mount();
  expect(module.skillCommandTrigger('/', 1)).toMatchObject({ kind: 'slash', query: '' });
  expect(module.skillCommandTrigger('/review\n/do', 11)).toMatchObject({ kind: 'slash', query: 'do', lineStart: 8 });
  expect(module.skillCommandTrigger('/prompt', 7)).toMatchObject({ kind: 'prompt' });
  expect(module.skillCommandTrigger('/prompt review\n/', 16)).toMatchObject({ kind: 'slash' });
  expect(module.skillCommandTrigger('Actual task\n/', 13)).toBeNull();
  expect(module.skillCommandTrigger('> quoted\n/', 11)).toBeNull();
  expect(module.skillCommandTrigger('```ts\n/', 7)).toBeNull();
  expect(module.skillCommandTrigger('/review\n\n/', 10)).toBeNull();
});

it('inserts distinct skill commands ahead of the task while preserving prompt directives', async () => {
  const { module } = await mount();
  const known = ['review', 'docs'];
  expect(module.insertSkillCommand('Build the thing', 'review', known).text).toBe('/review\nBuild the thing');
  expect(module.insertSkillCommand('/review\nBuild the thing', 'docs', known).text).toBe('/review\n/docs\nBuild the thing');
  expect(module.insertSkillCommand('/review\nBuild the thing', 'review', known).text).toBe('/review\nBuild the thing');
  expect(module.insertSkillCommand('/prompt legacy\nBuild the thing', 'docs', known).text).toBe('/prompt legacy\n/docs\nBuild the thing');
  const trigger = module.skillCommandTrigger('/prompt\nBuild the thing', 7)!;
  expect(module.insertSkillCommand('/prompt\nBuild the thing', 'review', known, trigger).text).toBe('/review\nBuild the thing');
});

it('opens the installed list, filters it, and Use preserves the authored task', async () => {
  const { input, api } = await mount();
  input.value = 'Keep this exact task';
  dom.window.document.getElementById('composerSkills')!.click();
  await tick();
  const dialog = dom.window.document.getElementById('skillsDialog') as HTMLDialogElement;
  expect(dialog.open).toBe(true);
  expect(api.skillsList).toHaveBeenCalledTimes(1);
  expect([...dialog.querySelectorAll('.skill-row')]).toHaveLength(2);
  const search = dom.window.document.getElementById('skillsSearch') as HTMLInputElement;
  search.value = 'documentation'; search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  expect([...dialog.querySelectorAll<HTMLElement>('.skill-row')].map(row => row.dataset.skillId)).toEqual(['docs']);
  dialog.querySelector<HTMLButtonElement>('.skill-use')!.click();
  expect(input.value).toBe('/docs\nKeep this exact task');
  expect(dialog.open).toBe(false);
});

it('replaces a failed loading state with a translated retry path and recovers in place', async () => {
  const skillsList = vi.fn()
    .mockResolvedValueOnce({ ok: false as const, error: 'disk unavailable' })
    .mockResolvedValueOnce({ ok: true as const, data: library() });
  await mount(library(), { skillsList });
  dom.window.document.getElementById('composerSkills')!.click(); await tick();
  const list = dom.window.document.getElementById('skillsList')!;
  expect(list.textContent).toContain('Skills could not be loaded.');
  expect(list.textContent).not.toContain('Loading skills…');
  const retry = list.querySelector<HTMLButtonElement>('.skills-load-error button')!;
  expect(retry.textContent).toBe('Retry');
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('zh-CN');
  expect(list.textContent).toContain('无法加载技能。');
  expect(retry.textContent).toBe('重试');
  retry.click(); await tick();
  expect(skillsList).toHaveBeenCalledTimes(2);
  expect(list.querySelectorAll('.skill-row')).toHaveLength(2);
  expect(list.textContent).not.toContain('Skills could not be loaded.');
});

it('shows the empty state and keeps import cancellation, import, removal and folder opening local to the dialog', async () => {
  const empty = library([]);
  const imported = library([{ id: 'triage', name: 'Triage', description: 'Sort failures by root cause.' }]);
  const skillsImport = vi.fn()
    .mockResolvedValueOnce({ ok: true, data: null })
    .mockResolvedValueOnce({ ok: true, data: imported });
  const skillsRemove = vi.fn(async () => ({ ok: true as const, data: empty }));
  const skillsOpenFolder = vi.fn(async () => ({ ok: true as const, data: undefined }));
  await mount(empty, { skillsImport, skillsRemove, skillsOpenFolder });
  dom.window.document.getElementById('composerSkills')!.click(); await tick();
  expect(dom.window.document.getElementById('skillsList')!.textContent).toContain('No skills yet.');
  dom.window.document.getElementById('skillsImport')!.click(); await tick();
  expect(dom.window.document.getElementById('skillsList')!.textContent).toContain('No skills yet.');
  dom.window.document.getElementById('skillsImport')!.click(); await tick();
  expect(dom.window.document.querySelector<HTMLElement>('.skill-row')!.dataset.skillId).toBe('triage');
  dom.window.document.getElementById('skillsOpenFolder')!.click(); await tick();
  expect(skillsOpenFolder).toHaveBeenCalledTimes(1);
  dom.window.document.querySelector<HTMLButtonElement>('.skill-remove')!.click(); await tick();
  expect(skillsRemove).toHaveBeenCalledWith('triage');
  expect(dom.window.document.getElementById('skillsList')!.textContent).toContain('No skills yet.');
});

it('drops stale modal replies after navigation without touching a newer draft', async () => {
  let resolve!: (reply: { ok: true; data: ReturnType<typeof library> }) => void;
  const skillsList = vi.fn(() => new Promise<{ ok: true; data: ReturnType<typeof library> }>(done => { resolve = done; }));
  const { input, controller, setIdentity } = await mount(library(), { skillsList });
  input.value = 'draft A';
  dom.window.document.getElementById('composerSkills')!.click();
  expect((dom.window.document.getElementById('skillsDialog') as HTMLDialogElement).open).toBe(true);
  input.value = 'draft B typed after navigation'; setIdentity('2:other'); controller.syncDraft();
  expect((dom.window.document.getElementById('skillsDialog') as HTMLDialogElement).open).toBe(false);
  resolve({ ok: true, data: library() }); await tick();
  expect(input.value).toBe('draft B typed after navigation');
  expect(dom.window.document.querySelector('.skill-row')).toBeNull();
});

it('filters bare slash autocomplete and consumes Arrow/Enter/Tab/Escape without changing IME sends', async () => {
  const { input, controller } = await mount();
  input.value = '/'; input.setSelectionRange(1, 1); controller.onInput(); await tick();
  const popup = dom.window.document.getElementById('skillAutocomplete')!;
  expect(popup.hidden).toBe(false);
  expect([...popup.querySelectorAll('strong')].map(node => node.textContent)).toEqual(['/review', '/docs']);

  const down = new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
  expect(controller.onKeydown(down)).toBe(true); expect(down.defaultPrevented).toBe(true);
  const enter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
  expect(controller.onKeydown(enter)).toBe(true); expect(input.value).toBe('/docs\n');

  input.value = '/rev'; input.setSelectionRange(4, 4); controller.onInput(); await tick();
  const tab = new dom.window.KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
  expect(controller.onKeydown(tab)).toBe(true); expect(input.value).toBe('/review\n');

  input.value = '/'; input.setSelectionRange(1, 1); controller.onInput();
  const escape = new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
  expect(controller.onKeydown(escape)).toBe(true); expect(popup.hidden).toBe(true); expect(input.value).toBe('/');
  const composing = new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, cancelable: true });
  expect(controller.onKeydown(composing)).toBe(false); expect(composing.defaultPrevented).toBe(false);
});

it('refreshes installed skills once per newly opened slash-completion cycle, not per keystroke', async () => {
  const first = library([{ id: 'review', name: 'Review', description: 'Review code.' }]);
  const second = library([{ id: 'fresh_skill.v2', name: 'Fresh skill', description: 'Added after the first completion.' }]);
  const skillsList = vi.fn()
    .mockResolvedValueOnce({ ok: true, data: first })
    .mockResolvedValueOnce({ ok: true, data: second });
  const { input, controller } = await mount(first, { skillsList });
  input.value = '/'; input.setSelectionRange(1, 1); controller.onInput(); await tick();
  expect(skillsList).toHaveBeenCalledTimes(1);
  input.value = '/rev'; input.setSelectionRange(4, 4); controller.onInput(); await tick();
  expect(skillsList).toHaveBeenCalledTimes(1);
  controller.onKeydown(new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  input.value = '/'; input.setSelectionRange(1, 1); controller.onInput(); await tick();
  expect(skillsList).toHaveBeenCalledTimes(2);
  expect(dom.window.document.getElementById('skillAutocomplete')!.textContent).toContain('/fresh_skill.v2');
});

it('keeps a successful import authoritative when an older list reply arrives later', async () => {
  let resolveList!: (reply: { ok: true; data: ReturnType<typeof library> }) => void;
  const old = library([{ id: 'old', name: 'Old', description: 'Old catalog.' }]);
  const imported = library([{ id: 'new_skill', name: 'New skill', description: 'Imported catalog.' }]);
  const skillsList = vi.fn(() => new Promise<{ ok: true; data: ReturnType<typeof library> }>(done => { resolveList = done; }));
  const skillsImport = vi.fn(async () => ({ ok: true as const, data: imported }));
  await mount(old, { skillsList, skillsImport });
  dom.window.document.getElementById('composerSkills')!.click();
  dom.window.document.getElementById('skillsImport')!.click(); await tick();
  expect(dom.window.document.getElementById('skillsList')!.textContent).toContain('New skill');
  resolveList({ ok: true, data: old }); await tick();
  expect(dom.window.document.getElementById('skillsList')!.textContent).toContain('New skill');
  expect(dom.window.document.getElementById('skillsList')!.textContent).not.toContain('Old catalog');
});

it('resets async management controls when the dialog closes and reopens', async () => {
  let resolveImport!: (reply: { ok: true; data: null }) => void;
  let resolveFolder!: (reply: { ok: true; data: undefined }) => void;
  const skillsImport = vi.fn(() => new Promise<{ ok: true; data: null }>(done => { resolveImport = done; }));
  const skillsOpenFolder = vi.fn(() => new Promise<{ ok: true; data: undefined }>(done => { resolveFolder = done; }));
  await mount(library(), { skillsImport, skillsOpenFolder });
  dom.window.document.getElementById('composerSkills')!.click(); await tick();
  const importButton = dom.window.document.getElementById('skillsImport') as HTMLButtonElement;
  const folderButton = dom.window.document.getElementById('skillsOpenFolder') as HTMLButtonElement;
  importButton.click(); folderButton.click();
  expect(importButton.disabled).toBe(true); expect(folderButton.disabled).toBe(true);
  dom.window.document.getElementById('skillsClose')!.click();
  dom.window.document.getElementById('composerSkills')!.click(); await tick();
  expect(importButton.disabled).toBe(false); expect(folderButton.disabled).toBe(false);
  resolveImport({ ok: true, data: null }); resolveFolder({ ok: true, data: undefined }); await tick();
  expect(importButton.disabled).toBe(false); expect(folderButton.disabled).toBe(false);
});

it('does not apply or consume a stale inline choice after the caret moves into prose', async () => {
  const { input, controller } = await mount();
  input.value = '/\nActual task'; input.setSelectionRange(1, 1); controller.onInput(); await tick();
  input.setSelectionRange(input.value.length, input.value.length);
  dom.window.document.querySelector<HTMLButtonElement>('.skill-autocomplete-option')!.click();
  expect(input.value).toBe('/\nActual task');

  input.setSelectionRange(1, 1); controller.onInput(); await tick();
  input.setSelectionRange(input.value.length, input.value.length);
  const enter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
  expect(controller.onKeydown(enter)).toBe(false);
  expect(enter.defaultPrevented).toBe(false);
  expect(input.value).toBe('/\nActual task');
});

it('bare /prompt opens the searchable picker and Enter cannot fall through to composer send', async () => {
  const { input, controller } = await mount();
  input.value = '/prompt'; input.setSelectionRange(7, 7);
  const enter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
  expect(controller.onKeydown(enter)).toBe(true);
  expect(enter.defaultPrevented).toBe(true);
  expect((dom.window.document.getElementById('skillsDialog') as HTMLDialogElement).open).toBe(true);
  await tick();
  dom.window.document.querySelector<HTMLButtonElement>('.skill-use')!.click();
  expect(input.value).toBe('/review\n');
});
