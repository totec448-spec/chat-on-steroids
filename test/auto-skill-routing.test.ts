import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { initSkillsPath, importSkillPackage } from '../src/main/skills.js';
import { editQueuedInput, enqueueInput, listInputs, resetInputForTests, type InputArgs, type InputEntry } from '../src/main/session/input.js';
import { createSession, initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { prepareSessionPrompt, prepareSkillFollowup } from '../src/main/session/prompt.js';
import { userPromptText } from '../src/shared/user-prompt.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
const request = (text: string, id = randomUUID()): InputArgs => ({ id, sessionId: null, text, authoredSource: 'text',
  mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null });
const routedIds = (row: InputEntry): string[] | undefined => row.autoSkills?.map(skill => skill.id);

async function install(id: string, name: string, description: string, implicit = true): Promise<void> {
  const source = path.join(directory, 'packages', id);
  await fs.mkdir(path.join(source, 'agents'), { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nFULL_${id.toUpperCase().replace(/-/g, '_')}_BODY\n`);
  await fs.writeFile(path.join(source, 'agents', 'openai.yaml'), `policy:\n  allow_implicit_invocation: ${implicit ? 'true' : 'false'}\n`);
  await importSkillPackage(source);
}

async function enableAutoRouting(): Promise<void> {
  const config = defaultConfig();
  await saveConfig({ ...config, ui: { ...config.ui, autoSelectSkills: true } });
}

beforeEach(async () => {
  directory = await makeTempDir('cos-auto-skills-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory); resetInputForTests();
  await initSkillsPath(directory); await saveConfig(defaultConfig());
});

afterEach(async () => {
  vi.unstubAllEnvs(); await flushDurable(); resetInputForTests(); resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});

it('keeps automatic Skill routing off unless the user enables it', async () => {
  await install('code-review', 'Code Review', 'Review source code changes for correctness and maintainability.');
  const row = await enqueueInput(request('Please use Code Review for this source change.'));
  expect(routedIds(row)).toBeUndefined();
});

it('freezes one literal unambiguous metadata match into the durable input owner', async () => {
  await install('code-review', 'Code Review', 'Review source code changes for correctness and maintainability.');
  await enableAutoRouting();
  const row = await enqueueInput(request('Please use Code Review for this source change.'));
  expect(getConfig().ui).toMatchObject({ autoSelectSkills: true });
  expect(routedIds(row)).toEqual(['code-review']);
  expect(row.autoSkills![0]!.revision).toMatch(/^[0-9a-f]{64}$/);
});

it('freezes an explicit none when a literal name is ambiguous or no exact name is present', async () => {
  await install('code-review', 'Code Review', 'Review source code changes for correctness and maintainability.');
  await install('source-review', 'Code Review', 'Review another source change for correctness and maintainability.');
  await enableAutoRouting();
  expect(routedIds(await enqueueInput(request('Please use Code Review for this source change.')))).toEqual([]);
  expect(routedIds(await enqueueInput(request('Prepare a quarterly budget summary.')))).toEqual([]);
});

it('ignores metadata that forbids implicit invocation', async () => {
  await install('code-review', 'Code Review', 'Review source code changes for correctness and maintainability.', false);
  await enableAutoRouting();
  expect(routedIds(await enqueueInput(request('Please use Code Review for this source change.')))).toEqual([]);
});

it('lets an explicit Skill directive override auto-routing for that turn', async () => {
  await install('code-review', 'Code Review', 'Review source code changes for correctness and maintainability.');
  await install('security-audit', 'Security Audit', 'Inspect software for security vulnerabilities and unsafe trust boundaries.');
  await enableAutoRouting();
  const row = await enqueueInput(request('/security-audit\nReview this source code change for correctness.'));
  expect(routedIds(row)).toBeUndefined();
  expect(row.text).toContain('/security-audit');
});

it('reuses the frozen routed set on exact retry even after the metadata catalog changes', async () => {
  await install('code-review', 'Code Review', 'Review source code changes for correctness and maintainability.');
  await enableAutoRouting();
  const id = randomUUID(), input = request('Please use Code Review for this source change.', id);
  const first = await enqueueInput(input);
  expect(routedIds(first)).toEqual(['code-review']);

  // A second candidate with the same literal name would make a fresh routing decision ambiguous. Exact
  // input replay must return the durable owner's already-frozen decision instead of rerouting.
  await install('source-review', 'Code Review', 'Review another source change for correctness and maintainability.');
  resetInputForTests();
  const replay = await enqueueInput(input);
  expect(routedIds(replay)).toEqual(['code-review']);
  expect(replay.autoSkills).toEqual(first.autoSkills);
});

it('clears a frozen automatic selection on deliberate queued text edit instead of rerouting silently', async () => {
  await install('code-review', 'Code Review', 'Review source code changes for correctness and maintainability.');
  await enableAutoRouting();
  const session = await createSession({ title: 'Queued edit', conversationId: 'queued-edit-conversation' });
  const row = await enqueueInput({ ...request('Please use Code Review for this source change.'),
    sessionId: session.id, mode: 'after-turn' });
  expect(routedIds(row)).toEqual(['code-review']);
  expect(await editQueuedInput(row.id, 'Prepare the quarterly budget summary.')).toBe(true);
  expect((await listInputs()).find(entry => entry.id === row.id)?.autoSkills).toBeUndefined();
});

it('injects only the frozen auto-selected full Skill through the existing prompt path and preserves authored text', async () => {
  await install('code-review', 'Code Review', 'Review source code changes for correctness and maintainability.');
  await install('security-audit', 'Security Audit', 'Inspect software for security vulnerabilities and unsafe trust boundaries.');
  const authored = 'Please use Code Review for this source change.';
  await enableAutoRouting();
  const routed = await enqueueInput(request(authored));
  const scope = { autoSkills: routed.autoSkills };
  const opening = await prepareSessionPrompt(authored, scope);
  expect(userPromptText(opening)).toBe(authored);
  expect(opening).toContain('FULL_CODE_REVIEW_BODY');
  expect(opening).not.toContain('FULL_SECURITY_AUDIT_BODY');
  const followup = await prepareSkillFollowup(authored, authored, undefined, scope);
  expect(userPromptText(followup)).toBe(authored);
  expect(followup).toContain('FULL_CODE_REVIEW_BODY');
  expect(followup).not.toContain('FULL_SECURITY_AUDIT_BODY');
});

it('never combines frozen auto ids with an explicit Skill directive', async () => {
  await install('code-review', 'Code Review', 'Review source code changes for correctness and maintainability.');
  await install('security-audit', 'Security Audit', 'Inspect software for security vulnerabilities and unsafe trust boundaries.');
  await enableAutoRouting();
  const routed = await enqueueInput(request('Please use Code Review for this source change.'));
  const authored = '/security-audit\nReview this source code change for correctness.';
  const prompt = await prepareSkillFollowup(authored, authored, undefined, { autoSkills: routed.autoSkills });
  expect(prompt).toContain('FULL_SECURITY_AUDIT_BODY');
  expect(prompt).not.toContain('FULL_CODE_REVIEW_BODY');
  expect(userPromptText(prompt)).toBe(authored);
});

it('does not widen filesystem roots or capabilities when automatic routing is evaluated', async () => {
  await install('code-review', 'Code Review', 'Review source code changes for correctness and maintainability.');
  await enableAutoRouting();
  const before = structuredClone({ roots: getConfig().roots, capabilities: getConfig().capabilities, readOnly: getConfig().readOnly });
  await enqueueInput(request('Please use Code Review for this source change.'));
  expect({ roots: getConfig().roots, capabilities: getConfig().capabilities, readOnly: getConfig().readOnly }).toEqual(before);
});

it('routes from the published metadata snapshot without rereading SKILL.md bodies at admission', async () => {
  await install('code-review', 'Code Review', 'Review source code changes for correctness and maintainability.');
  await enableAutoRouting();
  // The imported metadata is already published. Make the body invalid for a fresh catalog scan;
  // routing must still use that snapshot and defer the selected body read until prompt preparation.
  await fs.writeFile(path.join(directory, 'skills', 'code-review', 'SKILL.md'), 'x'.repeat(140_000));
  const row = await enqueueInput(request('Please use Code Review for this source change.'));
  expect(routedIds(row)).toEqual(['code-review']);
});

it('keeps auto-routed opening preparation metadata-only and reads only the selected full Skill body', async () => {
  await install('code-review', 'Code Review', 'Review source code changes for correctness and maintainability.');
  await install('security-audit', 'Security Audit', 'Inspect software for security vulnerabilities and unsafe trust boundaries.');
  await enableAutoRouting();
  const row = await enqueueInput(request('Please use Code Review for this source change.'));
  expect(routedIds(row)).toEqual(['code-review']);

  // Break only the unselected body after its metadata was published. Auto prompt framing must
  // retain that cached catalog metadata without rescanning the body, while lazily loading the
  // frozen selected body through its exact revision fence.
  await fs.writeFile(path.join(directory, 'skills', 'security-audit', 'SKILL.md'), 'x'.repeat(140_000));
  const prompt = await prepareSessionPrompt(row.text, row);
  expect(prompt).toContain('Security Audit');
  expect(prompt).toContain('FULL_CODE_REVIEW_BODY');
  expect(prompt).not.toContain('FULL_SECURITY_AUDIT_BODY');
});

it('fails closed if an auto-selected Skill body changes after metadata routing but before prompt preparation', async () => {
  await install('code-review', 'Code Review', 'Review source code changes for correctness and maintainability.');
  await enableAutoRouting();
  const row = await enqueueInput(request('Please use Code Review for this source change.'));
  expect(routedIds(row)).toEqual(['code-review']);
  await fs.writeFile(path.join(directory, 'skills', 'code-review', 'SKILL.md'),
    '---\nname: Code Review\ndescription: Review source code changes for correctness and maintainability.\n---\n\nCHANGED_BODY_MUST_NOT_BE_INJECTED\n');
  await expect(prepareSkillFollowup(row.text, row.text, undefined, row)).rejects.toThrow(/changed|revision|route/i);
});

it('keeps personal and project Skills in a routed chat\'s Skill list', async () => {
  // Routing reads only the app's own Skills, but the opening prompt still lists every Skill the
  // chat can use. A routed send used to list only the app's own, dropping the user's ~/.codex
  // Skills (and project and Codex plugin Skills) from new chats whenever auto-select was on.
  vi.stubEnv('HOME', path.join(directory, 'home')); vi.stubEnv('USERPROFILE', path.join(directory, 'home'));
  vi.stubEnv('CODEX_HOME', path.join(directory, 'codex')); vi.stubEnv('ProgramData', path.join(directory, 'admin'));
  await fs.mkdir(path.join(directory, 'codex', 'skills', 'release-notes'), { recursive: true });
  await fs.writeFile(path.join(directory, 'codex', 'skills', 'release-notes', 'SKILL.md'),
    '---\nname: Release Notes\ndescription: Write plain release notes from merged changes.\n---\n\nPERSONAL_BODY\n');
  await install('code-review', 'Code Review', 'Review source code changes for correctness and maintainability.');
  await enableAutoRouting();
  await saveConfig({ ...getConfig(), roots: [{ name: 'workspace', path: directory }] });

  const routed = await enqueueInput(request('Please use Code Review for this source change.'));
  expect(routedIds(routed)).toEqual(['code-review']);
  const none = await enqueueInput(request('Prepare a quarterly budget summary.'));
  expect(routedIds(none)).toEqual([]);
  for (const row of [routed, none]) {
    const prompt = await prepareSessionPrompt(row.text, row);
    expect(prompt).toContain('Release Notes');
    expect(prompt).toContain('Code Review');
    expect(prompt).not.toContain('PERSONAL_BODY');
  }
});
