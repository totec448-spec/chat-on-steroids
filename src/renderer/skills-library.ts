import type { AppApi } from '../preload/index.js';
import { parseGitHubSkillUrl, type GitHubSkillUpdateCheck, type GlobalSkill, type ManagedSkill } from '../shared/skills.js';
import { $, el, icon, initCardMenuDismissal, run, toast } from './dom.js';
import { t, tn, ui } from './i18n.js';

/** The global Skills manager: imported packages and user-installed Skills from discovery. */
export function initSkillsLibrary(api: AppApi): () => void {
  initCardMenuDismissal();
  type SkillCard = ManagedSkill & Partial<Pick<GlobalSkill, 'managed' | 'source' | 'canRemove'>>;
  let skills: SkillCard[] = [];
  let statusFilter: 'all' | 'enabled' | 'disabled' = 'all';
  let epoch = 0;
  // Until a list arrives the header says Loading…; a failed first load says so instead of loading for good.
  let loaded = false;
  // The first load failed and no list arrived since: the list says so, also when the search repaints it.
  let loadFailed = false;
  const checks = new Map<string, GitHubSkillUpdateCheck>();
  const checking = new Set<string>();
  let linkTarget: ManagedSkill | null = null;
  const checkAgeMs = 15 * 60_000;
  let checkPass: Promise<void> | null = null;
  const installedRevision = (skill: ManagedSkill): string =>
    skill.origin ? `${skill.origin.ref} @ ${skill.origin.commit.slice(0, 12)}` : '';

  const paintSource = (skill: SkillCard): void => {
    const source = document.querySelector<HTMLElement>(`[data-skill-id="${skill.id}"] .skill-library-source`);
    if (!source) return;
    if (!skill.origin) {
      source.className = 'skill-library-source is-local';
      source.replaceChildren(el('i', 'ico ph ph-squares-four'), el('span', '', () => t('Local skill')));
      if (skill.managed === false) source.title = skill.path;
      else ui(source, 'title', () => t('Link a GitHub source from the card menu to check for updates.'));
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
    const revision = installedRevision(skill);
    source.title = check?.error
      ? `${skill.origin.url}\n${revision}\n${check.error}`
      : `${skill.origin.url}\n${revision}`;
  };

  let recommended: Array<{ id: string; name: string; description: string }> = [];
  const renderRecommended = (): void => {
    const section = document.getElementById('skillsRecommendedSection');
    if (!section) return;
    const installed = new Set(skills.map(skill => skill.id));
    const query = $<HTMLInputElement>('skillsSearch').value.trim().toLocaleLowerCase();
    const available = recommended.filter(entry => !installed.has(entry.id) &&
      `${entry.id} ${entry.name} ${entry.description} ${t(entry.description)}`.toLocaleLowerCase().includes(query));
    section.hidden = available.length === 0 || statusFilter !== 'all';
    ui($('skillsRecommendedCount'), 'textContent', () => tn('{0} skill', '{0} skills', available.length));
    const host = $('skillsRecommended');
    host.replaceChildren();
    for (const entry of available) {
      const card = el('article', 'plugin-card pet-library-card skill-library-card');
      card.dataset.recommendedSkillId = entry.id;
      const body = el('div', 'plugin-entry pet-library-entry');
      const artwork = el('div', 'skill-library-icon'); artwork.append(el('i', 'ico ph ph-squares-four'));
      const title = el('div', 'plugin-card-title');
      title.append(el('h2', '', entry.name), el('p', 'muted', () => t(entry.description)));
      const foot = el('div', 'plugin-card-foot');
      foot.append(el('span', 'skill-library-id', `/${entry.id}`));
      const install = el('button', 'btn skill-recommended-install', () => t('Install')) as HTMLButtonElement;
      install.type = 'button';
      install.addEventListener('click', () => void (async () => {
        install.disabled = true;
        try { if (await update(api.installRecommendedSkill(entry.id))) toast(t('Skill added to your library')); }
        finally { if (install.isConnected) install.disabled = false; }
      })());
      foot.append(install);
      title.append(foot);
      body.append(artwork, title);
      card.append(body);
      host.append(card);
    }
  };

  const render = (): void => {
    renderRecommended();
    const host = $('skillsInstalled');
    const enabledCount = skills.filter(skill => skill.enabled !== false).length;
    const counts: Array<[string, number]> = [
      ['skillsTotalStat', skills.length], ['skillsEnabledStat', enabledCount], ['skillsConfigurableStat', 0]
    ];
    for (const [id, count] of counts) {
      const node = document.getElementById(id);
      if (node) node.textContent = loadFailed ? '—' : String(count);
    }
    const emptyState = document.getElementById('skillsEmpty');
    if (emptyState) emptyState.hidden = !loaded || loadFailed || skills.length !== 0;
    const toolbar = document.getElementById('skillsToolbar');
    if (toolbar) toolbar.hidden = !loadFailed && skills.length === 0;
    if (loadFailed) {
      ui($('skillsCount'), 'textContent', () => '');
      host.replaceChildren(el('p', 'plugin-no-results muted', () => t('Skills could not be loaded.')));
      return;
    }
    const query = $<HTMLInputElement>('skillsSearch').value.trim().toLocaleLowerCase();
    const visible = skills.filter(skill =>
      (statusFilter === 'all' || (skill.enabled !== false) === (statusFilter === 'enabled')) &&
      `${skill.id} ${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query));
    ui($('skillsCount'), 'textContent', () => tn('{0} skill', '{0} skills', skills.length));
    host.replaceChildren();
    if (!visible.length) {
      const empty = skills.length
        ? statusFilter === 'all' || query ? t('No skills match your search.')
          : t(statusFilter === 'disabled' ? 'No disabled skills.' : 'No enabled skills.')
        : t('No skills installed yet. Import a folder, SKILL.md, or GitHub link to get started.');
      if (skills.length || !emptyState) host.append(el('p', 'plugin-no-results muted', empty));
      return;
    }
    for (const skill of visible) {
      const card = el('article', 'plugin-card skill-library-card');
      card.dataset.skillId = skill.id;
      card.title = `/${skill.id}`;
      const enabled = skill.enabled !== false;
      card.classList.toggle('is-disabled', !enabled);
      const entry = el('header', 'skill-library-card-head');
      const artwork = el('div', 'skill-library-icon'); artwork.append(el('i', 'ico ph ph-squares-four'));
      const title = el('div', 'skill-library-copy');
      const titleRow = el('div', 'skill-library-title-row');
      titleRow.append(el('h2', '', skill.name), el('span', 'skill-library-scope', () => t('GLOBAL')));
      const state = el('span', `skill-library-status${enabled ? ' is-enabled' : ''}`, () => t(enabled ? 'Enabled' : 'Disabled'));
      title.append(titleRow, el('p', 'muted', skill.description || t('Reusable instructions for this workspace.')));
      entry.append(artwork, title);
      const stateRow = el('div', 'skill-library-status-row'); stateRow.append(state);
      const controls = el('footer', 'skill-library-controls');
      const source = el('span', 'skill-library-source');
      source.setAttribute('aria-live', 'polite');
      controls.append(source);
      const actionsRow = el('div', 'skill-library-control-actions');
      const remove = el('button', 'skill-library-remove plugin-destructive') as HTMLButtonElement;
      remove.type = 'button';
      if (skill.managed !== false) {
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
        menu.append(summary, actions); actionsRow.append(menu);
      }
      if (skill.canRemove === false) {
        remove.disabled = true;
        remove.title = t('This Skill is managed by another provider.');
      } else remove.addEventListener('click', () => confirmRemove(skill));
      remove.append(icon('i-trash'));
      ui(remove, 'aria-label', () => t('Remove {0}', [skill.name]));
      actionsRow.append(remove);
      const toggle = el('label', 'skill-library-switch');
      const toggleText = el('span', '', () => t(enabled ? 'On' : 'Off'));
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = enabled;
      input.setAttribute('role', 'switch');
      ui(input, 'aria-label', () => t('Enable {0}', [skill.name]));
      input.addEventListener('change', () => void (async () => {
        input.disabled = true;
        try {
          if (await update(api.skillsSetEnabled(skill.id, input.checked), false, true)) {
            document.querySelector<HTMLInputElement>(`[data-skill-id="${skill.id}"] .skill-library-switch input`)?.focus();
          } else if (input.isConnected) input.checked = enabled;
        } finally { if (input.isConnected) input.disabled = false; }
      })());
      toggle.append(toggleText, input); actionsRow.append(toggle);
      controls.append(actionsRow); card.append(entry, stateRow, controls); host.append(card);
      paintSource(skill);
    }
  };

  const setSkills = (next: SkillCard[]): void => {
    skills = next; loaded = true; loadFailed = false;
    for (const [id, check] of checks) {
      if (skills.find(skill => skill.id === id)?.origin?.revision !== check.originRevision) checks.delete(id);
    }
    for (const id of checking) if (!skills.find(skill => skill.id === id)?.origin) checking.delete(id);
    render();
  };

  /**
   * Applies the newest request's list. While no list has arrived yet, the newest request ending without one
   * decides what the page shows: a failed load says so, and a change that ended without a list (a cancelled
   * import) loads again rather than leaving "Loading…" for good. An older request says nothing (CodeRabbit on #2002).
   */
  const update = async (request: Promise<{ ok: true; data: SkillCard[] | null } | { ok: false; error: string }>, load = false, alreadyGlobal = false): Promise<boolean> => {
    const own = ++epoch;
    const next = await run(request);
    if (own !== epoch) return false;
    if (next) {
      let current = next;
      if (!alreadyGlobal && typeof api.listGlobalSkills === 'function') {
        const refreshed = await run(api.listGlobalSkills());
        if (own !== epoch) return false;
        if (refreshed) current = refreshed;
      }
      setSkills(current);
      return true;
    }
    if (!loaded) { if (load) { loadFailed = true; render(); } else void loadList(); }
    return false;
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
    body.append(el('p', 'skill-source-revision', installedRevision(skill)));
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
          // GitHub updates return only managed Skills. Keep the complete global catalog
          // (including discovered user/project Skills) visible after the update.
          const refreshed = typeof api.listGlobalSkills === 'function' ? await run(api.listGlobalSkills()) : null;
          if (own !== epoch) return;
          checking.delete(skill.id);
          setSkills(refreshed ?? (typeof api.listGlobalSkills === 'function'
            ? skills.map(current => {
              const updated = result.skills.find(item => item.id === current.id);
              return updated ? { ...current, ...updated } : current;
            }) : result.skills));
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

  const confirmRemove = (skill: SkillCard): void => {
    document.querySelector('#skillRemoveDialog')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'skillRemoveDialog'; dialog.className = 'plugin-dialog pet-delete-dialog';
    const head = el('div', 'plugin-dialog-head');
    const title = el('h2', '', () => t('Remove {0}?', [skill.name]));
    title.id = 'skillRemoveTitle'; dialog.setAttribute('aria-labelledby', title.id);
    const close = el('button', 'btn', () => t('Close')) as HTMLButtonElement;
    close.type = 'button'; close.addEventListener('click', () => dialog.close()); head.append(title, close);
    const body = el('div', 'plugin-dialog-body');
    body.append(el('p', '', () => t("Move this Skill and all files in its folder to your operating system's Trash? Existing prepared messages will not change.")));
    if (skill.managed === false) body.append(el('p', 'muted', () => t('Other apps using this shared Skill folder will lose access to it too.')));
    const actions = el('div', 'pet-delete-actions');
    const cancel = el('button', 'btn btn-solid pet-delete-cancel', () => t('Cancel')) as HTMLButtonElement;
    cancel.type = 'button'; cancel.addEventListener('click', () => dialog.close());
    const remove = el('button', 'btn plugin-destructive pet-delete-confirm', () => t('Move to Trash')) as HTMLButtonElement;
    remove.type = 'button'; remove.addEventListener('click', () => void (async () => {
      remove.disabled = true;
      try { if (await update(api.skillsRemove(skill.id))) dialog.close(); }
      catch { toast(t('Could not move Skill to Trash. Try again.')); }
      finally { if (remove.isConnected) remove.disabled = false; }
    })());
    actions.append(cancel, remove); body.append(actions); dialog.append(head, body);
    dialog.addEventListener('click', event => { if (event.target === dialog && !remove.disabled) dialog.close(); });
    dialog.addEventListener('close', () => dialog.remove()); document.body.append(dialog); dialog.showModal(); cancel.focus();
  };

  $('skillsSearch').addEventListener('input', render);
  for (const filter of document.querySelectorAll<HTMLButtonElement>('[data-skills-filter]')) {
    filter.addEventListener('click', () => {
      const value = filter.dataset.skillsFilter;
      if (value !== 'all' && value !== 'enabled' && value !== 'disabled') return;
      statusFilter = value;
      for (const button of document.querySelectorAll<HTMLButtonElement>('[data-skills-filter]')) {
        button.setAttribute('aria-pressed', String(button === filter));
      }
      render();
    });
  }
  const loadList = (): Promise<boolean> => typeof api.listGlobalSkills === 'function'
    ? update(api.listGlobalSkills(), true, true) : update(api.listManagedSkills(), true);
  const refresh = (force: boolean): void => {
    void (async () => { if (await loadList()) await checkUpdates(force); })();
  };
  $('skillsRefresh').addEventListener('click', () => refresh(true));
  for (const [id, kind] of [['skillsImportFolder', 'folder'], ['skillsImportFile', 'file']] as const) {
    $(id).addEventListener('click', () => void (async () => {
      const button = $<HTMLButtonElement>(id); button.disabled = true;
      try {
        const imported = await update(api.skillsImport(kind));
        if (imported) toast(t('Skill added to your library'));
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
  document.getElementById('skillsEmptyAdd')?.addEventListener('click', () => openGithubDialog(null));
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
      if (!result.ok) { githubError.textContent = t(result.error); githubError.hidden = false; return; }
      if (own === epoch) {
        const refreshed = typeof api.listGlobalSkills === 'function' ? await run(api.listGlobalSkills()) : null;
        if (own !== epoch) return;
        setSkills(refreshed ?? result.data);
        for (const skill of skills) {
          if (!previous.has(skill.id) && skill.origin) {
            checks.set(skill.id, { id: skill.id, originRevision: skill.origin.revision, state: 'current', checkedAt: Date.now() });
            paintSource(skill);
          }
        }
      }
      else await loadList();
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
  void loadList();
  if (typeof api.listRecommendedSkills === 'function') void run(api.listRecommendedSkills()).then(list => { if (list) { recommended = list; renderRecommended(); } });
  return () => refresh(false);
}
