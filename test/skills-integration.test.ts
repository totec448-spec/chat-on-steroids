import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { currentCoreInstructions } from '../src/main/mcp/instructions.js';
import { resolveIn } from '../src/main/mcp/kernel.js';
import { emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import { addProject } from '../src/main/projects.js';
import { withSkillsRoot } from '../src/main/skill-context.js';
import { importSkillFile, initSkills, skillsDirectory } from '../src/main/skills.js';
import { prepareFollowupPrompt, prepareSessionPrompt } from '../src/main/session/prompt.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { resetWorkspaces, setWorkspaceFor, workspaceForChat } from '../src/main/workspace.js';
import { MAX_CHATGPT_MESSAGE_CHARS, userPromptText } from '../src/shared/user-prompt.js';
import { DIR_LINK, makeTempDir, removeTempDir } from './helpers.js';

let directory = '';
let approved = '';
let projectDirectory = '';
let userData = '';

beforeEach(async () => {
  directory = await makeTempDir('cos-skills-integration-');
  approved = path.join(directory, 'approved');
  projectDirectory = path.join(approved, 'project');
  userData = path.join(directory, 'user-data');
  await fs.mkdir(projectDirectory, { recursive: true });
  initConfigPath(directory);
  initDurableStore(directory);
  initSessionStore(directory);
  resetWorkspaces();
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: approved }] });
  await initSkills(userData);
});

