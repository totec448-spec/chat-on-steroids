import type { LibrarySkill, SkillLibrary, SkillsDraftScope } from '../shared/skills.js';
import { el, icon } from './dom.js';
import { t, ui } from './i18n.js';
import { skillDirectives } from '../shared/skill-invocation.js';

/** Completion is limited to the leading command block and a collapsed caret. */
export function skillCompletion(text: string, start: number, end = start): { start: number; end: number; query: string } | null {
  if (start !== end || /\S/.test(text.slice(end).split(/\s/, 1)[0] ?? '')) return null;
  const before = text.slice(0, start);
  const match = /(?:^|\s)(\/(?:prompt(?:\s+[a-z0-9._-]*)?|[a-z0-9._-]*))$/i.exec(before);
  if (!match) return null;
  const at = start - match[1]!.length;
  const preceding = text.slice(0, at).trim();
  if (preceding && !/^(?:\/(?!prompt(?:\s|$))[a-z0-9._-]+|\/prompt\s+[a-z0-9._-]+)(?:\s+(?:\/(?!prompt(?:\s|$))[a-z0-9._-]+|\/prompt\s+[a-z0-9._-]+))*$/i.test(preceding)) return null;
  const token = match[1]!;
  return { start: at, end, query: token === '/prompt' ? '' : token.replace(/^\/prompt\s+|^\//, '').toLowerCase() };
}

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };
type Options = {
  input: HTMLTextAreaElement; host: HTMLElement; selectedHost: HTMLElement;
  openButton: HTMLElement; addButton: HTMLElement;
  owner: () => string;
  scope: () => SkillsDraftScope;
  draft: () => string | undefined;
  saveDraft: (authored: string) => void;
  list: (scope: SkillsDraftScope) => Promise<Reply<SkillLibrary>>;
  command?: (name: string) => void;
};

function split(text: string): ReturnType<typeof skillDirectives> {
  try { return skillDirectives(text); }
  catch { return { ids: [], prefix: '', body: text }; } // Incomplete typed commands remain visible.
}
const title = (skill: LibrarySkill): string => skill.displayName || skill.name;
const scopeLabel = (skill: LibrarySkill): string => skill.scope === 'repo' ? t('Project')
  : skill.scope === 'system' ? t('System') : skill.scope === 'admin' ? t('Admin') : t('Personal');

/** PR #260's library/chips are projections of the existing authored draft, not a second selection ledger. */
export function initSkills(options: Options) {
  const { input, host, selectedHost } = options;
  const control = (label: string, className = 'btn'): HTMLButtonElement => {
    const node = el('button', className, () => t(label)) as HTMLButtonElement; node.type = 'button'; return node;
  };
  host.className = 'skill-autocomplete'; host.setAttribute('role', 'listbox');
  const cache = new Map<string, SkillLibrary>();
  let epoch = 0, surfaceOwner = '', loadedKey: string | null = null, loading = false, error = '', composing = false;
  let library: SkillLibrary | null = null, choices: Array<LibrarySkill | { command: string; name: string; description: string; glyph: string }> = [], selected = 0, painted = '';
  // This is only the current textarea projection. The existing draft map holds the
  // complete authored command block across navigation, failures and retries.
  let displayedPrefix = '', prefixOwner = options.owner();
  const scopeKey = (): string => JSON.stringify(options.scope());
  const selectionKey = (): string => `${input.value}\0${input.selectionStart}\0${input.selectionEnd}`;
  const authoredText = (): string => (prefixOwner === options.owner() ? displayedPrefix : '') + input.value;
  const fragment = () => skillCompletion(input.value, input.selectionStart, input.selectionEnd);
  const current = (): boolean => surfaceOwner === options.owner();
  const hideInline = (): void => {
    host.hidden = true; choices = []; input.removeAttribute('aria-controls'); input.removeAttribute('aria-expanded'); input.removeAttribute('aria-activedescendant');
  };
  const close = (): void => {
    epoch++; loading = false; loadedKey = null; hideInline();
    if (prefixOwner !== options.owner()) { selectedHost.replaceChildren(); selectedHost.hidden = true; }
  };
  const renderSelected = (): void => {
    selectedHost.replaceChildren();
    const ids = split(prefixOwner === options.owner() ? displayedPrefix : '').ids;
    selectedHost.hidden = !ids.length;
    const catalog = cache.get(scopeKey());
    for (const id of ids) {
      const skill = catalog?.skills.find(row => row.id === id);
      const name = skill ? title(skill) : id;
      const chip = el('div', 'composer-selected-skill'); chip.dataset.skillId = id;
      chip.title = skill?.path ?? `/${id}`;
      const remove = control('Remove', 'composer-selected-skill-remove'); remove.replaceChildren(icon('i-x'));
      ui(remove, 'aria-label', () => t('Remove {0}', [name]));
      const owner = options.owner();
      remove.addEventListener('click', () => {
        if (owner !== options.owner()) return;
        const retained = split(displayedPrefix).ids.filter(value => value !== id);
        project(`${retained.map(value => `/${value}\n`).join('')}${input.value}`);
        input.focus();
      });
      chip.append(icon('i-skill', 'ico composer-selected-skill-icon'), el('span', 'composer-selected-skill-title', name), remove);
      selectedHost.append(chip);
    }
  };
  const restore = (): void => {
    close();
    const draft = split(options.draft() ?? input.value);
    displayedPrefix = draft.prefix; prefixOwner = options.owner(); input.value = draft.body;
    renderSelected();
  };
  const project = (authored: string): void => {
    options.saveDraft(authored);
    const draft = split(authored); displayedPrefix = draft.prefix; prefixOwner = options.owner(); input.value = draft.body;
    renderSelected(); input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new input.ownerDocument.defaultView!.Event('input', { bubbles: true }));
  };
  const choose = (skill: typeof choices[number]): void => {
    if ('command' in skill) {
      const range = fragment();
      if (!current() || !range || painted !== selectionKey() || composing) { close(); return; }
      const text = range ? input.value.slice(0, range.start) + input.value.slice(range.end) : input.value;
      const authored = (prefixOwner === options.owner() ? displayedPrefix : '') + text;
      close(); project(authored); options.command?.(skill.command); input.focus(); return;
    }
    if (!current() || composing) { close(); return; }
    const range = fragment();
    if (!range || painted !== selectionKey()) { close(); return; }
    const text = range ? input.value.slice(0, range.start) + input.value.slice(range.end).replace(/^\s+/, '') : input.value;
    const draft = split((prefixOwner === options.owner() ? displayedPrefix : '') + text);
    const prefix = draft.ids.includes(skill.id) ? draft.prefix
      : `${draft.prefix}${draft.prefix && !/\s$/.test(draft.prefix) ? '\n' : ''}/${skill.id}\n`;
    close(); project(prefix + draft.body); input.focus();
  };
  const filtered = (query: string): LibrarySkill[] => {
    const needle = query.trim().toLocaleLowerCase();
    return (library?.skills ?? []).filter(skill => `${skill.id} ${title(skill)} ${skill.description} ${skill.scope}`.toLocaleLowerCase().includes(needle));
  };
  const paintInline = (): void => {
    if (!current() || composing) { hideInline(); return; }
    const range = fragment();
    if (!range) { hideInline(); return; }
    const query = range?.query ?? '';
    const commands = options.command ? [
      { command: 'plan', name: 'Plan', description: 'Turn the next composer request into editable stages.', glyph: 'i-steps' },
      { command: 'goal', name: 'Goal', description: 'Pursue a saved objective and stop when it is complete.', glyph: 'i-target' },
      { command: 'loop', name: 'Loop', description: 'Keep continuing toward the saved objective.', glyph: 'i-loop' },
      { command: 'compact', name: 'Compact', description: 'Compact this chat and resume it in a fresh conversation.', glyph: 'i-copy' }
    ].filter(row => row.command.includes(query)) : [];
    choices = [...commands, ...(loading && !library ? [] : filtered(query).slice(0, 64))];
    selected = Math.min(selected, Math.max(0, choices.length - 1)); painted = selectionKey();
    const renderEpoch = epoch, renderOwner = options.owner(), renderSelection = selectionKey();
    const chooseCurrent = (choice: typeof choices[number]): void => {
      if (epoch === renderEpoch && options.owner() === renderOwner && selectionKey() === renderSelection) choose(choice);
    };
    host.replaceChildren(); host.hidden = false;
    input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', host.id);
    for (const [index, skill] of choices.entries()) {
      const command = 'command' in skill;
      if (index === 0 || (index === commands.length && !command)) host.append(el('div', 'slash-menu-section-title', () => t(command ? 'Commands' : 'Skills')));
      const row = control('', 'skill-choice skill-autocomplete-option slash-menu-option');
      row.replaceChildren(); row.id = `skill-option-${index}`; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === selected));
      if (!command) row.dataset.skillId = skill.id;
      row.title = command ? `/${skill.command}` : skill.path;
      const copy = el('span', 'slash-menu-copy'); copy.append(el('strong', '', command ? t(skill.name) : title(skill)), el('small', '', command ? t(skill.description) : skill.shortDescription ?? skill.description));
      row.append(icon(command ? skill.glyph : 'i-skill', 'ico slash-menu-icon'), copy, el('span', 'slash-menu-meta', () => command ? '' : scopeLabel(skill)));
      row.addEventListener('pointerdown', event => event.preventDefault()); row.addEventListener('click', () => chooseCurrent(skill)); host.append(row);
    }
    if (error) host.append(el('p', 'slash-menu-empty', error));
    if (choices.length) { input.setAttribute('aria-activedescendant', `skill-option-${selected}`); host.querySelector(`#skill-option-${selected}`)?.scrollIntoView?.({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  };
  const load = async (): Promise<void> => {
    const request = ++epoch, owner = options.owner(), scope = options.scope(), key = JSON.stringify(scope);
    surfaceOwner = owner; loadedKey = key; loading = true; error = ''; library = cache.get(key) ?? null;
    paintInline();
    try {
      const result = await options.list(scope);
      if (request !== epoch || owner !== options.owner() || scopeKey() !== key) return;
      if (!result.ok) error = result.error;
      else {
        library = result.data; cache.delete(key); cache.set(key, library);
        while (cache.size > 12) cache.delete(cache.keys().next().value!);
      }
    } catch (failure) { if (request === epoch && current()) error = failure instanceof Error ? failure.message : String(failure); }
    finally { if (request === epoch && current()) { loading = false; paintInline(); renderSelected(); } }
  };
  const update = (): void => {
    options.saveDraft(authoredText());
    if (composing) return;
    if (!fragment()) { hideInline(); loadedKey = null; return; }
    selected = 0;
    if (loadedKey !== scopeKey() || !current()) void load(); else paintInline();
  };
  input.addEventListener('compositionstart', () => { composing = true; hideInline(); });
  for (const [button, add] of [[options.openButton, false], [options.addButton, true]] as const) {
    button.addEventListener('click', event => {
      event.stopPropagation();
      const menu = button.closest('details'); if (menu) menu.open = false;
      if (add) {
        const range = fragment();
        const text = range ? input.value.slice(0, range.start) + input.value.slice(range.end) : input.value;
        close();
        project((prefixOwner === options.owner() ? displayedPrefix : '') + `Please add the following skills to my COS skills:\n${text}`);
      } else {
        input.setRangeText(input.value ? '/\n' : '/', 0, 0, 'start');
        input.setSelectionRange(1, 1);
        input.dispatchEvent(new input.ownerDocument.defaultView!.Event('input', { bubbles: true }));
      }
      input.focus();
    });
  }
  input.addEventListener('compositionend', () => { composing = false; update(); });
  input.addEventListener('input', event => { if ((event as InputEvent).isComposing) { hideInline(); return; } update(); });
  input.addEventListener('click', () => { if (!host.hidden) paintInline(); });
  document.addEventListener('click', event => {
    if (!host.contains(event.target as Node) && event.target !== input) hideInline();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing && !host.hidden) { hideInline(); input.focus(); }
  });
  return { close, restore, authoredText, keydown: (event: KeyboardEvent): boolean => {
    if (host.hidden || !current() || composing || event.isComposing) return false;
    if (!fragment() || painted !== selectionKey()) { hideInline(); return false; }
    if (event.key === 'Escape') { hideInline(); event.preventDefault(); return true; }
    if (!choices.length || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      selected = (selected + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length; paintInline();
    } else if (event.key === 'Enter' || event.key === 'Tab') choose(choices[selected]!);
    else return false;
    event.preventDefault(); return true;
  } };
}
