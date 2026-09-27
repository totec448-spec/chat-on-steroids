import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ManagedSkill } from '../src/shared/skills.js';

let dom: JSDOM | null = null;
afterEach(() => { dom?.window.close(); dom = null; vi.unstubAllGlobals(); vi.resetModules(); });

it('shows the managed library, imports both source shapes, filters and removes only after confirmation', async () => {
  dom = new JSDOM(`<!doctype html><body>
    <input id="skillsSearch"><button id="skillsRefresh"></button>
    <details class="plugin-menu"><summary>Import</summary><div class="plugin-menu-actions"><button id="skillsImportFolder"></button><button id="skillsImportFile"></button><button id="skillsImportGithub"></button></div></details>
    <dialog id="skillGithubDialog"><h2 id="skillGithubTitle"></h2><p id="skillGithubDescription"></p><button id="skillGithubClose"></button><form id="skillGithubForm"><input id="skillGithubUrl"><p id="skillGithubError" hidden></p><button id="skillGithubCancel"></button><button id="skillGithubSubmit"></button></form></dialog>
    <span id="skillsCount"></span><div id="skillsInstalled"></div>
  </body>`, { url: 'https://skills.test/' });
  const w = dom.window;
  for (const [key, value] of Object.entries({ window: w, document: w.document, HTMLElement: w.HTMLElement, HTMLButtonElement: w.HTMLButtonElement, HTMLDialogElement: w.HTMLDialogElement })) vi.stubGlobal(key, value);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  let skills: ManagedSkill[] = [];
  const listManagedSkills = vi.fn(async () => ({ ok: true as const, data: skills }));
  const skillsImport = vi.fn(async (kind: 'folder' | 'file') => {
    skills = [...skills, { id: kind, name: kind === 'folder' ? 'Folder Skill' : 'File Skill', description: 'A reusable method.', path: `/skills/${kind}/SKILL.md`, origin: null }];
    return { ok: true as const, data: skills };
  });
  const skillsRemove = vi.fn(async (id: string) => {
    skills = skills.filter(skill => skill.id !== id);
    return { ok: true as const, data: skills };
  });
  const githubOrigin = { kind: 'github' as const, url: 'https://github.com/acme/skills/tree/main/review', ref: 'main', directory: 'review', commit: 'a'.repeat(40), revision: 'b'.repeat(64), skillSha256: 'c'.repeat(64) };
  const skillsImportGithub = vi.fn(async (_url: string) => {
    skills = [...skills, { id: 'review', name: 'Code Review', description: 'From GitHub.', path: '/skills/review/SKILL.md', origin: githubOrigin }];
    return { ok: true as const, data: skills };
  });
  const skillsUpdateGithub = vi.fn(async (_id: string) => {
    skills = skills.map(skill => skill.id === 'review' ? { ...skill, description: 'Updated from GitHub.' } : skill);
    return { ok: true as const, data: { status: 'updated' as const, skills } };
  });
  const skillsCheckGithub = vi.fn(async (_id: string) => ({ ok: true as const, data: [
    { id: 'review', originRevision: githubOrigin.revision, state: 'available' as const, checkedAt: Date.now() }
  ] }));
  const { initSkillsLibrary } = await import('../src/renderer/skills-library.js');
  const open = initSkillsLibrary({ listManagedSkills, skillsImport, skillsRemove, skillsImportGithub, skillsCheckGithub, skillsUpdateGithub } as any);
  await vi.waitFor(() => expect(w.document.getElementById('skillsInstalled')!.textContent).toContain('No skills installed'));
  (w.document.getElementById('skillsImportFolder') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(w.document.querySelectorAll('.skill-library-card')).toHaveLength(1));
  expect(w.document.querySelector('[data-skill-id="folder"]')!.textContent).toContain('/folder');
  expect(w.document.querySelector('[data-skill-id="folder"] .skill-library-source')!.textContent).toContain('Local');
  expect(w.document.querySelector('[data-skill-id="folder"] .plugin-menu-actions')!.textContent).toContain('Link GitHub source');
  (w.document.getElementById('skillsImportFile') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(w.document.querySelectorAll('.skill-library-card')).toHaveLength(2));
  expect(skillsImport.mock.calls.map(call => call[0])).toEqual(['folder', 'file']);
  const search = w.document.getElementById('skillsSearch') as HTMLInputElement;
  search.value = 'file'; search.dispatchEvent(new w.Event('input'));
  expect(w.document.querySelectorAll('.skill-library-card')).toHaveLength(1);
  expect(w.document.getElementById('skillsCount')!.textContent).toContain('2 skills');
  (w.document.querySelector('[data-skill-id="file"] .plugin-destructive') as HTMLButtonElement).click();
  expect(w.document.getElementById('skillRemoveDialog')).not.toBeNull();
  expect(skillsRemove).not.toHaveBeenCalled();
  (w.document.querySelector('#skillRemoveDialog .pet-delete-cancel') as HTMLButtonElement).click();
  expect(skillsRemove).not.toHaveBeenCalled();
  (w.document.querySelector('[data-skill-id="file"] .plugin-destructive') as HTMLButtonElement).click();
  (w.document.querySelector('#skillRemoveDialog .pet-delete-confirm') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(skillsRemove).toHaveBeenCalledWith('file'));
  await vi.waitFor(() => expect(w.document.getElementById('skillRemoveDialog')).toBeNull());
  expect(w.document.getElementById('skillsInstalled')!.textContent).toContain('No skills match');

  search.value = ''; search.dispatchEvent(new w.Event('input'));
  (w.document.getElementById('skillsImportGithub') as HTMLButtonElement).click();
  expect((w.document.getElementById('skillGithubDialog') as HTMLDialogElement).open).toBe(true);
  (w.document.getElementById('skillGithubUrl') as HTMLInputElement).value = githubOrigin.url;
  w.document.getElementById('skillGithubForm')!.dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
  await vi.waitFor(() => expect(skillsImportGithub).toHaveBeenCalledWith(githubOrigin.url));
  await vi.waitFor(() => expect(w.document.querySelector('[data-skill-id="review"] .skill-library-source')).not.toBeNull());
  expect((w.document.getElementById('skillGithubDialog') as HTMLDialogElement).open).toBe(false);
  expect(w.document.querySelector('[data-skill-id="review"] .skill-library-source')!.textContent).toContain('Up to date');
  (w.document.getElementById('skillsRefresh') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(skillsCheckGithub).toHaveBeenCalledWith('review'));
  await vi.waitFor(() => expect(w.document.querySelector('[data-skill-id="review"] .skill-library-source')!.textContent).toContain('Update available'));
  expect(w.document.querySelector('[data-skill-id="review"] .skill-library-update')).not.toBeNull();
  expect(skillsUpdateGithub).not.toHaveBeenCalled();
  open();
  await vi.waitFor(() => expect(listManagedSkills).toHaveBeenCalledTimes(3));
  expect(skillsCheckGithub).toHaveBeenCalledTimes(1);
  (w.document.querySelector('[data-skill-id="review"] .plugin-menu-actions .btn') as HTMLButtonElement).click();
  expect(w.document.getElementById('skillUpdateDialog')).not.toBeNull();
  expect(skillsUpdateGithub).not.toHaveBeenCalled();
  (w.document.querySelector('#skillUpdateDialog .pet-delete-actions .btn') as HTMLButtonElement).click();
  expect(skillsUpdateGithub).not.toHaveBeenCalled();
  (w.document.querySelector('[data-skill-id="review"] .plugin-menu-actions .btn') as HTMLButtonElement).click();
  (w.document.querySelector('#skillUpdateDialog .pet-delete-actions .btn-solid') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(skillsUpdateGithub).toHaveBeenCalledWith('review'));
  await vi.waitFor(() => expect(w.document.querySelector('[data-skill-id="review"]')!.textContent).toContain('Updated from GitHub.'));
  expect(w.document.querySelector('[data-skill-id="review"] .skill-library-source')!.textContent).toContain('Up to date');
  skillsCheckGithub.mockResolvedValueOnce({ ok: false as const, error: 'GitHub API rate limit reached' } as any);
  await vi.waitFor(() => expect((w.document.getElementById('skillsRefresh') as HTMLButtonElement).disabled).toBe(false));
  (w.document.getElementById('skillsRefresh') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(w.document.querySelector('[data-skill-id="review"] .skill-library-source')!.textContent).toContain('Check failed'));
  expect(w.document.querySelector<HTMLElement>('[data-skill-id="review"] .skill-library-source')!.title).toContain('rate limit');
  await vi.waitFor(() => expect((w.document.getElementById('skillsRefresh') as HTMLButtonElement).disabled).toBe(false));
  (w.document.getElementById('skillsRefresh') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(w.document.querySelector('[data-skill-id="review"] .skill-library-source')!.textContent).toContain('Update available'));
});

