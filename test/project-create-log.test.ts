import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { addProject, armProjectCreate, claimProjectCreate, completeProjectCreate, failProjectCreate, getProject, PROJECT_CREATE_ARMED_MS, retryProjectCreate } from '../src/main/projects.js';
import { validateNewRoot } from '../src/main/sandbox.js';

const logged = vi.hoisted(() => [] as string[]);
vi.mock('../src/main/logger.js', () => ({
  logInfo: (line: string) => { logged.push(line); }, logWarn: (line: string) => { logged.push(line); }, logError: (line: string) => { logged.push(line); }
}));

// #1759: a ChatGPT Project that never appeared left nothing in the log, so a report could not tell
// whether no page took the request, the click never came back, or the app's own clock gave up.
let directory: string, approved: string;
beforeEach(async () => {
  logged.length = 0;
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-project-log-'));
  approved = path.join(directory, 'approved');
  await fs.mkdir(path.join(approved, 'Kunden'), { recursive: true });
  approved = await validateNewRoot(approved, []);
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: approved }] });
});
afterEach(async () => { resetSessionStoreForTests(); resetDurableForTests(); await fs.rm(directory, { recursive: true, force: true }); });

it('logs each step of creating a ChatGPT Project, by project id and never by name', async () => {
  const project = await addProject(path.join(approved, 'Kunden'));
  const request = (project.chatgpt as { requestId: string }).requestId;
  expect(await claimProjectCreate(request, 'page')).toBe(true);
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  try {
    expect(await armProjectCreate(request, 'page')).toBe(true);
    await vi.advanceTimersByTimeAsync(PROJECT_CREATE_ARMED_MS + 100);
  } finally { vi.useRealTimers(); }
  for (let i = 0; i < 40 && (await getProject(project.id))?.chatgpt?.state !== 'uncertain'; i++) await new Promise(resolve => setTimeout(resolve, 25));
  await retryProjectCreate(project.id);
  const steps = logged.filter(line => line.includes(project.id));
  expect(steps).toEqual([
    `projects: project ${project.id} asks for a new ChatGPT Project`,
    `projects: project ${project.id}'s ChatGPT Project went from requested to claimed`,
    `projects: project ${project.id}'s ChatGPT Project went from claimed to creating`,
    `projects: project ${project.id}'s ChatGPT Project went from creating to uncertain: ChatGPT did not show the new Project in time`,
    `projects: project ${project.id}'s ChatGPT Project went from uncertain to requested`
  ]);
  expect(logged.join('\n')).not.toContain('Kunden');
});

it('logs nothing for a step that changed nothing', async () => {
  const project = await addProject(path.join(approved, 'Kunden'));
  const request = (project.chatgpt as { requestId: string }).requestId;
  logged.length = 0;
  expect(await armProjectCreate(request, 'page')).toBe(false);
  expect(await completeProjectCreate(request, 'page', `g-p-${'a'.repeat(32)}`)).toBe(false);
  expect(logged).toEqual([]);
});

it('keeps a reported failure to one short line in the log', async () => {
  const project = await addProject(path.join(approved, 'Kunden'));
  const request = (project.chatgpt as { requestId: string }).requestId;
  expect(await claimProjectCreate(request, 'page')).toBe(true);
  logged.length = 0;
  // Whatever a page reports, the log line stays one line and never runs on.
  expect(await failProjectCreate(request, 'page', `ChatGPT did not open\n\r its dialog\u0000\u2028 ${'x'.repeat(400)}`)).toBe(true);
  expect(logged).toHaveLength(1);
  expect(logged[0]).not.toMatch(/[\u0000-\u001f\u007f\u2028\u2029]/);
  expect(logged[0]).toContain("went from claimed to failed: ChatGPT did not open its dialog x");
  expect(logged[0]!.length).toBeLessThan(330);
});
