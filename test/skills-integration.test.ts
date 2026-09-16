import { beforeAll, afterAll, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTempDir, removeTempDir } from './helpers.js';
import { initSkillsPath, importSkillFile } from '../src/main/skills.js';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { flushRecorder } from '../src/main/session/recorder.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { resolveCwd, resolveIn, type ToolContext } from '../src/main/mcp/kernel.js';
import { currentWorkspace, resetWorkspaces, setWorkspaceFor, workspaceForChat } from '../src/main/workspace.js';
import { emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import { withManagedSkills } from '../src/main/skill-access.js';
import { prepareSessionPrompt, prepareSkillFollowup, fitSessionPrompt } from '../src/main/session/prompt.js';
import { userPromptText } from '../src/shared/user-prompt.js';
import { addProject } from '../src/main/projects.js';

let directory: string, endpoint: McpEndpoint, ctx: ToolContext;
beforeAll(async () => {
  directory = await makeTempDir('cos-skills-integration-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory); await initSkillsPath(directory);
  const config = defaultConfig();
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, enabled: false, allowUnattributedCalls: true } });
  await fs.mkdir(path.join(directory, 'project'));
  ctx = { roots: [{ name: 'project', path: path.join(directory, 'project') }], caps: { ...config.capabilities, screen: true }, readOnly: false };
  await fs.writeFile(path.join(directory, 'review.md'), '# Review\n\nFULL_SKILL_TEXT');
  await importSkillFile(path.join(directory, 'review.md'));
  endpoint = await startMcpServer(() => ctx);
});
afterAll(async () => {
  await endpoint.stop(); await flushRecorder(); await flushDurable(); resetWorkspaces(); resetSessionStoreForTests(); resetDurableForTests(); await removeTempDir(directory);
});
async function rpc(name: string, args: object, surface: 'core' | 'desktop' = 'core') {
  const response = await fetch(endpoint.urls[surface], { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }) });
  const raw = await response.text();
  return JSON.parse(raw.startsWith('{') ? raw : [...raw.matchAll(/^data: (.+)$/gm)].at(-1)![1]!).result;
}
it('reads and installs through existing direct and nested Core tools without exposing other userData', async () => {
  const direct = await rpc('read', { paths: ['/skills/review/SKILL.md'] });
  expect(direct.isError).not.toBe(true); expect(JSON.stringify(direct)).toContain('FULL_SKILL_TEXT');
  const nested = await rpc('exec', { code: 'text(await tools.read({paths:["/skills/review/SKILL.md"]}));' });
  expect(nested.isError).not.toBe(true); expect(JSON.stringify(nested)).toContain('FULL_SKILL_TEXT');
  const patch = await rpc('apply_patch', { patch: '*** Begin Patch\n*** Add File: /skills/new-skill/SKILL.md\n+# New skill\n+Installed by existing tool.\n*** End Patch' });
  expect(patch.isError, JSON.stringify(patch)).not.toBe(true);
  expect(await fs.readFile(path.join(directory, 'skills/new-skill/SKILL.md'), 'utf8')).toContain('Installed by existing tool.');
  const escape = await rpc('read', { paths: ['/skills/../config.json'] });
  expect(JSON.stringify(escape)).not.toContain('openaiApiKey');
  expect(JSON.stringify(escape)).toMatch(/refused|travers|invalid|\.\./i);
  const desktop = await rpc('exec', { code: 'text(await tools.read({paths:["/skills/review/SKILL.md"]}));' }, 'desktop');
  expect(desktop.isError).toBe(true);
  expect(getConfig().roots).toEqual([]);
});
it('preserves live read and write capability enforcement for the managed folder', async () => {
  const caps = ctx.caps;
  try {
    ctx = { ...ctx, caps: { ...caps, read: false, create: false, edit: false }, readOnly: true };
    const deniedRead = await rpc('read', { paths: ['/skills/review/SKILL.md'] });
    expect(JSON.stringify(deniedRead)).toContain('file contents need the Read files permission');
    expect(JSON.stringify(deniedRead)).not.toContain('FULL_SKILL_TEXT');
    const denied = await rpc('apply_patch', { patch: '*** Begin Patch\n*** Add File: /skills/denied/SKILL.md\n+No\n*** End Patch' });
    expect(denied.isError).toBe(true);
    await expect(fs.stat(path.join(directory, 'skills/denied/SKILL.md'))).rejects.toThrow();
  } finally { ctx = { ...ctx, caps, readOnly: false }; }
});
it('does not learn the library as cwd even through a broad overlapping native root', async () => {
  const call = { startedAt: Date.now(), transportKey: null, agent: null, caller: { transportKey: null, requestId: null, conversationId: 'skill-cwd' }, outcome: null, evidence: emptyEvidence() } as CallContext;
  await runInCallContext(call, async () => {
    const broad = withManagedSkills({ roots: [{ name: 'broad', path: directory }] });
    await resolveIn(broad.roots, path.join(directory, 'skills/review/SKILL.md'));
    expect(currentWorkspace()).toBeNull();
    setWorkspaceFor('chat:skill-cwd', { virtual: '/skills', real: path.join(directory, 'skills') });
    expect(workspaceForChat('skill-cwd')).toBeNull();
    await expect(resolveCwd(withManagedSkills({ ...ctx, roots: [] }), undefined)).rejects.toThrow(/No folder/);
    expect((await resolveCwd(withManagedSkills(ctx), '/skills')).real).toBe(path.join(directory, 'skills'));
    expect((await resolveCwd(withManagedSkills(ctx), undefined)).virtual).toBe('/project');
  });
});
it('keeps selected skill text complete and ordered before expendable AGENTS, with explicit followups', async () => {
  const authored = '/prompt review\nKeep my complete task';
  const opening = await prepareSessionPrompt(authored);
  expect(userPromptText(opening)).toBe(authored);
  expect(opening).toContain('FULL_SKILL_TEXT');
  const followup = await prepareSkillFollowup(authored, authored);
  expect(followup).toContain('FULL_SKILL_TEXT'); expect(followup).not.toContain('# Local tools');
  const core = 'CORE\nFULL_SKILL_TEXT';
  const fitted = fitSessionPrompt(authored, core, { directory: '/project', text: 'AGENTS'.repeat(20000), truncated: false }, { maxChars: 1200, maxBytes: 1800 });
  expect(fitted).toContain(core); expect(userPromptText(fitted)).toBe(authored);
  expect(fitted.indexOf('FULL_SKILL_TEXT')).toBeLessThan(fitted.indexOf('# AGENTS'));
  await expect(prepareSkillFollowup(authored, authored, { maxChars: 20, maxBytes: 20 })).rejects.toThrow(/limit/);
  await expect(prepareSkillFollowup('/missing task', '/missing task')).rejects.toThrow();
});