it('links a matching local skill from its card without replacing it or hiding GitHub check errors', async () => {
  dom = new JSDOM(`<!doctype html><body>
    <input id="skillsSearch"><button id="skillsRefresh"></button>
    <details class="plugin-menu"><summary>Import</summary><div><button id="skillsImportFolder"></button><button id="skillsImportFile"></button><button id="skillsImportGithub"></button></div></details>
    <dialog id="skillGithubDialog"><h2 id="skillGithubTitle"></h2><p id="skillGithubDescription"></p><button id="skillGithubClose"></button><form id="skillGithubForm"><input id="skillGithubUrl"><p id="skillGithubError" hidden></p><button id="skillGithubCancel"></button><button id="skillGithubSubmit"></button></form></dialog>
    <span id="skillsCount"></span><div id="skillsInstalled"></div>
  </body>`, { url: 'https://skills.test/' });
  const w = dom.window;
  for (const [key, value] of Object.entries({ window: w, document: w.document, HTMLElement: w.HTMLElement, HTMLButtonElement: w.HTMLButtonElement, HTMLDialogElement: w.HTMLDialogElement })) vi.stubGlobal(key, value);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  const local: ManagedSkill = { id: 'review', name: 'Review', description: 'Local instructions.', path: '/skills/review/SKILL.md', origin: null };
  const origin = { kind: 'github' as const, url: 'https://github.com/acme/skills/tree/main/review', ref: 'main', directory: 'review', commit: 'a'.repeat(40), revision: 'b'.repeat(64), skillSha256: 'c'.repeat(64) };
  const listManagedSkills = vi.fn(async () => ({ ok: true as const, data: [local] }));
  const skillsLinkGithub = vi.fn().mockResolvedValueOnce({ ok: false, error: 'The local SKILL.md does not match this GitHub source' })
    .mockResolvedValueOnce({ ok: true, data: [{ ...local, origin }] });
  const skillsCheckGithub = vi.fn(async () => ({ ok: true as const, data: [
    { id: 'review', originRevision: origin.revision, state: 'available' as const, checkedAt: Date.now() }
  ] }));
  const { initSkillsLibrary } = await import('../src/renderer/skills-library.js');
  initSkillsLibrary({ listManagedSkills, skillsLinkGithub, skillsCheckGithub } as any);
  await vi.waitFor(() => expect(w.document.querySelector('.skill-library-card')).not.toBeNull());
  (w.document.querySelector('[data-skill-id="review"] .plugin-menu-actions .btn') as HTMLButtonElement).click();
  expect(w.document.getElementById('skillGithubTitle')!.textContent).toContain('Link Review');
  expect(w.document.getElementById('skillGithubDescription')!.textContent).toContain('Your files stay in place');
  (w.document.getElementById('skillGithubUrl') as HTMLInputElement).value = origin.url;
  w.document.getElementById('skillGithubForm')!.dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
  await vi.waitFor(() => expect(w.document.getElementById('skillGithubError')!.textContent).toContain('does not match'));
  expect(w.document.querySelector('[data-skill-id="review"] .skill-library-source')!.textContent).toContain('Local');
  w.document.getElementById('skillGithubForm')!.dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
  await vi.waitFor(() => expect(skillsLinkGithub).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(w.document.querySelector('[data-skill-id="review"] .skill-library-source')!.textContent).toContain('Update available'));
  expect(skillsCheckGithub).toHaveBeenCalledWith('review');
});

