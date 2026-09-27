import type { AppApi } from '../preload/index.js';
import { parseGitHubSkillUrl, type GitHubSkillUpdateCheck, type ManagedSkill } from '../shared/skills.js';
import { $, el, icon, initCardMenuDismissal, run, toast } from './dom.js';
import { t, ui } from './i18n.js';

/** The managed CoS library only; project and user-discovered skills stay in composer discovery. */
export function initSkillsLibrary(api: AppApi): () => void {
  initCardMenuDismissal();
  let skills: ManagedSkill[] = [];
  let epoch = 0;
  const checks = new Map<string, GitHubSkillUpdateCheck>();
  const checking = new Set<string>();
  let linkTarget: ManagedSkill | null = null;
  const checkAgeMs = 15 * 60_000;
  let checkPass: Promise<void> | null = null;

  const paintSource = (skill: ManagedSkill): void => {
    const source = document.querySelector<HTMLElement>(`[data-skill-id="${skill.id}"] .skill-library-source`);
    if (!source) return;
    if (!skill.origin) {
      source.className = 'skill-library-source is-local';
      source.replaceChildren(icon('i-folder'), el('span', '', () => t('Local')));
      ui(source, 'title', () => t('Link a GitHub source from the card menu to check for updates.'));
      return;
    }
    const check = checks.get(skill.id);
    const state = checking.has(skill.id) ? 'checking' : check?.state ?? 'unknown';
    source.className = `skill-library-source is-${state}`;
    const label = state === 'checking' ? 'Checking…'
      : state === 'available' ? 'Update available'
        : state === 'current' ? 'Up to date'
          : state === 'error' ? 'Check failed' : 'GitHub';
    const marker = state === 'available' ? 'i-retry' : state === 'current' ? 'i-check'
      : state === 'error' ? 'i-warning' : 'i-globe';
    if (state === 'available') {
      const action = el('button', 'skill-library-update') as HTMLButtonElement;
      action.type = 'button';
      action.append(icon(marker), el('span', '', () => t(label)));
      ui(action, 'aria-label', () => `${t('Update from GitHub')}: ${skill.name}`);
      action.addEventListener('click', () => confirmUpdate(skill));
      source.replaceChildren(action);
    } else {
      source.replaceChildren(icon(marker), el('span', '', () => t(label)));
    }
    source.title = check?.error ? `${skill.origin.url}\n${check.error}` : skill.origin.url;
  };

  const render = (): void => {
    const host = $('skillsInstalled');
    const query = $<HTMLInputElement>('skillsSearch').value.trim().toLocaleLowerCase();
    const visible = skills.filter(skill => `${skill.id} ${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query));
    ui($('skillsCount'), 'textContent', () => t(skills.length === 1 ? '{0} skill' : '{0} skills', [skills.length]));
    host.replaceChildren();
    if (!visible.length) {
      const empty = skills.length
        ? t('No skills match your search.')
        : t('No skills installed yet. Import a folder, SKILL.md, or GitHub link to get started.');
      host.append(el('p', 'plugin-no-results muted', empty));
      return;
    }
    for (const skill of visible) {
      const card = el('article', 'plugin-card pet-library-card skill-library-card');
      card.dataset.skillId = skill.id;
      const entry = el('div', 'plugin-entry pet-library-entry');
      const artwork = el('div', 'skill-library-icon'); artwork.append(icon('i-skill'));
      const title = el('div', 'plugin-card-title');
      title.append(el('h2', '', skill.name), el('p', 'muted', skill.description || t('Reusable instructions for this workspace.')));
      const foot = el('div', 'plugin-card-foot');
      foot.append(el('span', 'skill-library-id', `/${skill.id}`));
      const source = el('span', 'skill-library-source');
      source.setAttribute('aria-live', 'polite');
      foot.append(source);
      title.append(foot);
      entry.append(artwork, title);
      const menu = document.createElement('details'); menu.className = 'plugin-menu';
      const summary = el('summary'); summary.append(icon('i-more'));
      ui(summary, 'aria-label', () => t('Actions for {0}', [skill.name]));
      const actions = el('div', 'plugin-menu-actions');
      if (skill.origin) {
        const refresh = el('button', 'btn', () => t('Update from GitHub')) as HTMLButtonElement;
        refresh.type = 'button'; refresh.addEventListener('click', () => { menu.open = false; confirmUpdate(skill); });
        actions.append(refresh);
      } else {
        const link = el('button', 'btn', () => t('Link GitHub source')) as HTMLButtonElement;
        link.type = 'button'; link.addEventListener('click', () => { menu.open = false; openGithubDialog(skill); });
        actions.append(link);
      }
      const remove = el('button', 'btn plugin-destructive', () => t('Remove skill')) as HTMLButtonElement;
      remove.type = 'button'; remove.addEventListener('click', () => confirmRemove(skill));
      actions.append(remove); menu.append(summary, actions); card.append(entry, menu); host.append(card);
      paintSource(skill);
    }
  };

  const setSkills = (next: ManagedSkill[]): void => {
    skills = next;
    for (const [id, check] of checks) {
      if (skills.find(skill => skill.id === id)?.origin?.revision !== check.originRevision) checks.delete(id);
    }
    for (const id of checking) if (!skills.find(skill => skill.id === id)?.origin) checking.delete(id);
    render();
  };

  const update = async (request: Promise<{ ok: true; data: ManagedSkill[] | null } | { ok: false; error: string }>): Promise<boolean> => {
    const own = ++epoch;
    const next = await run(request);
    if (!next || own !== epoch) return false;
    setSkills(next); return true;
  };

  const checkUpdates = (force: boolean): Promise<void> => {
    if (checkPass) return checkPass;
    const due = skills.filter(skill => skill.origin && (force || !checks.has(skill.id) ||
      Date.now() - checks.get(skill.id)!.checkedAt >= (checks.get(skill.id)!.state === 'error' ? 60_000 : checkAgeMs)));
    if (!due.length) return Promise.resolve();
    const groups = new Map<string, ManagedSkill[]>();
    for (const skill of due) {
      const location = parseGitHubSkillUrl(skill.origin!.url);
      const key = `${location.owner.toLowerCase()}/${location.repository.toLowerCase()}@${location.ref}`;
      groups.set(key, [...(groups.get(key) ?? []), skill]);
      checking.add(skill.id);
    }
    const batches = [...groups.values()];
    $<HTMLButtonElement>('skillsRefresh').disabled = true;
    for (const skill of due) paintSource(skill);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < batches.length) {
        const batch = batches[next++]!;
        let result: GitHubSkillUpdateCheck[] = [];
        let error: string | null = null;
        try {
          const reply = await api.skillsCheckGithub(batch[0]!.id);
          if (reply.ok) result = reply.data;
          else error = reply.error;
        } catch { error = t('Could not reach GitHub. Try again.'); }
        const checkedAt = Date.now();
        for (const skill of batch) {
          checking.delete(skill.id);
          const current = skills.find(item => item.id === skill.id);
          if (current?.origin?.revision !== skill.origin!.revision) continue;
          const check = result.find(item => item.id === skill.id && item.originRevision === skill.origin!.revision);
          checks.set(skill.id, check ?? { id: skill.id, originRevision: skill.origin!.revision,
            state: 'error', checkedAt, error: error ?? 'GitHub check did not return this skill' });
        }
        for (const skill of batch) paintSource(skill);
      }
    };
    checkPass = Promise.all(Array.from({ length: Math.min(3, batches.length) }, worker)).then(() => undefined).finally(() => {
      checkPass = null;
      $<HTMLButtonElement>('skillsRefresh').disabled = false;
    });
    return checkPass;
  };

  const confirmUpdate = (skill: ManagedSkill): void => {
    if (!skill.origin) return;
    document.querySelector('#skillUpdateDialog')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'skillUpdateDialog'; dialog.className = 'plugin-dialog pet-delete-dialog';
    const head = el('div', 'plugin-dialog-head');
    const title = el('h2', '', () => t('Update {0}?', [skill.name]));
    title.id = 'skillUpdateTitle'; dialog.setAttribute('aria-labelledby', title.id);
    const close = el('button', 'btn', () => t('Close')) as HTMLButtonElement;
    close.type = 'button'; close.addEventListener('click', () => dialog.close()); head.append(title, close);
    const body = el('div', 'plugin-dialog-body');
    body.append(el('p', '', () => t('Check this GitHub source for changes. If it changed, CoS replaces the whole skill folder and moves the previous version to Trash. Local edits to resources will be replaced.')));
    body.append(el('p', 'skill-source-url', skill.origin.url));
    const actions = el('div', 'pet-delete-actions');
    const cancel = el('button', 'btn', () => t('Cancel')) as HTMLButtonElement;
    cancel.type = 'button'; cancel.addEventListener('click', () => dialog.close());
    const submit = el('button', 'btn btn-solid', () => t('Check and update')) as HTMLButtonElement;
    submit.type = 'button'; submit.addEventListener('click', () => void (async () => {
      submit.disabled = close.disabled = cancel.disabled = true;
      dialog.setAttribute('aria-busy', 'true'); ui(submit, 'textContent', () => t('Checking GitHub…'));
      const own = ++epoch;
      try {
        const result = await run(api.skillsUpdateGithub(skill.id));
        if (!result) return;
        if (own === epoch) {
          checking.delete(skill.id);
          setSkills(result.skills);
          const installed = skills.find(item => item.id === skill.id);
          if (installed?.origin) {
            checks.set(skill.id, { id: skill.id, originRevision: installed.origin.revision, state: 'current', checkedAt: Date.now() });
            paintSource(installed);
          }
        }
        else void update(api.listManagedSkills());
        toast(result.warning ? t(result.warning) : t(result.status === 'current' ? 'Skill is already up to date' : 'Skill updated from GitHub'));
        dialog.close();
      } catch {
        toast(t('Could not reach GitHub. Try again.'));
      } finally {
        if (submit.isConnected) {
          submit.disabled = close.disabled = cancel.disabled = false;
          dialog.removeAttribute('aria-busy'); ui(submit, 'textContent', () => t('Check and update'));
        }
      }
    })());
    actions.append(cancel, submit); body.append(actions); dialog.append(head, body);
    dialog.addEventListener('click', event => { if (event.target === dialog && !submit.disabled) dialog.close(); });
    dialog.addEventListener('cancel', event => { if (submit.disabled) event.preventDefault(); });
    dialog.addEventListener('close', () => dialog.remove()); document.body.append(dialog); dialog.showModal(); cancel.focus();
  };

  const confirmRemove = (skill: ManagedSkill): void => {
    document.querySelector('#skillRemoveDialog')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'skillRemoveDialog'; dialog.className = 'plugin-dialog pet-delete-dialog';
    const head = el('div', 'plugin-dialog-head');
    const title = el('h2', '', () => t('Remove {0}?', [skill.name]));
    title.id = 'skillRemoveTitle'; dialog.setAttribute('aria-labelledby', title.id);
    const close = el('button', 'btn', () => t('Close')) as HTMLButtonElement;
    close.type = 'button'; close.addEventListener('click', () => dialog.close()); head.append(title, close);
    const body = el('div', 'plugin-dialog-body');
    body.append(el('p', '', () => t('This moves the skill and its resources to the Trash. Existing prepared messages will not change.')));
    const actions = el('div', 'pet-delete-actions');
    const cancel = el('button', 'btn btn-solid pet-delete-cancel', () => t('Cancel')) as HTMLButtonElement;
    cancel.type = 'button'; cancel.addEventListener('click', () => dialog.close());
    const remove = el('button', 'btn plugin-destructive pet-delete-confirm', () => t('Remove skill')) as HTMLButtonElement;
    remove.type = 'button'; remove.addEventListener('click', () => void (async () => {
      remove.disabled = true;
      try { if (await update(api.skillsRemove(skill.id))) dialog.close(); }
      finally { if (remove.isConnected) remove.disabled = false; }
    })());
    actions.append(cancel, remove); body.append(actions); dialog.append(head, body);
    dialog.addEventListener('click', event => { if (event.target === dialog && !remove.disabled) dialog.close(); });
    dialog.addEventListener('close', () => dialog.remove()); document.body.append(dialog); dialog.showModal(); cancel.focus();
  };

  $('skillsSearch').addEventListener('input', render);
  const refresh = (force: boolean): void => {
    void (async () => { if (await update(api.listManagedSkills())) await checkUpdates(force); })();
  };
  $('skillsRefresh').addEventListener('click', () => refresh(true));
  for (const [id, kind] of [['skillsImportFolder', 'folder'], ['skillsImportFile', 'file']] as const) {
    $(id).addEventListener('click', () => void (async () => {
      const button = $<HTMLButtonElement>(id); button.disabled = true;
      try {
        const imported = await update(api.skillsImport(kind));
        if (imported) toast(t('Skill imported into the CoS library'));
      } finally { if (button.isConnected) button.disabled = false; }
    })());
  }
  const githubDialog = $<HTMLDialogElement>('skillGithubDialog');
  const githubInput = $<HTMLInputElement>('skillGithubUrl');
  const githubError = $('skillGithubError');
  const githubSubmit = $<HTMLButtonElement>('skillGithubSubmit');
  const githubClose = $<HTMLButtonElement>('skillGithubClose');
  const githubCancel = $<HTMLButtonElement>('skillGithubCancel');
  const openGithubDialog = (target: ManagedSkill | null): void => {
    linkTarget = target;
    ui($('skillGithubTitle'), 'textContent', () => t(target ? 'Link {0} to GitHub' : 'Import from GitHub', target ? [target.name] : []));
    ui($('skillGithubDescription'), 'textContent', () => t(target
      ? 'Link only if the local SKILL.md matches the GitHub file. Your files stay in place; missing or changed resources will show as an available update.'
      : 'Paste a public GitHub folder link or a link to its SKILL.md. The complete skill folder will be copied to your CoS library.'));
    ui(githubSubmit, 'textContent', () => t(target ? 'Link source' : 'Import skill'));
    $('skillsImportGithub').closest('details')?.removeAttribute('open');
    githubError.hidden = true; githubError.textContent = '';
    githubDialog.showModal(); githubInput.focus();
  };
  $('skillsImportGithub').addEventListener('click', () => openGithubDialog(null));
  githubClose.addEventListener('click', () => githubDialog.close());
  githubCancel.addEventListener('click', () => githubDialog.close());
  githubDialog.addEventListener('click', event => { if (event.target === githubDialog && !githubSubmit.disabled) githubDialog.close(); });
  githubDialog.addEventListener('cancel', event => { if (githubSubmit.disabled) event.preventDefault(); });
  $('skillGithubForm').addEventListener('submit', event => void (async () => {
    event.preventDefault();
    githubSubmit.disabled = githubClose.disabled = githubCancel.disabled = true;
    githubDialog.setAttribute('aria-busy', 'true');
    const target = linkTarget;
    ui(githubSubmit, 'textContent', () => t(target ? 'Linking…' : 'Importing…'));
    githubError.hidden = true;
    const own = ++epoch;
    const previous = new Set(skills.map(skill => skill.id));
    try {
      const result = target
        ? await api.skillsLinkGithub(target.id, githubInput.value.trim())
        : await api.skillsImportGithub(githubInput.value.trim());
      if (!result.ok) { githubError.textContent = result.error; githubError.hidden = false; return; }
      if (own === epoch) {
        setSkills(result.data);
        for (const skill of skills) {
          if (!previous.has(skill.id) && skill.origin) {
            checks.set(skill.id, { id: skill.id, originRevision: skill.origin.revision, state: 'current', checkedAt: Date.now() });
            paintSource(skill);
          }
        }
      }
      else await update(api.listManagedSkills());
      githubDialog.close(); githubInput.value = '';
      toast(t(target ? 'GitHub source linked' : 'Skill imported from GitHub'));
      if (target) {
        if (checkPass) await checkPass;
        await checkUpdates(true);
      }
    } catch {
      githubError.textContent = t('Could not reach GitHub. Try again.'); githubError.hidden = false;
    } finally {
      githubSubmit.disabled = githubClose.disabled = githubCancel.disabled = false;
      githubDialog.removeAttribute('aria-busy');
      ui(githubSubmit, 'textContent', () => t(linkTarget ? 'Link source' : 'Import skill'));
    }
  })());
  void update(api.listManagedSkills());
  return () => refresh(false);
}
