import { t, ui } from './i18n.js';
import { $, el, run } from './dom.js';
import type { SkillLibrary, SkillSummary } from '../shared/skills.js';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

export interface SkillsRendererApi {
  skillsList: () => Promise<Reply<SkillLibrary>>;
  skillsImport: () => Promise<Reply<SkillLibrary | null>>;
  skillsOpenFolder: () => Promise<Reply<void>>;
  skillsRemove: (id: string) => Promise<Reply<SkillLibrary>>;
}

export interface SkillCommandTrigger {
  lineStart: number;
  lineEnd: number;
  kind: 'prompt' | 'slash';
  query: string;
}

export interface SkillsController {
  onInput: () => void;
  onKeydown: (event: KeyboardEvent) => boolean;
  syncDraft: () => void;
  open: () => void;
}

interface SkillsOptions {
  api: SkillsRendererApi;
  input: HTMLTextAreaElement;
  getDraftIdentity: () => string;
}

interface DialogState {
  epoch: number;
  identity: string;
  trigger: SkillCommandTrigger | null;
}

interface InlineState {
  epoch: number;
  identity: string;
  trigger: SkillCommandTrigger;
  matches: SkillSummary[];
  selected: number;
  loading: boolean;
}

function lineBounds(text: string, caret: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
  const next = text.indexOf('\n', caret);
  return { start, end: next < 0 ? text.length : next };
}

/**
 * Slash completion is deliberately limited to the initial command block. A prose,
 * quote, fence, blank separator or other non-command line ends that block.
 */
export function skillCommandTrigger(text: string, caret: number): SkillCommandTrigger | null {
  if (caret < 0 || caret > text.length) return null;
  const { start, end } = lineBounds(text, caret);
  const beforeLine = text.slice(0, start);
  if (beforeLine) {
    const prior = beforeLine.endsWith('\n') ? beforeLine.slice(0, -1) : beforeLine;
    if (prior.split('\n').some(line => !/^\/(?:prompt(?:[ \t]+\S+)?|[^\s/]+)[ \t]*$/.test(line))) return null;
  }
  const beforeCaret = text.slice(start, caret);
  const afterCaret = text.slice(caret, end);
  if (afterCaret.trim() || !/^\/[^\s/]*$/.test(beforeCaret)) return null;
  const query = beforeCaret.slice(1);
  return { lineStart: start, lineEnd: end, kind: query === 'prompt' ? 'prompt' : 'slash', query };
}

function currentTrigger(text: string, trigger: SkillCommandTrigger): SkillCommandTrigger | null {
  if (trigger.lineStart < 0 || trigger.lineStart > text.length) return null;
  const end = text.indexOf('\n', trigger.lineStart);
  const lineEnd = end < 0 ? text.length : end;
  const line = text.slice(trigger.lineStart, lineEnd);
  if (trigger.kind === 'prompt') {
    if (line.trim() !== '/prompt') return null;
    return { ...trigger, lineEnd, query: 'prompt' };
  }
  if (!/^\/[^\s/]*$/.test(line)) return null;
  return { ...trigger, lineEnd, query: line.slice(1) };
}

function removeTriggerLine(text: string, trigger: SkillCommandTrigger | null): string {
  if (!trigger) return text;
  const current = currentTrigger(text, trigger);
  if (!current) return text;
  let end = current.lineEnd;
  if (text[end] === '\n') end++;
  return text.slice(0, current.lineStart) + text.slice(end);
}

function leadingDirectiveBlock(text: string, knownIds: ReadonlySet<string>): { end: number; ids: Set<string> } {
  const ids = new Set<string>();
  let offset = 0;
  while (offset < text.length) {
    const next = text.indexOf('\n', offset);
    const lineEnd = next < 0 ? text.length : next;
    const line = text.slice(offset, lineEnd).replace(/\r$/, '');
    const prompt = /^\/prompt[ \t]+([^\s]+)[ \t]*$/.exec(line);
    const shorthand = /^\/([^\s/]+)[ \t]*$/.exec(line);
    const id = prompt?.[1] ?? (shorthand && knownIds.has(shorthand[1]!) ? shorthand[1] : undefined);
    if (!id) break;
    ids.add(id);
    offset = next < 0 ? lineEnd : next + 1;
  }
  return { end: offset, ids };
}