it('automatically checks an installed GitHub skill on page open without installing it', async () => {
  dom = new JSDOM(`<!doctype html><body>
    <input id="skillsSearch"><button id="skillsRefresh"></button>
    <details class="plugin-menu"><summary>Import</summary><div><button id="skillsImportFolder"></button><button id="skillsImportFile"></button><button id="skillsImportGithub"></button></div></details>
    <dialog id="skillGithubDialog"><h2 id="skillGithubTitle"></h2><p id="skillGithubDescription"></p><button id="skillGithubClose"></button><form id="skillGithubForm"><input id="skillGithubUrl"><p id="skillGithubError" hidden></p><button id="skillGithubCancel"></button><button id="skillGithubSubmit"></button></form></dialog>
    <span id="skillsCount"></span><div id="skillsInstalled"></div>
  </body>`, { url: 'https://skills.test/' });
  const w = dom.window;
  for (const [key, value] of Object.entries({ window: w, document: w.document, HTMLElement: w.HTMLElement, HTMLButtonElement: w.HTMLButtonElement, HTMLDialogElement: w.HTMLDialogElement })) vi.stubGlobal(key, value);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  const origin = { kind: 'github' as const, url: 'https://github.com/acme/skills/tree/main/review', ref: 'main', directory: 'review', commit: 'a'.repeat(40), revision: 'b'.repeat(64), skillSha256: 'c'.repeat(64) };
  const installed: ManagedSkill[] = [{ id: 'review', name: 'Code Review', description: 'From GitHub.', path: '/skills/review/SKILL.md', origin }];
  const listManagedSkills = vi.fn(async () => ({ ok: true as const, data: installed }));
  const skillsCheckGithub = vi.fn(async () => ({ ok: true as const, data: [
    { id: 'review', originRevision: origin.revision, state: 'available' as const, checkedAt: Date.now() }
  ] }));
  const skillsUpdateGithub = vi.fn();
  const { initSkillsLibrary } = await import('../src/renderer/skills-library.js');
  const open = initSkillsLibrary({ listManagedSkills, skillsCheckGithub, skillsUpdateGithub } as any);
  await vi.waitFor(() => expect(w.document.querySelector('.skill-library-card')).not.toBeNull());
  expect(skillsCheckGithub).not.toHaveBeenCalled();
  open();
  await vi.waitFor(() => expect(skillsCheckGithub).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(w.document.querySelector('.skill-library-source')!.textContent).toBe('Update available'));
  expect(skillsUpdateGithub).not.toHaveBeenCalled();
  (w.document.querySelector('.skill-library-update') as HTMLButtonElement).click();
  expect(w.document.getElementById('skillUpdateDialog')).not.toBeNull();
  expect(skillsUpdateGithub).not.toHaveBeenCalled();
});
