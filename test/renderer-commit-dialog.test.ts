import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CommitState } from '../src/shared/project-git.js';

/**
 * Commit & PR from Review: the dialog lists the changes, starts the message from the chat's task,
 * remembers how far to go, and runs commit, push and pull request as separate steps.
 */
let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event });
});
afterEach(() => dom.window.close());

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });
const fail = (error: string) => Promise.resolve({ ok: false as const, error });
const change = (path: string, status = 'M') => ({ path, status, additions: 1, deletions: 0, binary: false }) as CommitState['changes'][number];
const state = (over: Partial<CommitState> = {}): CommitState => ({
  branch: 'fix-stop', defaultBranch: 'main', remote: 'origin', upstream: null, github: { owner: 'octo', repo: 'app' }, gh: 'ready',
  changes: [change('src/chat.ts'), change('notes.md', 'U')], token: 'a'.repeat(64), ...over
});

async function open(over: Record<string, unknown> = {}, flow: string | undefined = undefined, task: string | null = 'Fix the Stop button') {
  const api = {
    commitState: vi.fn(() => ok(state())),
    commitProject: vi.fn(() => ok({ commit: 'abc1234', branch: 'fix-stop' })),
    pushProject: vi.fn(() => ok({ branch: 'fix-stop', remote: 'origin', tracking: true })),
    createPullRequest: vi.fn(() => ok({ url: 'https://github.com/octo/app/pull/7', via: 'gh' })),
    setCommitFlow: vi.fn(() => ok(true)),
    openLink: vi.fn(() => ok(true)),
    ...over
  };
  const { initCommitDialog } = await import('../src/renderer/commit-dialog.js');
  initCommitDialog(api as any, { flow: () => flow as any, task: () => task }).open('p1');
  await settle();
  return api;
}
const pick = (flow: string) => { const input = document.querySelector<HTMLInputElement>(`input[name="commitFlow"][value="${flow}"]`)!; input.checked = true; input.dispatchEvent(new dom.window.Event('change')); };
const submit = async () => { $('commitForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await settle(); };
const steps = () => [...document.querySelectorAll('.commit-step')].map(step => `${step.className.replace('commit-step ', '')}: ${step.querySelector('.commit-step-text')!.textContent}`);

it('starts from the chat’s task, every file chosen, and asks whether to push when nothing was remembered', async () => {
  await open();
  expect($<HTMLTextAreaElement>('commitMessage').value).toBe('Fix the Stop button\n\n- src/chat.ts\n- notes.md\n');
  expect([...document.querySelectorAll<HTMLInputElement>('.commit-file input')].map(box => box.checked)).toEqual([true, true]);
  expect($('commitFilesLabel').textContent).toBe('Files (2 of 2)');
  expect($('commitWhere').textContent).toBe('On branch fix-stop · pushes to origin');
  expect(document.querySelector<HTMLInputElement>('input[name="commitFlow"]:checked')!.value).toBe('ask-push');
  expect($('commitSubmit').textContent).toBe('Commit 2 files');
  expect($('commitBranchField').hidden).toBe(true);
});

it('commits only the chosen files, then asks before pushing, and pushes on request', async () => {
  const api = await open();
  (document.querySelectorAll<HTMLInputElement>('.commit-file input')[1]!).click();
  expect($('commitFilesLabel').textContent).toBe('Files (1 of 2)');
  // The button says how many files go in, as the list does (Haz on #1825).
  expect($('commitSubmit').textContent).toBe('Commit 1 file');
  await submit();
  expect(api.commitProject).toHaveBeenCalledWith({ projectId: 'p1', message: 'Fix the Stop button\n\n- src/chat.ts\n- notes.md', paths: ['src/chat.ts'], expectedToken: 'a'.repeat(64) });
  expect(api.setCommitFlow).toHaveBeenCalledWith('ask-push');
  expect(steps()).toEqual(['is-done: Committed 1 file as abc1234 on fix-stop']);
  expect(api.pushProject).not.toHaveBeenCalled();
  expect($('commitStepAction').textContent).toBe('Push');
  expect($('commitNotNow').hidden).toBe(false);
  $('commitStepAction').click(); await settle();
  expect(steps()).toEqual(['is-done: Committed 1 file as abc1234 on fix-stop', 'is-done: Pushed fix-stop to origin']);
  expect($('commitStepAction').hidden).toBe(true);
  expect($('commitDoneClose').hidden).toBe(false);
});

it('commits, pushes and opens the pull request in one go, with a link to it', async () => {
  const api = await open({}, 'pr');
  // A remembered pull request is spelled out on the button: it pushes too (Haz on #1825).
  expect($('commitSubmit').textContent).toBe('Commit 2 files, push and open a pull request');
  expect($('commitFlowNote').textContent).toBe('The GitHub CLI creates the pull request.');
  await submit();
  expect(api.createPullRequest).toHaveBeenCalledWith('p1', 'Fix the Stop button', '- src/chat.ts\n- notes.md');
  expect(steps()).toEqual(['is-done: Committed 2 files as abc1234 on fix-stop', 'is-done: Pushed fix-stop to origin', 'is-done: Pull request opened']);
  (document.querySelector<HTMLButtonElement>('.commit-step-link'))!.click();
  expect(api.openLink).toHaveBeenCalledWith('https://github.com/octo/app/pull/7', { external: true });
});

it('puts a pull request from the default branch on a new branch named after the message', async () => {
  const api = await open({ commitState: vi.fn(() => ok(state({ branch: 'main' }))) }, 'pr');
  expect($('commitBranchField').hidden).toBe(false);
  expect($<HTMLInputElement>('commitBranch').value).toBe('fix-the-stop-button');
  const message = $<HTMLTextAreaElement>('commitMessage');
  message.value = 'Keep Stop red\n';
  message.dispatchEvent(new dom.window.Event('input'));
  expect($<HTMLInputElement>('commitBranch').value).toBe('keep-stop-red');
  // Typed by the person: a later message no longer renames it.
  const branch = $<HTMLInputElement>('commitBranch');
  branch.value = 'my-branch'; branch.dispatchEvent(new dom.window.Event('input'));
  message.value = 'Other'; message.dispatchEvent(new dom.window.Event('input'));
  await submit();
  expect(api.commitProject).toHaveBeenCalledWith(expect.objectContaining({ newBranch: 'my-branch' }));
  // Commit only: no new branch needed on the default branch.
  pick('commit');
  expect($('commitBranchField').hidden).toBe(true);
});

it('retries only the step that failed, and shows Git’s own words untranslated under a translated sentence', async () => {
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  let pushes = 0;
  const api = await open({ pushProject: vi.fn(() => ++pushes === 1
    ? fail('The remote has commits this branch does not have. Pull them first, then push again.')
    : fail('Git could not push:\nremote: Repository archived.')) }, 'pr');
  await submit();
  expect(steps()).toEqual(['is-done: 2 Dateien als abc1234 auf fix-stop committet', 'is-failed: Nicht gepusht']);
  expect($('commitStepError').textContent).toBe('Das Remote hat Commits, die dieser Branch nicht hat. Hol sie zuerst (Pull) und pushe dann erneut.');
  $('commitStepAction').click(); await settle();
  expect(api.commitProject).toHaveBeenCalledTimes(1);
  expect(api.pushProject).toHaveBeenCalledTimes(2);
  expect($('commitStepError').textContent).toBe('Git konnte nicht pushen:\nremote: Repository archived.');
  expect(api.createPullRequest).not.toHaveBeenCalled();
});

it("says GitHub's page opened when there is no gh to create the pull request", async () => {
  await open({ commitState: vi.fn(() => ok(state({ gh: 'missing' }))),
    createPullRequest: vi.fn(() => ok({ url: 'https://github.com/octo/app/compare/main...fix-stop?expand=1', via: 'browser' })) }, 'pr');
  expect($('commitFlowNote').textContent).toBe("GitHub's page opens to create the pull request. With the GitHub CLI (gh) signed in, the app creates it directly.");
  await submit();
  expect(steps().at(-1)).toBe("is-done: GitHub's page opened in your browser. Create the pull request there.");
  expect(document.querySelector('.commit-step-link')).toBeNull();
});

it('offers only what the repository can do', async () => {
  await open({ commitState: vi.fn(() => ok(state({ remote: null, github: null, gh: null }))) }, 'pr');
  const disabled = [...document.querySelectorAll<HTMLInputElement>('input[name="commitFlow"]')].map(input => input.disabled);
  expect(disabled).toEqual([false, true, true]);
  expect(document.querySelector<HTMLInputElement>('input[name="commitFlow"]:checked')!.value).toBe('commit');
  expect($('commitFlowNote').textContent).toBe('This repository has no remote to push to.');
  expect($('commitWhere').textContent).toBe('On branch fix-stop');
});

it('says why a pull request cannot be chosen when the remote is not on GitHub, whatever is chosen', async () => {
  // The live case on Windows: a remote on a local path, the person's remembered choice "ask".
  await open({ commitState: vi.fn(() => ok(state({ github: null, gh: null }))) }, 'ask-push');
  const disabled = [...document.querySelectorAll<HTMLInputElement>('input[name="commitFlow"]')].map(input => input.disabled);
  expect(disabled).toEqual([false, false, true]);
  expect(document.querySelector<HTMLInputElement>('input[name="commitFlow"]:checked')!.value).toBe('ask-push');
  expect($('commitFlowNote').hidden).toBe(false);
  expect($('commitFlowNote').textContent).toBe('Pull requests need a remote on GitHub.');
});

it('asks for a new branch for a pull request when the default branch is not known here', async () => {
  // No remote HEAD and no main or master: the current branch might be the default one.
  await open({ commitState: vi.fn(() => ok(state({ defaultBranch: null }))) }, 'pr');
  expect($('commitBranchField').hidden).toBe(false);
  pick('ask-push');
  expect($('commitBranchField').hidden).toBe(true);
});

it('keeps the dialog open while a push runs, and shows how it ended', async () => {
  let finish!: (value: unknown) => void;
  const api = await open({ pushProject: vi.fn(() => new Promise(resolve => { finish = resolve; })) });
  await submit();
  $('commitStepAction').click(); await settle();
  expect(steps().at(-1)).toBe('is-working: Pushing…');
  expect($<HTMLButtonElement>('commitClose').disabled).toBe(true);
  $('commitClose').click();
  $('commitDialog').dispatchEvent(new dom.window.Event('cancel', { cancelable: true }));
  expect($<HTMLDialogElement>('commitDialog').open).toBe(true);
  finish({ ok: false, error: 'The remote has commits this branch does not have. Pull them first, then push again.' });
  await settle();
  expect(steps().at(-1)).toBe('is-failed: Not pushed');
  expect($<HTMLButtonElement>('commitClose').disabled).toBe(false);
  expect(api.pushProject).toHaveBeenCalledTimes(1);
});

it('reads the list again when the changes moved on, keeping the message, and commits only after the person looks again', async () => {
  let reads = 0;
  const api = await open({
    commitState: vi.fn(() => ok(state(++reads === 1 ? {} : { changes: [change('src/chat.ts'), change('new.ts', 'U')], token: 'b'.repeat(64) }))),
    commitProject: vi.fn(() => fail('The changes changed. Review them again before committing.'))
  });
  const message = $<HTMLTextAreaElement>('commitMessage');
  message.value = 'My own words';
  await submit();
  expect(api.commitState).toHaveBeenCalledTimes(2);
  expect(message.value).toBe('My own words');
  expect($('commitError').textContent).toBe('The changes changed, so the list was read again. Check it, then commit.');
  expect([...document.querySelectorAll('.commit-file-path')].map(node => node.textContent)).toEqual(['src/chat.ts', 'new.ts']);
  expect($('commitForm').hidden).toBe(false);
});

it('says why when reading the list again fails, instead of claiming it was read', async () => {
  let reads = 0;
  await open({
    commitState: vi.fn(() => ++reads === 1 ? ok(state()) : fail('Git took too long to respond')),
    commitProject: vi.fn(() => fail('The changes changed. Review them again before committing.'))
  });
  await submit();
  expect($('commitError').textContent).toContain('Git took too long to respond');
  expect($('commitError').textContent).not.toContain('was read again');
});

it('keeps a pull request title within what GitHub takes, moving the rest of a long first line into the description', async () => {
  const api = await open({}, 'pr');
  const long = 'x'.repeat(1200);
  $<HTMLTextAreaElement>('commitMessage').value = `${long}\n\nWhy it changed`;
  await submit();
  const [, title, body] = api.createPullRequest.mock.calls[0] as unknown as [string, string, string];
  expect(title.length).toBeLessThanOrEqual(256);
  expect(`${title}${body}`.replace(/…/g, '')).toContain('x'.repeat(1200 - 256));
  expect(body).toContain('Why it changed');
});

it('needs a message and a file, and never commits a file in conflict', async () => {
  const api = await open({ commitState: vi.fn(() => ok(state({ changes: [change('a.ts'), change('b.ts', 'C')] }))) });
  const boxes = [...document.querySelectorAll<HTMLInputElement>('.commit-file input')];
  expect(boxes.map(box => [box.checked, box.disabled])).toEqual([[true, false], [false, true]]);
  $<HTMLTextAreaElement>('commitMessage').value = '  ';
  await submit();
  expect($('commitError').textContent).toBe('Write a commit message.');
  $<HTMLTextAreaElement>('commitMessage').value = 'x';
  $('commitFilesAll').click();
  expect($<HTMLButtonElement>('commitSubmit').disabled).toBe(true);
  expect($('commitFilesAll').textContent).toBe('Select all');
  expect(api.commitProject).not.toHaveBeenCalled();
});