/** Pure insertion helper used by both the full picker and inline slash completion. */
export function insertSkillCommand(
  text: string,
  id: string,
  knownIds: Iterable<string>,
  trigger: SkillCommandTrigger | null = null
): { text: string; caret: number } {
  const known = new Set(knownIds);
  let next = removeTriggerLine(text, trigger);
  const block = leadingDirectiveBlock(next, known);
  if (block.ids.has(id)) return { text: next, caret: block.end };
  const command = `/${id}\n`;
  if (block.end === 0) return { text: command + next, caret: command.length };
  const separator = next[block.end - 1] === '\n' ? '' : '\n';
  const insertion = `${separator}${command}`;
  next = next.slice(0, block.end) + insertion + next.slice(block.end);
  return { text: next, caret: block.end + insertion.length };
}

function filtered(skills: SkillSummary[], query: string): SkillSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return skills;
  return skills.filter(skill => `${skill.id}\n${skill.name}\n${skill.description}`.toLocaleLowerCase().includes(needle));
}

export function createSkills(options: SkillsOptions): SkillsController {
  const { api, input, getDraftIdentity } = options;
  const dialog = $<HTMLDialogElement>('skillsDialog');
  const search = $<HTMLInputElement>('skillsSearch');
  const list = $('skillsList');
  const status = $('skillsStatus');
  const autocomplete = $('skillAutocomplete');
  let library: SkillLibrary | null = null;
  let libraryEpoch = 0;
  let dialogEpoch = 0;
  let inlineEpoch = 0;
  let dialogLoadFailed = false;
  let dialogState: DialogState | null = null;
  let inlineState: InlineState | null = null;

  const alive = (state: DialogState): boolean => dialogState?.epoch === state.epoch && dialog.open && state.identity === getDraftIdentity();

  const loadLibrary = async (): Promise<SkillLibrary | null> => {
    const epoch = ++libraryEpoch;
    const next = await run(api.skillsList());
    if (next && epoch === libraryEpoch) library = next;
    return next;
  };

  const knownIds = (): string[] => library?.skills.map(skill => skill.id) ?? [];

  const dispatchInput = (): void => { input.dispatchEvent(new window.Event('input', { bubbles: true })); };

  const apply = (skill: SkillSummary, identity: string, trigger: SkillCommandTrigger | null): boolean => {
    if (identity !== getDraftIdentity()) return false;
    const inserted = insertSkillCommand(input.value, skill.id, knownIds(), trigger);
    input.value = inserted.text;
    input.setSelectionRange(inserted.caret, inserted.caret);
    dispatchInput();
    input.focus();
    return true;
  };

  const hideInline = (): void => {
    inlineEpoch++;
    inlineState = null;
    autocomplete.hidden = true;
    autocomplete.replaceChildren();
    input.removeAttribute('aria-controls');
    input.removeAttribute('aria-activedescendant');
    input.removeAttribute('aria-expanded');
  };

  const liveInlineTrigger = (state: InlineState): SkillCommandTrigger | null => {
    if (state.identity !== getDraftIdentity()) return null;
    const current = skillCommandTrigger(input.value, input.selectionStart);
    return current?.kind === 'slash' && current.lineStart === state.trigger.lineStart ? current : null;
  };

  const renderInline = (state: InlineState): void => {
    if (inlineState?.epoch !== state.epoch || state.identity !== getDraftIdentity()) return;
    autocomplete.replaceChildren();
    input.setAttribute('aria-controls', 'skillAutocomplete');
    input.setAttribute('aria-expanded', 'true');
    if (state.loading) {
      autocomplete.append(el('p', 'skill-autocomplete-empty', () => t("Loading skills…")));
      autocomplete.hidden = false;
      input.removeAttribute('aria-activedescendant');
      return;
    }
    if (!state.matches.length) {
      const empty = el('p', 'skill-autocomplete-empty', () => library?.skills.length ? t("No skills match your search.") : t("No installed skills."));
      autocomplete.append(empty); autocomplete.hidden = false; input.removeAttribute('aria-activedescendant'); return;
    }
    state.selected = Math.min(Math.max(0, state.selected), state.matches.length - 1);
    state.matches.forEach((skill, index) => {
      const row = el('button', 'skill-autocomplete-option') as HTMLButtonElement;
      row.type = 'button'; row.id = `skillAutocompleteOption-${index}`; row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === state.selected));
      const copy = el('span', 'skill-autocomplete-copy');
      copy.append(el('strong', '', `/${skill.id}`), el('span', '', skill.name), el('small', '', skill.description));
      row.append(copy);
      row.addEventListener('pointerdown', event => event.preventDefault());
      row.addEventListener('click', () => {
        const trigger = liveInlineTrigger(state);
        if (!trigger) { hideInline(); return; }
        if (apply(skill, state.identity, trigger)) hideInline();
      });
      autocomplete.append(row);
    });
    autocomplete.hidden = false;
    input.setAttribute('aria-activedescendant', `skillAutocompleteOption-${state.selected}`);
  };

  const renderDialog = (state: DialogState): void => {
    if (!alive(state)) return;
    const skills = filtered(library?.skills ?? [], search.value);
    list.replaceChildren();
    status.textContent = '';
    if (library?.directory) ui(status, 'title', () => t("Skill directory: {0}", [library!.directory]));
    if (!library) {
      if (dialogLoadFailed) {
        const failure = el('div', 'skills-empty skills-load-error');
        const retry = el('button', 'btn', () => t("Retry")) as HTMLButtonElement;
        retry.type = 'button';
        retry.addEventListener('click', () => void loadDialog(state));
        failure.append(
          el('strong', '', () => t("Skills could not be loaded.")),
          el('span', '', () => t("Check the error above, then try again.")),
          retry
        );
        list.append(failure);
      } else list.append(el('p', 'skills-empty', () => t("Loading skills…")));
      return;
    }
    if (library.errors.length) {
      const errors = el('div', 'skills-errors'); errors.setAttribute('role', 'status');
      errors.append(el('strong', '', () => t("Some skill files could not be loaded.")));
      for (const error of library.errors) errors.append(el('div', '', error));
      list.append(errors);
    }
    if (!skills.length) {
      const empty = el('div', 'skills-empty');
      empty.append(
        el('strong', '', () => search.value.trim() ? t("No skills match your search.") : t("No skills yet.")),
        el('span', '', () => search.value.trim() ? t("Try another name or description.") : t("Import a text skill file to add one."))
      );
      list.append(empty); return;
    }
    for (const skill of skills) {
      const row = el('article', 'skill-row'); row.dataset.skillId = skill.id;
      const copy = el('div', 'skill-row-copy');
      const heading = el('div', 'skill-row-heading'); heading.append(el('strong', '', skill.name), el('code', '', `/${skill.id}`));
      copy.append(heading, el('p', '', skill.description));
      const actions = el('div', 'skill-row-actions');
      const remove = el('button', 'btn skill-remove', () => t("Remove")) as HTMLButtonElement;
      remove.type = 'button'; ui(remove, 'aria-label', () => t("Remove {0}", [skill.name]));
      remove.addEventListener('click', async () => {
        const owner = dialogState;
        if (!owner || !alive(owner)) return;
        remove.disabled = true;
        const next = await run(api.skillsRemove(skill.id));
        if (next) publishLibrary(next);
        if (!alive(owner)) return;
        if (!next) remove.disabled = false;
      });
      const use = el('button', 'btn btn-solid skill-use', () => t("Use")) as HTMLButtonElement;
      use.type = 'button'; ui(use, 'aria-label', () => t("Use {0}", [skill.name]));
      use.addEventListener('click', () => {
        const owner = dialogState;
        if (!owner || !alive(owner)) return;
        if (apply(skill, owner.identity, owner.trigger)) dialog.close();
      });
      actions.append(remove, use); row.append(copy, actions); list.append(row);
    }
  };

  const publishLibrary = (next: SkillLibrary): void => {
    ++libraryEpoch;
    dialogLoadFailed = false;
    library = next;
    const current = dialogState;
    if (current && alive(current)) renderDialog(current);
  };

  const openDialog = (trigger: SkillCommandTrigger | null = null): void => {
    hideInline();
    const state: DialogState = { epoch: ++dialogEpoch, identity: getDraftIdentity(), trigger };
    dialogState = state;
    search.value = '';
    library = null;
    dialogLoadFailed = false;
    $<HTMLButtonElement>('skillsImport').disabled = false;
    $<HTMLButtonElement>('skillsOpenFolder').disabled = false;
    list.replaceChildren(el('p', 'skills-empty', () => t("Loading skills…")));
    if (!dialog.open) dialog.showModal();
    search.focus();
    void loadDialog(state);
  };

  const loadDialog = async (state: DialogState): Promise<void> => {
    if (!alive(state)) return;
    dialogLoadFailed = false;
    library = null;
    renderDialog(state);
    const next = await loadLibrary();
    if (!alive(state)) { if (dialogState?.epoch === state.epoch && dialog.open) dialog.close(); return; }
    if (next) { dialogLoadFailed = false; renderDialog(state); return; }
    dialogLoadFailed = true;
    renderDialog(state);
  };

  const refreshInline = (trigger: SkillCommandTrigger): void => {
    if (dialog.open) return;
    const identity = getDraftIdentity();
    const state: InlineState = { epoch: ++inlineEpoch, identity, trigger, matches: [], selected: 0, loading: true };
    inlineState = state;
    renderInline(state);
    void loadLibrary().then(next => {
      if (inlineState?.epoch !== state.epoch || identity !== getDraftIdentity()) return;
      if (!next) { hideInline(); return; }
      const current = skillCommandTrigger(input.value, input.selectionStart);
      if (!current || current.kind !== 'slash' || current.lineStart !== trigger.lineStart) { hideInline(); return; }
      state.trigger = current;
      state.matches = filtered(next.skills, current.query);
      state.loading = false;
      renderInline(state);
    });
  };

  const onInput = (): void => {
    if (dialog.open) return;
    const trigger = skillCommandTrigger(input.value, input.selectionStart);
    if (!trigger) { hideInline(); return; }
    if (trigger.kind === 'prompt') { openDialog(trigger); return; }
    const active = inlineState;
    if (active && !autocomplete.hidden && active.identity === getDraftIdentity() && active.trigger.lineStart === trigger.lineStart) {
      active.trigger = trigger;
      active.selected = 0;
      if (!active.loading && library) active.matches = filtered(library.skills, trigger.query);
      renderInline(active);
      return;
    }
    refreshInline(trigger);
  };

  const onKeydown = (event: KeyboardEvent): boolean => {
    if (event.isComposing) return false;
    const trigger = skillCommandTrigger(input.value, input.selectionStart);
    if (trigger?.kind === 'prompt' && ['Enter', 'Tab'].includes(event.key)) {
      event.preventDefault(); openDialog(trigger); return true;
    }
    const state = inlineState;
    if (!state || autocomplete.hidden) return false;
    if (event.key === 'Escape') { event.preventDefault(); hideInline(); return true; }
    const current = liveInlineTrigger(state);
    if (!current) { hideInline(); return false; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (state.matches.length) {
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        state.selected = (state.selected + delta + state.matches.length) % state.matches.length;
        renderInline(state);
      }
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const skill = state.matches[state.selected];
      if (skill && apply(skill, state.identity, current)) hideInline();
      return true;
    }
    return false;
  };

  $('composerSkills').addEventListener('click', () => openDialog());
  $('skillsClose').addEventListener('click', () => dialog.close());
  search.addEventListener('input', () => { if (dialogState) renderDialog(dialogState); });
  search.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'Enter') {
      const first = list.querySelector<HTMLButtonElement>('.skill-use');
      if (first) { event.preventDefault(); first.focus(); }
    }
  });
  list.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const uses = [...list.querySelectorAll<HTMLButtonElement>('.skill-use')];
    const current = uses.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0 || !uses.length) return;
    event.preventDefault(); uses[(current + (event.key === 'ArrowDown' ? 1 : -1) + uses.length) % uses.length]!.focus();
  });
  $('skillsImport').addEventListener('click', async () => {
    const state = dialogState; if (!state || !alive(state)) return;
    const button = $<HTMLButtonElement>('skillsImport'); button.disabled = true;
    try {
      const next = await run(api.skillsImport());
      if (next) publishLibrary(next);
      if (!alive(state)) return;
    } finally { if (alive(state)) button.disabled = false; }
  });
  $('skillsOpenFolder').addEventListener('click', async () => {
    const state = dialogState; if (!state || !alive(state)) return;
    const button = $<HTMLButtonElement>('skillsOpenFolder'); button.disabled = true;
    try { await run(api.skillsOpenFolder()); }
    finally { if (alive(state)) button.disabled = false; }
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    const state = dialogState; dialogEpoch++; dialogState = null;
    if (state?.identity === getDraftIdentity()) input.focus();
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); dialog.close(); }
  });

  return {
    open: () => openDialog(),
    onInput,
    onKeydown,
    syncDraft: () => {
      hideInline();
      if (dialogState && dialogState.identity !== getDraftIdentity() && dialog.open) dialog.close();
    }
  };
}