it('keeps both complete selected files when an oversized project AGENTS exhausts the opening budget', async () => {
  const first = '# First skill\nFIRST_BEGIN\n' + 'Keep every instruction.\n'.repeat(650) + 'FIRST_END';
  const second = '# Second skill\nSECOND_BEGIN\n' + 'Preserve this too.\n'.repeat(650) + 'SECOND_END';
  await fs.writeFile(path.join(directory, 'first-full.md'), first);
  await fs.writeFile(path.join(directory, 'second-full.md'), second);
  await importSkillFile(path.join(directory, 'first-full.md'));
  await importSkillFile(path.join(directory, 'second-full.md'));
  const config = getConfig();
  try {
    await saveConfig({ ...config, roots: [{ name: 'project', path: path.join(directory, 'project') }] });
    const project = await addProject(path.join(directory, 'project'));
    await fs.writeFile(path.join(project.path, 'AGENTS.md'), 'AGENTS_BEGIN\n' + 'optional project text\n'.repeat(9000) + 'AGENTS_END');
    const task = '/first-full /prompt second-full\nUSER_TASK_BEGIN\nKeep all of my task.\nUSER_TASK_END';
    const prompt = await prepareSessionPrompt(task, { projectId: project.id });
    expect(prompt).toContain(first);
    expect(prompt).toContain(second);
    expect(userPromptText(prompt)).toBe(task);
    expect(prompt.indexOf('FIRST_BEGIN')).toBeLessThan(prompt.indexOf('SECOND_BEGIN'));
    expect(prompt.indexOf('SECOND_END')).toBeLessThan(prompt.indexOf('AGENTS_BEGIN'));
    expect(prompt).not.toContain('AGENTS_END');
    expect(prompt).toContain('Read AGENTS.md yourself');
    expect(prompt.length).toBeLessThanOrEqual(96_000);
    await expect(prepareSessionPrompt(task, { projectId: project.id }, { maxChars: 20_000, maxBytes: Infinity }))
      .rejects.toThrow(/delivery limit/);
  } finally { await saveConfig(config); }
});

it('delivers selected files totaling more than 96000 characters by trimming their bodies', async () => {
  for (const id of ['large-one', 'large-two']) {
    await fs.writeFile(path.join(directory, `${id}.md`), `# ${id}\n` + 'content '.repeat(8000));
    await importSkillFile(path.join(directory, `${id}.md`));
  }
  const task = '/large-one /large-two\nDo the complete task';
  for (const prompt of [await prepareSessionPrompt(task), await prepareSkillFollowup(task, task)]) {
    expect(userPromptText(prompt)).toBe(task);
    expect(prompt).toContain('# Selected skill: /large-one');
    expect(prompt).toContain('# Selected skill: /large-two');
    expect(prompt).toContain('Read /skills/large-one/SKILL.md');
    expect(prompt).toContain('Read /skills/large-two/SKILL.md');
    expect(prompt.length).toBeLessThanOrEqual(96_000);
  }
});