afterEach(async () => {
  resetWorkspaces();
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

async function installSkill(name: string, description: string, body: string): Promise<{ id: string; text: string }> {
  const source = path.join(directory, `source-${Math.random().toString(36).slice(2)}.md`);
  const text = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${body}`;
  await fs.writeFile(source, text, 'utf8');
  const installed = await importSkillFile(source);
  return { id: installed.id, text };
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function inConversation<T>(conversationId: string, fn: () => T): T {
  const context: CallContext = {
    startedAt: Date.now(),
    transportKey: null,
    agent: 'prime',
    caller: { transportKey: null, requestId: null, conversationId, sessionId: null },
    outcome: null,
    evidence: emptyEvidence(),
  };
  return runInCallContext(context, fn);
}

it('orders metadata, complete selected bodies and AGENTS before preserving the authored message', async () => {
  const alpha = await installSkill('Alpha', 'First integration skill', 'ALPHA_BODY_BEGIN\nDo alpha work.\nALPHA_BODY_END\n');
  const beta = await installSkill('Beta', 'Second integration skill', 'BETA_BODY_BEGIN\nDo beta work.\nBETA_BODY_END\n');
  const project = await addProject(projectDirectory);
  await fs.writeFile(path.join(projectDirectory, 'AGENTS.md'), 'PROJECT_AGENT_RULE\n', 'utf8');

  const authored = '/alpha\n/prompt beta\nImplement the integration.';
  const prompt = await prepareSessionPrompt(authored, { projectId: project.id });
  const metadataAt = prompt.indexOf('# Available skills');
  const selectedAt = prompt.indexOf('# Selected skills');
  const agentsAt = prompt.indexOf('# AGENTS.md instructions for /work/project');
  const authoredAt = prompt.lastIndexOf(authored);

  expect(metadataAt).toBeGreaterThanOrEqual(0);
  expect(selectedAt).toBeGreaterThan(metadataAt);
  expect(agentsAt).toBeGreaterThan(selectedAt);
  expect(authoredAt).toBeGreaterThan(agentsAt);
  expect(prompt).toContain(`<SKILL_INSTRUCTIONS>\n${alpha.text}\n</SKILL_INSTRUCTIONS>`);
  expect(prompt).toContain(`<SKILL_INSTRUCTIONS>\n${beta.text}\n</SKILL_INSTRUCTIONS>`);
  expect(prompt).toContain('ALPHA_BODY_END');
  expect(prompt).toContain('BETA_BODY_END');
  expect(prompt).toContain('PROJECT_AGENT_RULE');
  expect(userPromptText(prompt)).toBe(authored);
});

it('keeps the metadata index fresh and bounded without eagerly copying skill bodies into it', async () => {
  const description = 'metadata '.repeat(30).trim();
  const skill = await installSkill('Metadata Skill', description, 'UNIQUE_BODY_MUST_NOT_BE_IN_INDEX\n');
  const first = await currentCoreInstructions();
  expect(first).toContain('# Available skills');
  expect(first).toContain(`- /${skill.id}: ${JSON.stringify(description.slice(0, 96))}`);
  expect(first).not.toContain(description.slice(96));
  expect(first).not.toContain('UNIQUE_BODY_MUST_NOT_BE_IN_INDEX');

  const installedFile = path.join(skillsDirectory()!, skill.id, 'SKILL.md');
  await fs.writeFile(installedFile, '---\nname: Metadata Skill\ndescription: Refreshed from disk\n---\nNEW_BODY_NOT_IN_INDEX\n', 'utf8');
  const refreshed = await currentCoreInstructions();
  expect(refreshed).toContain(`- /${skill.id}: "Refreshed from disk"`);
  expect(refreshed).not.toContain('NEW_BODY_NOT_IN_INDEX');
});

it('deduplicates multiple selected skills in first-seen order and follow-ups repeat no main setup', async () => {
  await installSkill('Alpha', 'Alpha description', 'ALPHA_FOLLOWUP_BODY\n');
  const review = await installSkill('Review.v2_Foo', 'Review description', 'REVIEW_FOLLOWUP_BODY\n');
  expect(review.id).toBe('review.v2_foo');

  const followup = await prepareFollowupPrompt('Continue the task.', [
    '/alpha\n/review.v2_foo\n/alpha\nTask prose stops command parsing.',
    '/prompt review.v2_foo\n/alpha',
  ]);
  expect(userPromptText(followup)).toBe('Continue the task.');
  expect(occurrences(followup, '## alpha\n')).toBe(1);
  expect(occurrences(followup, '## review.v2_foo\n')).toBe(1);
  expect(followup.indexOf('## alpha\n')).toBeLessThan(followup.indexOf('## review.v2_foo\n'));
  expect(followup).toContain('ALPHA_FOLLOWUP_BODY');
  expect(followup).toContain('REVIEW_FOLLOWUP_BODY');
  expect(followup).not.toContain('# Available skills');
  expect(followup).not.toContain('# AGENTS.md instructions');
  expect(await prepareFollowupPrompt('Plain follow-up with no skill command.')).toBe('Plain follow-up with no skill command.');
});

it('fails visibly when a selected skill is unavailable instead of dropping the selection', async () => {
  await expect(prepareSessionPrompt('/missing-skill\nDo the work.')).rejects.toThrow(/Skill \/missing-skill is unavailable/);
  await expect(prepareFollowupPrompt('Continue.', ['/missing-skill'])).rejects.toThrow(/Skill \/missing-skill is unavailable/);
});

it('preserves complete selected skill text while AGENTS alone spends the 96,000-character slack', async () => {
  await installSkill('Alpha', 'Alpha description', `SKILL_REQUIRED_HEAD\n${'s'.repeat(8_000)}\nSKILL_REQUIRED_TAIL\n`);
  const project = await addProject(projectDirectory);
  await fs.writeFile(path.join(projectDirectory, 'AGENTS.md'), `AGENTS_HEAD\n${'a'.repeat(300_000)}\nAGENTS_TAIL\n`, 'utf8');

  const prompt = await prepareSessionPrompt('/alpha\nRun it.', { projectId: project.id });
  expect(prompt.length).toBe(MAX_CHATGPT_MESSAGE_CHARS);
  expect(prompt).toContain('SKILL_REQUIRED_HEAD');
  expect(prompt).toContain('SKILL_REQUIRED_TAIL');
  expect(prompt).toContain('AGENTS_HEAD');
  expect(prompt).not.toContain('AGENTS_TAIL');
  expect(prompt).toContain('Read AGENTS.md yourself for the remaining instructions.');
  expect(userPromptText(prompt)).toBe('/alpha\nRun it.');
});

it('honors the UTF-8 byte budget without truncating mandatory selected skill bodies', async () => {
  await installSkill('Unicode Skill', 'Unicode description', `UNICODE_SKILL_HEAD\n${'🐱漢字'.repeat(2_000)}\nUNICODE_SKILL_TAIL\n`);
  const authored = '/unicode-skill\nUse it.';
  const mandatory = await prepareSessionPrompt(authored);
  const mandatoryBytes = Buffer.byteLength(mandatory, 'utf8');
  expect(mandatory).toContain('UNICODE_SKILL_TAIL');
  await expect(prepareSessionPrompt(authored, {}, {
    maxChars: MAX_CHATGPT_MESSAGE_CHARS,
    maxBytes: mandatoryBytes - 1,
  })).rejects.toThrow(/delivery limit/);

  const project = await addProject(projectDirectory);
  await fs.writeFile(path.join(projectDirectory, 'AGENTS.md'), `UNICODE_AGENTS_HEAD\n${'🐱漢字'.repeat(50_000)}\nUNICODE_AGENTS_TAIL\n`, 'utf8');
  const maxBytes = mandatoryBytes + 4_096;
  const bounded = await prepareSessionPrompt(authored, { projectId: project.id }, {
    maxChars: MAX_CHATGPT_MESSAGE_CHARS,
    maxBytes,
  });
  expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(maxBytes);
  expect(bounded.length).toBeLessThanOrEqual(MAX_CHATGPT_MESSAGE_CHARS);
  expect(bounded).toContain('UNICODE_SKILL_TAIL');
  expect(bounded).toContain('UNICODE_AGENTS_HEAD');
  expect(bounded).not.toContain('UNICODE_AGENTS_TAIL');
  expect(bounded).toContain('Read AGENTS.md yourself for the remaining instructions.');
  expect(Buffer.from(bounded, 'utf8').toString('utf8')).toBe(bounded);
});

it('rejects selected skill bodies that cannot fit the mandatory 96,000-character frame', async () => {
  await installSkill('Huge Skill', 'Huge description', `HUGE_SKILL_HEAD\n${'h'.repeat(90_000)}\nHUGE_SKILL_TAIL\n`);
  await expect(prepareSessionPrompt('/huge-skill\nRun it.')).rejects.toThrow(/96,000|delivery limit/);
});

it('publishes the canonical managed root when userData was initialized through a directory alias', async () => {
  const canonicalUserData = path.join(directory, 'canonical-user-data');
  const aliasedUserData = path.join(directory, 'aliased-user-data');
  await fs.mkdir(canonicalUserData);
  await fs.symlink(canonicalUserData, aliasedUserData, DIR_LINK);
  await initSkills(aliasedUserData);

  const canonicalSkills = await fs.realpath(path.join(aliasedUserData, 'skills'));
  expect(skillsDirectory()).toBe(canonicalSkills);
  expect(withSkillsRoot({ roots: [{ name: 'work', path: approved }] }).roots).toContainEqual({
    name: 'skills',
    path: canonicalSkills,
  });
});

it('keeps /skills inside the managed library and never lets skill reads replace learned project cwd', async () => {
  const alpha = await installSkill('Alpha', 'Alpha description', 'MANAGED_SKILL_BODY\n');
  await fs.writeFile(path.join(projectDirectory, 'local.txt'), 'project file', 'utf8');
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside secret', 'utf8');

  const roots = withSkillsRoot({ roots: [{ name: 'work', path: approved }] }).roots;
  const managedRoot = roots.find(root => root.name === 'skills');
  expect(managedRoot?.path).toBe(skillsDirectory());
  expect(roots.filter(root => root.name === 'skills')).toHaveLength(1);

  const conversationId = 'skills-workspace-integration';
  setWorkspaceFor(`chat:${conversationId}`, { virtual: '/work/project', real: projectDirectory });
  const selected = await inConversation(conversationId, () => resolveIn(roots, `/skills/${alpha.id}/SKILL.md`));
  expect(selected.root.name).toBe('skills');
  expect(workspaceForChat(conversationId)?.virtual).toBe('/work/project');
  expect((await inConversation(conversationId, () => resolveIn(roots, 'local.txt'))).virtual).toBe('/work/project/local.txt');

  // A broad approved home root may win native-path normalization before /skills.
  const overlapping = withSkillsRoot({ roots: [{ name: 'home', path: directory }, ...roots] }).roots;
  const nativeSkill = await inConversation(conversationId, () => resolveIn(overlapping, path.join(skillsDirectory()!, alpha.id, 'SKILL.md')));
  expect(nativeSkill.root.name).toBe('home');
  expect(workspaceForChat(conversationId)?.virtual).toBe('/work/project');

  const escape = path.join(skillsDirectory()!, 'escape');
  await fs.symlink(outside, escape, DIR_LINK);
  await expect(inConversation(conversationId, () => resolveIn(roots, '/skills/escape/secret.txt'))).rejects.toThrow(/escape|link/i);
  await expect(inConversation(conversationId, () => resolveIn(roots, '/skills/../work/project/local.txt'))).rejects.toThrow(/traversal|\.\./i);

  const forged = { roots: [{ name: 'work', path: approved }, { name: 'skills', path: outside }] };
  const repaired = withSkillsRoot(forged);
  expect(repaired.roots.filter(root => root.name === 'skills')).toEqual([{ name: 'skills', path: skillsDirectory() }]);

  const managed = skillsDirectory()!;
  const parked = path.join(directory, 'parked-skills');
  await fs.rename(managed, parked);
  await fs.symlink(outside, managed, DIR_LINK);
  expect(withSkillsRoot(forged).roots.some(root => root.name === 'skills')).toBe(false);
});
