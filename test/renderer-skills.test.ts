import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { invokedSkills } from '../src/shared/skill-invocation.js';
import { skillCompletion } from '../src/renderer/skills.js';
import type { LibrarySkill, SkillLibrary } from '../src/shared/skills.js';
import type { ProjectDirectoryListing } from '../src/shared/project-files.js';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM('<textarea id="input"></textarea><details open><button id="skills" type="button">Skills</button><button id="add" type="button">+</button></details><div id="picker" hidden></div><div id="selected" hidden></div>', { url: 'https://local.test' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event, Node: dom.window.Node });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => dom.window.close());
const skill: LibrarySkill = { id: 'review', name: 'Review', description: 'Check changes', path: '/skills/review/SKILL.md', managed: true, scope: 'managed', source: 'managed', allowImplicitInvocation: true };
const library = (skills = [skill]): SkillLibrary => ({ skills, errors: [], roots: [], includeInstructions: true });
async function fixture(skills: LibrarySkill[] = [skill], withCommands = false) {
  const { initSkills } = await import('../src/renderer/skills.js');
  const input = document.getElementById('input') as HTMLTextAreaElement;
  const button = document.getElementById('skills')!;
  const host = document.getElementById('picker')!;
  let owner = 'a:1';
  let projectId: string | null = 'project-a';
  const drafts = new Map<string, string>();
  const key = () => owner.split(':')[0]!;
  const list = vi.fn(async () => ({ ok: true as const, data: library(skills) }));
  const listFiles = vi.fn(async (id: string, directory: string): Promise<ProjectDirectoryListing> => ({
    projectId: id, projectName: 'Project', directory,
    entries: directory ? [{ name: 'main.ts', path: `${directory}/main.ts`, kind: 'file', bytes: 20 }] : [
      { name: 'src', path: 'src', kind: 'directory', bytes: null },
      { name: 'README.md', path: 'README.md', kind: 'file', bytes: 20 }
    ], truncated: false
  }));
  const command = vi.fn();
  const picker = initSkills({ input, host, selectedHost: document.getElementById('selected')!, owner: () => owner,
    openButton: button, addButton: document.getElementById('add')!, ...(withCommands ? { command: (name: string) => command(name) } : {}),
    scope: () => ({ sessionId: key(), projectId }), draft: () => drafts.get(key()), saveDraft: text => drafts.set(key(), text), list, listFiles });
  const type = (value: string) => { input.value = value; input.setSelectionRange(value.length, value.length); input.dispatchEvent(new Event('input')); };
  const press = (value: string) => picker.keydown(new dom.window.KeyboardEvent('keydown', { key: value, cancelable: true }));
  const replace = (value: string) => { drafts.set(key(), value); input.value = value; picker.restore(); };
  return { input, button, host, list, listFiles, command, picker, type, key: press, replace,
    project: (value: string | null) => { projectId = value; },
    owner: (value: string) => { owner = value; input.value = drafts.get(key()) ?? ''; picker.restore(); } };
}
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };

it('parses only leading commands, supports /prompt, and deduplicates without consuming prose', () => {
  expect(invokedSkills('/review\n/prompt audit\n/review\nDo this /other')).toEqual(['review', 'audit']);
  expect(invokedSkills('Do /review')).toEqual([]);
  expect(invokedSkills('```\n/review\n```')).toEqual([]);
  expect(invokedSkills('/project/file.md')).toEqual([]);
  expect(() => invokedSkills('/prompt')).toThrow(/Choose/);
});

it('opens Skill completion at an inline slash while leaving paths, links and code literal', () => {
  expect(skillCompletion('Use /rev to inspect this.', 8)).toEqual({ start: 4, end: 8, query: 'rev', kind: 'skill' });
  expect(skillCompletion('See /srv/app/src', 8)).toBeNull();
  expect(skillCompletion('Read [the file](/review)', 22)).toBeNull();
  expect(skillCompletion('Use `/review` here', 12)).toBeNull();
  expect(skillCompletion('```\n/review\n```', 10)).toBeNull();
  expect(skillCompletion('Use `/review', 12)).toBeNull();
  expect(skillCompletion('```\n@src', 8)).toBeNull();
  expect(skillCompletion('Read [file](@src', 16)).toBeNull();
  const prompt = 'Please use /prompt plan';
  expect(skillCompletion(prompt, prompt.length)).toMatchObject({ query: 'plan', kind: 'skill' });
});

