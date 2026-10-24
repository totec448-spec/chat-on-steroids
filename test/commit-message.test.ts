import { expect, it } from 'vitest';
import { commitMessageDraft, branchNameFrom } from '../src/shared/commit-message.js';

it("starts with the chat's task and lists the files below", () => {
  expect(commitMessageDraft('Fix the Stop button staying grey after a reload', ['src/chat.ts', 'test/chat.test.ts']))
    .toBe('Fix the Stop button staying grey after a reload\n\n- src/chat.ts\n- test/chat.test.ts\n');
});

it('keeps the first line short, at a word, and uses only the first line of the task', () => {
  const draft = commitMessageDraft('Make the sidebar remember which groups were collapsed when the app restarts and keep pins\nmore detail', ['a.ts']);
  const subject = draft.split('\n')[0]!;
  expect(subject.length).toBeLessThanOrEqual(72);
  expect(subject).toBe('Make the sidebar remember which groups were collapsed when the app');
});

it('ends a long first line at a sentence that fits rather than in the middle of the next one', () => {
  const subject = (task: string) => commitMessageDraft(task, ['a.ts']).split('\n')[0];
  expect(subject('Harmless checkpoint test in the project folder ckpt-live. Use only the app named Chat On Steroids Core.'))
    .toBe('Harmless checkpoint test in the project folder ckpt-live');
  // A sentence too short to say anything is not where it ends.
  expect(subject('Hi. Make the sidebar remember which groups were collapsed when the app restarts and keep pins'))
    .toBe('Hi. Make the sidebar remember which groups were collapsed when the app');
  // A dot inside a name or a number is no sentence end.
  expect(subject('Bump vite.config.ts to 7.2.1 and fix the build of the renderer bundle for the Windows release'))
    .toBe('Bump vite.config.ts to 7.2.1 and fix the build of the renderer bundle');
  expect(subject('Is the Stop button grey? Then reload the window and check that the composer comes back as it was'))
    .toBe('Is the Stop button grey?');
});

it('names the change by its files when there is no task', () => {
  expect(commitMessageDraft(null, ['src/renderer/chat.ts'])).toBe('Update chat.ts\n\n- src/renderer/chat.ts\n');
  expect(commitMessageDraft('   ', ['a.ts', 'b.ts', 'c.ts'])).toBe('Update 3 files\n\n- a.ts\n- b.ts\n- c.ts\n');
});

it('lists at most ten files', () => {
  const files = Array.from({ length: 13 }, (_, index) => `f${index}.ts`);
  const lines = commitMessageDraft('Task', files).split('\n');
  expect(lines.filter(line => line.startsWith('- '))).toHaveLength(11);
  expect(lines.at(-2)).toBe('- and 3 more');
});

it('turns a message into a branch name Git accepts', () => {
  expect(branchNameFrom('Fix the Stop button staying grey!')).toBe('fix-the-stop-button-staying-grey');
  expect(branchNameFrom('Größe & Ä: neue Ansicht')).toBe('grosse-a-neue-ansicht');
  expect(branchNameFrom('修复按钮')).toBe('changes');
  expect(branchNameFrom('a'.repeat(80)).length).toBeLessThanOrEqual(48);
  expect(branchNameFrom('...lock')).toBe('lock');
});