it('offers only literal-safe file references and supports escaped spaces', async () => {
  const f = await fixture();
  f.listFiles.mockResolvedValueOnce({ projectId: 'project-a', projectName: 'Project', directory: '', truncated: false,
    entries: [
      { name: 'space dir', path: 'space dir', kind: 'directory', bytes: null },
      { name: 'bad\nname', path: 'bad\nname', kind: 'file', bytes: 1 }
    ] });
  f.type('@'); await settle();
  expect([...f.host.querySelectorAll<HTMLElement>('[data-file-path]')].map(row => row.dataset.filePath)).not.toContain('bad\nname');
  (f.host.querySelector('[data-file-path="space dir"]') as HTMLButtonElement).click(); await settle();
  expect(f.listFiles).toHaveBeenLastCalledWith('project-a', 'space dir');
  expect(f.input.value).toBe('@space\\ dir/');
  (f.host.querySelector('[data-file-path="space dir/main.ts"]') as HTMLButtonElement).click();
  expect(f.input.value).toBe('@space\\ dir/main.ts ');
  const reference = 'Inspect @space\\ dir/';
  expect(skillCompletion(reference, reference.length)).toMatchObject({ kind: 'file', directory: 'space dir' });
});

it('keeps inline /prompt in Skill selection and leading /prompt in app commands', async () => {
  const planSkill = { ...skill, id: 'plan', name: 'Plan', displayName: 'Plan' };
  const f = await fixture([skill, planSkill], true);
  const text = 'Please use /prompt plan for this';
  f.input.value = text; f.input.setSelectionRange(text.indexOf(' for this'), text.indexOf(' for this'));
  f.input.dispatchEvent(new Event('input')); await settle();
  expect(f.host.querySelector('[data-skill-id="plan"]')).not.toBeNull();
  expect([...f.host.querySelectorAll<HTMLElement>('.slash-menu-option')].some(row => row.title === '/plan')).toBe(false);
  expect(f.command).not.toHaveBeenCalled();
  f.type('/prompt plan'); await settle();
  expect([...f.host.querySelectorAll<HTMLElement>('.slash-menu-option')].some(row => row.title === '/plan')).toBe(true);
});

it('finds an @ reference in linear time, however much text comes before it', () => {
  // A pasted run of escaped spaces ("\\ @") made every keystroke rescan the text from each @:
  // 200 KB froze the composer for 17 s. A reference never spans lines and is never this long.
  const pasted = 'x ' + '@\\ '.repeat(66_000) + 'x y';
  const startedAt = performance.now();
  expect(skillCompletion(pasted, pasted.length)).toBeNull();
  expect(skillCompletion(`${pasted}\nsee @src/ma`, pasted.length + 14)).toMatchObject({ kind: 'file', directory: 'src', query: 'ma' });
  expect(performance.now() - startedAt).toBeLessThan(1000);
  // Escaped spaces still work, also at the start of a line, and a long reference still completes.
  expect(skillCompletion('@My\\ Folder/fi', 14)).toMatchObject({ start: 0, kind: 'file', directory: 'My Folder', query: 'fi' });
  expect(skillCompletion('a\n@My\\ Folder/fi', 16)).toMatchObject({ start: 2, kind: 'file', directory: 'My Folder' });
  expect(skillCompletion('a\\\n@b', 5)).toMatchObject({ start: 3, kind: 'file', query: 'b' });
});

it('opens a project-scoped @ picker and inserts a relative file or folder reference', async () => {
  const f = await fixture();
  f.input.value = 'Inspect @src with this file'; f.input.setSelectionRange('Inspect @src'.length, 'Inspect @src'.length);
  f.input.dispatchEvent(new Event('input'));
  await settle();
  expect(f.listFiles).toHaveBeenLastCalledWith('project-a', '');
  expect(f.host.querySelector('[data-file-path="src"]')).not.toBeNull();
  (f.host.querySelector('[data-file-path="src"]') as HTMLButtonElement).click(); await settle();
  expect(f.listFiles).toHaveBeenLastCalledWith('project-a', 'src');
  expect(f.input.value).toBe('Inspect @src/ with this file');
  expect(f.host.querySelector('[data-file-path="src/main.ts"]')).not.toBeNull();
  expect(f.host.hidden).toBe(false);
  (f.host.querySelector('[data-file-path="src/main.ts"]') as HTMLButtonElement).click();
  await settle();
  expect(f.input.value).toBe('Inspect @src/main.ts with this file');
  expect(f.input.selectionStart).toBe('Inspect @src/main.ts '.length);
  expect(f.key('Enter')).toBe(false);
});

it('ends a file reference so Enter is left for the composer to send', async () => {
  const f = await fixture();
  f.type('@'); await settle();
  (f.host.querySelector('[data-file-path="README.md"]') as HTMLButtonElement).click();
  expect(f.input.value).toBe('@README.md ');
  expect(f.key('Enter')).toBe(false);
});

it('offers exact inline Skills for deliberate selection without running app commands', async () => {
  const f = await fixture([skill], true);
  f.input.value = 'Use /review to inspect'; f.input.setSelectionRange('Use /review'.length, 'Use /review'.length);
  f.input.dispatchEvent(new Event('input')); await settle();
  expect(f.host.hidden).toBe(false);
  expect(f.host.querySelectorAll('.slash-menu-option')).toHaveLength(1);
  expect(f.host.querySelector('[data-skill-id="review"]')).not.toBeNull();
  expect(f.key('Enter')).toBe(true);
  expect(f.input.value).toBe('Use Review to inspect');
  expect(invokedSkills(f.picker.authoredText())).toEqual(['review']);
  expect(f.command).not.toHaveBeenCalled();
});

it('does not browse files without a Local Project or turn email addresses into file mentions', async () => {
  const f = await fixture(); f.project(null);
  f.type('Inspect @src'); await settle();
  expect(f.listFiles).not.toHaveBeenCalled();
  expect(f.host.hidden).toBe(true);
  expect(skillCompletion('mail@example.com', 11)).toBeNull();
  expect(skillCompletion('Contact @alice@example.com', 'Contact @alice@example.com'.length)).toBeNull();
  expect(skillCompletion('Use @/etc/passwd', 16)).toBeNull();
});

it('keeps file-reference and email-like checks linear on long composer input', () => {
  expect(skillCompletion('@foo\\\nbar', 9)).toBeNull();
  expect(skillCompletion('@file\\', 6)).toMatchObject({ kind: 'file', query: 'file\\' });
  expect(skillCompletion('@name\\ dir', '@name\\ dir'.length)).toMatchObject({ kind: 'file', query: 'name dir' });
  expect(skillCompletion('@name\\\\ dir', '@name\\\\ dir'.length)).toMatchObject({ kind: 'file', query: 'name\\ dir' });

  const escapedPunctuation = '@' + '\\!'.repeat(3_000);
  const escapedPunctuationWithSuffix = escapedPunctuation + ' tail';
  const ambiguousEmail = '@name@' + 'part.'.repeat(3_000) + 'end/';
  const started = performance.now();
  expect(skillCompletion(escapedPunctuation, escapedPunctuation.length)).toMatchObject({ kind: 'file' });
  expect(skillCompletion(escapedPunctuationWithSuffix, escapedPunctuationWithSuffix.length)).toBeNull();
  expect(skillCompletion(ambiguousEmail, ambiguousEmail.length)).toMatchObject({ kind: 'file' });
  expect(performance.now() - started).toBeLessThan(1_000);
});

it('discards a project listing that returns after the composer changes projects', async () => {
  const f = await fixture();
  let resolveOld!: (listing: ProjectDirectoryListing) => void;
  f.listFiles.mockImplementationOnce((_id, _directory) => new Promise<ProjectDirectoryListing>(resolve => { resolveOld = resolve; }));
  f.type('@');
  f.project('project-b'); f.type('@'); await settle();
  resolveOld({ projectId: 'project-a', projectName: 'Old project', directory: '', truncated: false,
    entries: [{ name: 'old.txt', path: 'old.txt', kind: 'file', bytes: 1 }] });
  await settle();
  expect(f.listFiles).toHaveBeenLastCalledWith('project-b', '');
  expect(f.host.querySelector('[data-file-path="old.txt"]')).toBeNull();
});

it('invalidates a pending file picker when its project is cleared', async () => {
  const f = await fixture();
  let resolve!: (listing: ProjectDirectoryListing) => void;
  f.listFiles.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  f.type('@'); f.project(null); f.input.dispatchEvent(new Event('input'));
  resolve({ projectId: 'project-a', projectName: 'Project', directory: '', truncated: false,
    entries: [{ name: 'old.txt', path: 'old.txt', kind: 'file', bytes: 1 }] });
  await settle();
  expect(f.host.hidden).toBe(true);
  expect(f.host.querySelector('[data-file-path="old.txt"]')).toBeNull();
});

it('shows project file load failures without consuming Enter', async () => {
  const f = await fixture();
  f.listFiles.mockRejectedValueOnce(new Error('Folder is unavailable'));
  f.type('@'); await settle();
  expect(f.host.textContent).toContain('Folder is unavailable');
  expect(f.host.querySelector('[data-file-path]')).toBeNull();
  expect(f.key('Enter')).toBe(false);
  expect(f.input.value).toBe('@');
});

it('reloads the directory when the caret moves and refuses stale keyboard choices', async () => {
  const f = await fixture();
  f.listFiles.mockImplementation(async (projectId, directory) => ({
    projectId, projectName: 'Project', directory, truncated: false,
    entries: [{ name: 'foo.txt', path: directory ? `${directory}/foo.txt` : 'foo.txt', kind: 'file', bytes: 1 }]
  }));
  const text = '@one/foo @two/foo';
  f.input.value = text; f.input.setSelectionRange('@one/foo'.length, '@one/foo'.length);
  f.input.dispatchEvent(new Event('input')); await settle();
  expect(f.listFiles).toHaveBeenLastCalledWith('project-a', 'one');
  f.input.setSelectionRange(text.length, text.length); f.input.dispatchEvent(new Event('click')); await settle();
  expect(f.listFiles).toHaveBeenLastCalledWith('project-a', 'two');
  (f.host.querySelector('[data-file-path="two/foo.txt"]') as HTMLButtonElement).click();
  expect(f.input.value).toBe('@one/foo @two/foo.txt ');

  f.type('@'); await settle();
  const old = f.host.querySelector('[data-file-path="foo.txt"]') as HTMLButtonElement | null;
  expect(old).not.toBeNull();
  f.project('project-b');
  expect(f.key('Enter')).toBe(true);
  expect(f.input.value).toBe('@');
});

it('projects /prompt completion into chips while preserving the existing authored draft', async () => {
  const f = await fixture();
  f.type('/audit\n/prompt re'); await settle();
  expect(f.host.hidden).toBe(false);
  expect(f.key('Enter')).toBe(true);
  expect(f.input.value).toBe('');
  expect(invokedSkills(f.picker.authoredText())).toEqual(['audit', 'review']);
  expect(document.querySelectorAll('.composer-selected-skill')).toHaveLength(2);
  f.replace('/audit\nTask must stay exactly here');
  f.input.value = '/re\n' + f.input.value; f.input.setSelectionRange(3, 3); f.input.dispatchEvent(new Event('input')); await settle();
  (document.querySelector('[data-skill-id="review"].skill-choice') as HTMLButtonElement).click();
  expect(f.input.value).toBe('Task must stay exactly here');
  expect(f.picker.authoredText()).toBe('/audit\n/review\nTask must stay exactly here');
});

it('never traps Enter when loading, empty or unmatched and does not refetch on each character', async () => {
  const f = await fixture();
  let resolve!: (value: { ok: true; data: SkillLibrary }) => void;
  f.list.mockImplementation(() => new Promise(done => { resolve = done; }));
  f.type('/'); expect(f.key('Enter')).toBe(false);
  resolve({ ok: true, data: library([]) }); await settle();
  f.type('/z'); expect(f.key('Enter')).toBe(false);
  f.type('/zz'); expect(f.key('Enter')).toBe(false);
  expect(f.list).toHaveBeenCalledTimes(1);
});

it('shows a clear empty result instead of an empty autocomplete surface', async () => {
  const f = await fixture();
  f.type('/missing'); await settle();
  expect(f.host.hidden).toBe(false);
  expect(f.host.querySelector('[role="status"]')?.textContent).toBe('No matches for “/missing”.');
  expect(f.key('Enter')).toBe(false);
});

it('promotes unambiguous typed skill ids into ordered pills', async () => {
  const grilling: LibrarySkill = { ...skill, id: 'grilling', name: 'Grilling', path: '/skills/grilling/SKILL.md' };
  const audit: LibrarySkill = { ...skill, id: 'audit', name: 'Audit', path: '/skills/audit/SKILL.md' };
  const f = await fixture([grilling, audit]);
  f.type('/grilling'); await settle();
  expect(f.input.value).toBe('');
  expect(f.picker.authoredText()).toBe('/grilling\n');
  f.type('/audit'); await settle();
  expect(f.input.value).toBe('');
  expect(f.picker.authoredText()).toBe('/grilling\n/audit\n');
  expect([...document.querySelectorAll<HTMLElement>('.composer-selected-skill')].map(node => node.dataset.skillId)).toEqual(['grilling', 'audit']);
});

it('does not apply stale choices after caret movement or a selection', async () => {
  const f = await fixture(); f.type('/re'); await settle();
  f.input.setSelectionRange(1, 2);
  expect(f.key('Enter')).toBe(false); expect(f.input.value).toBe('/re');
});
it('waits for committed IME composition before opening autocomplete', async () => {
  const f = await fixture();
  f.input.dispatchEvent(new dom.window.CompositionEvent('compositionstart'));
  f.input.value = '/re'; f.input.setSelectionRange(3, 3);
  f.input.dispatchEvent(new dom.window.InputEvent('input', { isComposing: true }));
  await settle(); expect(f.list).not.toHaveBeenCalled(); expect(f.host.hidden).toBe(true);
  f.input.dispatchEvent(new dom.window.CompositionEvent('compositionend'));
  await settle(); expect(f.list).toHaveBeenCalledTimes(1); expect(f.host.hidden).toBe(false);
});

it('adds only the requested prompt from the popup and removes the slash-menu footer', async () => {
  const f = await fixture(); f.type('/'); await settle();
  expect(document.querySelector('dialog')).toBeNull();
  expect(f.host.querySelector('.skill-add, .skill-menu-footer')).toBeNull();
  const add = document.getElementById('add') as HTMLButtonElement;
  add.click();
  expect(f.input.value).toBe('Please add the following skills to my COS skills:\n');
  expect(f.host.hidden).toBe(true);
});
it('opens completion from the popup without losing draft text or selected skills', async () => {
  const f = await fixture();
  f.replace('/audit\nKeep this task');
  f.button.click(); await settle();
  expect(f.input.value).toBe('/\nKeep this task');
  expect(f.input.selectionStart).toBe(1);
  expect(document.activeElement).toBe(f.input);
  expect(document.querySelector('details')!.open).toBe(false);
  expect(f.host.hidden).toBe(false);
  expect(f.picker.authoredText()).toBe('/audit\n/\nKeep this task');
  expect(f.key('Enter')).toBe(true);
  expect(f.picker.authoredText()).toBe('/audit\n/review\nKeep this task');
  f.owner('b:2'); f.type('Other');
  (document.getElementById('add') as HTMLButtonElement).click();
  expect(f.input.value).toBe('Please add the following skills to my COS skills:\nOther');
  f.owner('a:3'); expect(f.picker.authoredText()).toBe('/audit\n/review\nKeep this task');
});

it('keeps chips in the existing per-chat draft through A to B to A and removes only the chosen directive', async () => {
  const f = await fixture();
  f.replace('/review\n/audit\nKeep my task exactly.\nProse /review stays literal.');
  f.owner('b:2'); f.type('Other chat');
  f.owner('a:3');
  expect(document.querySelectorAll('.composer-selected-skill')).toHaveLength(2);
  expect(f.input.value).toBe('Keep my task exactly.\nProse /review stays literal.');
  document.querySelector<HTMLButtonElement>('[data-skill-id="review"] .composer-selected-skill-remove')!.click();
  expect(f.picker.authoredText()).toBe('/audit\nKeep my task exactly.\nProse /review stays literal.');
  f.owner('b:4'); expect(f.picker.authoredText()).toBe('Other chat');
});

it('shows a failed library load and ignores a result for an old scope', async () => {
  const f = await fixture(); f.list.mockRejectedValueOnce(new Error('Disk is unavailable'));
  f.type('/'); await settle(); expect(f.host.textContent).toContain('Disk is unavailable');
  f.type(''); f.type('/re'); await settle(); expect(f.host.querySelector('[data-skill-id="review"]')).not.toBeNull();
  f.type('');
  let resolve!: (value: { ok: true; data: SkillLibrary }) => void;
  f.list.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  f.type('/'); f.owner('b:2'); f.type('B draft'); resolve({ ok: true, data: library() }); await settle();
  expect(f.picker.authoredText()).toBe('B draft'); expect(f.host.hidden).toBe(true);
});
