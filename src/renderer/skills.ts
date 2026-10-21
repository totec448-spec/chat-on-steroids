import type { LibrarySkill, SkillLibrary, SkillsDraftScope } from '../shared/skills.js';
import type { ProjectDirectoryListing, ProjectFileEntry } from '../shared/project-files.js';
import { el, icon } from './dom.js';
import { t, ui } from './i18n.js';
import { skillDirectives } from '../shared/skill-invocation.js';

type Completion = { start: number; end: number; query: string; kind: 'command' | 'skill' | 'file'; directory?: string };

function inCodeOrLink(text: string, position: number): boolean {
  const before = text.slice(0, position);
  const fences = [...before.matchAll(/^ {0,3}(`{3,}|~{3,})[^\n]*$/gm)];
  if (fences.length % 2) return true;
  const lastFence = fences.at(-1)?.index ?? -1;
  const local = before.slice(lastFence < 0 ? 0 : lastFence);
  const ticks = [...local.matchAll(/(?<!\\)`/g)].length;
  if (ticks % 2) return true;
  const openLink = before.lastIndexOf('](');
  if (openLink > before.lastIndexOf(')')) return true;
  return false;
}

/**
 * Index just past the last whitespace that no backslash escapes (a line break always counts). No
 * @ reference reaches back across it, and every @ after it that follows whitespace starts a valid
 * one, so the reference search below succeeds at its first candidate instead of rescanning the
 * text from every @: a pasted run of escaped spaces ("\\ @") made each keystroke quadratic, and
 * 200 KB of it froze the composer for 17 s.
 */
function referenceSearchStart(before: string): number {
  for (let at = before.length - 1; at >= 0; at--) {
    const char = before[at]!;
    if (/\s/.test(char) && (before[at - 1] !== '\\' || /[\r\n\u2028\u2029]/.test(char))) return at + 1;
  }
  return 0;
}

/** Returns a completion only for a collapsed caret in a safe slash or project-reference token. */
export function skillCompletion(text: string, start: number, end = start): Completion | null {
  if (start !== end || /\S/.test(text.slice(end).split(/\s/, 1)[0] ?? '')) return null;
  const before = text.slice(0, start);
  // The search starts just after whitespace, so ^ there stands for the \s it follows.
  const file = /(?:^|\s)(@(?:\\+[^\r\n\u2028\u2029\\]|[^\s\\])*\\*)$/i.exec(before.slice(referenceSearchStart(before)));
  if (file) {
    if (inCodeOrLink(text, start)) return null;
    const at = start - file[1]!.length;
    const token = file[1]!;
    const query = token.slice(1).replace(/\\(.)/g, '$1');
    if (/^[^/\s@]+@[^/\s@.]+\.[^/\s@]+$/.test(query) || query.startsWith('/') || query.split('/').some(part => part === '.' || part === '..')) return null;
    const slash = query.lastIndexOf('/');
    return { start: at, end, query: slash < 0 ? query.toLowerCase() : query.slice(slash + 1).toLowerCase(),
      kind: 'file', ...(slash >= 0 ? { directory: query.slice(0, slash) } : {}) };
  }
  const match = /(?:^|\s)(\/(?:prompt(?:\s+[a-z0-9._-]*)?|[a-z0-9._-]*))$/i.exec(before);
  if (!match) return null;
  if (inCodeOrLink(text, start)) return null;
  const at = start - match[1]!.length;
  // A slash after another slash, or a path segment followed by another slash, is path text.
  if (text[at - 1] === '/' || text[at - 1] === '\\' || text[start] === '/' || text[start] === '\\') return null;
  const preceding = text.slice(0, at).trim();
  const commandBlock = !preceding || /^(?:\/(?!prompt(?:\s|$))[a-z0-9._-]+|\/prompt\s+[a-z0-9._-]+)(?:\s+(?:\/(?!prompt(?:\s|$))[a-z0-9._-]+|\/prompt\s+[a-z0-9._-]+))*$/i.test(preceding);
  const token = match[1]!;
  return { start: at, end, query: token === '/prompt' ? '' : token.replace(/^\/prompt\s+|^\//, '').toLowerCase(),
    kind: commandBlock ? 'command' : 'skill' };
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
  listFiles: (projectId: string, directory: string) => Promise<ProjectDirectoryListing>;
  command?: (name: string) => void;
  commandAvailable?: (name: string) => boolean;
  deferCommand?: (name: string) => boolean;
};

/** Marks a textarea projection that consumed a composer control, not authored text. */
export const COMPOSER_COMMAND_PROJECTION = Symbol('composer-command-projection');

function split(text: string): ReturnType<typeof skillDirectives> {
  try { return skillDirectives(text); }
  catch { return { ids: [], prefix: '', body: text }; } // Incomplete typed commands remain visible.
}
const title = (skill: LibrarySkill): string => skill.displayName || skill.name;
const scopeLabel = (skill: LibrarySkill): string => skill.scope === 'repo' ? t('Project')
  : skill.scope === 'system' ? t('System') : skill.scope === 'admin' ? t('Admin') : t('Personal');

/** PR #260's library/chips are projections of the existing authored draft, not a second selection ledger. */
/** The app's own slash commands, offered in the composer menu and recognized when typed at the start of a message. */
export const APP_COMMANDS = [
  { command: 'plan', name: 'Plan', description: 'Turn the next composer request into editable stages.', glyph: 'i-steps' },
  { command: 'goal', name: 'Goal', description: 'Pursue a saved objective and stop when it is complete.', glyph: 'i-target' },
  { command: 'loop', name: 'Loop', description: 'Keep continuing toward the saved objective.', glyph: 'i-loop' },
  { command: 'compact', name: 'Compact', description: 'Compact this chat and resume it in a fresh conversation.', glyph: 'i-copy' },
  { command: 'image', name: 'Image', description: 'Ask ChatGPT for a picture: this message goes without the app, so ChatGPT can draw.', glyph: 'i-image' },
  // Codex's slash commands, each opening what the app already has.
  { command: 'model', name: 'Model', description: 'Choose the model for this chat.', glyph: 'i-sparkle' },
  { command: 'reasoning', name: 'Reasoning', description: 'Choose how long the model thinks.', glyph: 'i-bolt' },
  { command: 'new', name: 'New chat', description: 'Start a new chat.', glyph: 'i-plus' },
  { command: 'rename', name: 'Rename', description: 'Rename this chat in the app.', glyph: 'i-pencil' },
  { command: 'pin', name: 'Pin', description: 'Pin or unpin this chat at the top of its list.', glyph: 'i-pin' },
  { command: 'status', name: 'Status', description: 'Show how full this chat is.', glyph: 'i-pulse' },
  { command: 'review', name: 'Review', description: 'Ask for a review of the uncommitted changes.', glyph: 'i-git-diff' },
  { command: 'init', name: 'Init', description: 'Ask for an AGENTS.md that describes this project.', glyph: 'i-file-text' },
  { command: 'usage', name: 'Usage', description: 'Open usage and token statistics.', glyph: 'i-chart' },
  { command: 'plugins', name: 'Plugins', description: 'Open the plugins and their status.', glyph: 'i-plug' },
  { command: 'pet', name: 'Pet', description: 'Open the pets.', glyph: 'i-paw' },
  { command: 'feedback', name: 'Feedback', description: 'Open the diagnostics report to attach to a bug report.', glyph: 'i-warning' },
  // The open chat's answer copy, Markdown export and Find in chat.
  { command: 'copy', name: 'Copy', description: 'Copy the newest answer in this chat.', glyph: 'i-copy' },
  { command: 'export', name: 'Export', description: 'Save this chat as a Markdown file.', glyph: 'i-export' },
  { command: 'find', name: 'Find', description: 'Find text in this chat.', glyph: 'i-search' }
  // The command or the name the menu shows: a German menu says "Umbenennen" for /rename.
] as const;

export function initSkills(options: Options) {
  const { input, host, selectedHost } = options;
  const control = (label: string, className = 'btn'): HTMLButtonElement => {
    const node = el('button', className, () => t(label)) as HTMLButtonElement; node.type = 'button'; return node;
  };
  host.className = 'skill-autocomplete'; host.setAttribute('role', 'listbox');
  const cache = new Map<string, SkillLibrary>();
  let epoch = 0, surfaceOwner = '', loadedKey: string | null = null, loading = false, error = '', composing = false;
  type CommandChoice = { command: string; name: string; description: string; glyph: string };
  type FileChoice = { file: ProjectFileEntry };
  type IndexedFile = { entry: ProjectFileEntry; normalizedName: string };
  let library: SkillLibrary | null = null, files: ProjectDirectoryListing | null = null;
  let indexedFiles: IndexedFile[] = [];
  let choices: Array<LibrarySkill | CommandChoice | FileChoice> = [], selected = 0, painted = '';
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
      const command = id === 'compact';
      const skill = command ? undefined : catalog?.skills.find(row => row.id === id);
      const name = command ? t('Compact') : skill ? title(skill) : id;
      const chip = el('div', 'composer-selected-skill'); chip.dataset.skillId = id;
      if (command) chip.dataset.command = id;
      chip.title = command ? t('Compact this chat and resume it in a fresh conversation.') : skill?.path ?? `/${id}`;
      const remove = control('Remove', 'composer-selected-skill-remove'); remove.replaceChildren(icon('i-x'));
      ui(remove, 'aria-label', () => t('Remove {0}', [name]));
      const owner = options.owner();
      remove.addEventListener('click', () => {
        if (owner !== options.owner()) return;
        const retained = split(displayedPrefix).ids.filter(value => value !== id);
        project(`${retained.map(value => `/${value}\n`).join('')}${input.value}`);
        input.focus();
      });
      chip.append(icon(command ? 'i-copy' : 'i-skill', 'ico composer-selected-skill-icon'), el('span', 'composer-selected-skill-title', name), remove);
      selectedHost.append(chip);
    }
  };
  const restore = (): void => {
    close();
    const draft = split(options.draft() ?? input.value);
    displayedPrefix = draft.prefix; prefixOwner = options.owner(); input.value = draft.body;
    renderSelected();
  };
  const project = (authored: string, source: 'authored' | 'command' = 'authored', caret?: number): void => {
    options.saveDraft(authored);
    const draft = split(authored); displayedPrefix = draft.prefix; prefixOwner = options.owner(); input.value = draft.body;
    const position = caret === undefined ? input.value.length : Math.max(0, Math.min(caret, input.value.length));
    renderSelected(); input.setSelectionRange(position, position);
    const view = input.ownerDocument.defaultView!;
    input.dispatchEvent(source === 'command'
      ? new view.CustomEvent('input', { bubbles: true, detail: COMPOSER_COMMAND_PROJECTION })
      : new view.Event('input', { bubbles: true }));
  };
  const choose = (skill: typeof choices[number]): void => {
    if ('file' in skill) {
      const range = fragment(), projectId = options.scope().projectId;
      const key = `files:${projectId ?? ''}:${range?.directory ?? ''}`;
      if (!projectId || !current() || !range || range.kind !== 'file' || files?.projectId !== projectId || files.directory !== (range.directory ?? '') || loadedKey !== key || painted !== selectionKey() || composing) { close(); return; }
      const path = skill.file.path.replace(/[\\ ]/g, value => `\\${value}`);
      const directory = skill.file.kind === 'directory';
      const reference = `@${path}${directory ? '/' : ' '}`;
      const suffixStart = !directory && input.value[range.end] === ' ' ? range.end + 1 : range.end;
      const text = input.value.slice(0, range.start) + reference + input.value.slice(suffixStart);
      close(); project((prefixOwner === options.owner() ? displayedPrefix : '') + text, 'authored', range.start + reference.length); input.focus(); return;
    }
    if ('command' in skill) {
      const range = fragment();
      if (!current() || !range || range.kind !== 'command' || painted !== selectionKey() || composing) { close(); return; }
      const text = range ? input.value.slice(0, range.start) + input.value.slice(range.end) : input.value;
      const authored = (prefixOwner === options.owner() ? displayedPrefix : '') + text;
      if (options.deferCommand?.(skill.command)) {
        const draft = split(authored);
        const prefix = draft.ids.includes(skill.command) ? draft.prefix
          : `${draft.prefix}${draft.prefix && !/\s$/.test(draft.prefix) ? '\n' : ''}/${skill.command}\n`;
        close(); project(prefix + draft.body); input.focus(); return;
      }
      close(); project(authored, 'command'); options.command?.(skill.command); input.focus(); return;
    }
    if (!current() || composing) { close(); return; }
    const range = fragment();
    if (!range || range.kind !== 'skill' && range.kind !== 'command' || painted !== selectionKey()) { close(); return; }
    const replacement = range.kind === 'skill' ? title(skill) : '';
    const suffix = input.value.slice(range.end);
    const text = input.value.slice(0, range.start) + replacement + (replacement ? suffix : suffix.replace(/^\s+/, ''));
    const draft = split((prefixOwner === options.owner() ? displayedPrefix : '') + text);
    const prefix = draft.ids.includes(skill.id) ? draft.prefix
      : `${draft.prefix}${draft.prefix && !/\s$/.test(draft.prefix) ? '\n' : ''}/${skill.id}\n`;
    close(); project(prefix + draft.body, 'authored', range.start); input.focus();
  };
  const filtered = (query: string): LibrarySkill[] => {
    const needle = query.trim().toLocaleLowerCase();
    return (library?.skills ?? []).filter(skill => `${skill.id} ${title(skill)} ${skill.description} ${skill.scope}`.toLocaleLowerCase().includes(needle));
  };
  const filteredFiles = (query: string): ProjectFileEntry[] => indexedFiles
    .filter(file => file.entry.kind !== 'other' && file.normalizedName.includes(query))
    .map(file => file.entry);
  const stateMessage = (range: Completion, query: string): string => {
    if (error) return error;
    if (loading && (range.kind === 'file' ? !files : !library))
      return t(range.kind === 'file' ? 'Loading files…' : 'Loading skills…');
    if (choices.length) return '';
    if (query) return t('No matches for “{0}”.', [`${range.kind === 'file' ? '@' : '/'}${query}`]);
    return t(range.kind === 'file' ? 'No files in this folder.' : 'No skills available.');
  };
  const paintInline = (): void => {
    if (!current() || composing) { hideInline(); return; }
    const range = fragment();
    if (!range) { hideInline(); return; }
    const query = range?.query ?? '';
    const commands = range.kind === 'command' && options.command ? APP_COMMANDS.filter(row => (row.command.includes(query) || t(row.name).toLocaleLowerCase().includes(query)) &&
      (options.commandAvailable?.(row.command) ?? true)) : [];
    const matchingSkills = range.kind !== 'file' && !(loading && !library) ? filtered(query).slice(0, 64) : [];
    const matchingFiles = range.kind === 'file' && files !== null && files.projectId === options.scope().projectId && files.directory === (range.directory ?? '')
      ? filteredFiles(query).slice(0, 64).map(file => ({ file })) : [];
    choices = [...commands, ...matchingSkills, ...matchingFiles];
    selected = Math.min(selected, Math.max(0, choices.length - 1)); painted = selectionKey();
    const exact = range.kind !== 'file' && query && !loading && !commands.some(row => row.command === query)
      ? library?.skills.find(skill => skill.id.toLocaleLowerCase() === query)
      : undefined;
    const hasLongerId = exact && library?.skills.some(skill => {
      const id = skill.id.toLocaleLowerCase();
      return id !== query && id.startsWith(query);
    });
    // An unambiguous, fully typed /id has the same meaning as choosing that
    // row. Project it immediately so consecutive directives become chips.
    if (exact && !hasLongerId && range.kind !== 'skill') { choose(exact); return; }
    const renderEpoch = epoch, renderOwner = options.owner(), renderSelection = selectionKey(), renderScope = scopeKey();
    const chooseCurrent = (choice: typeof choices[number]): void => {
      if (epoch === renderEpoch && options.owner() === renderOwner && scopeKey() === renderScope && selectionKey() === renderSelection) choose(choice);
    };
    host.replaceChildren(); host.hidden = false;
    input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', host.id);
    for (const [index, skill] of choices.entries()) {
      const command = 'command' in skill, file = 'file' in skill;
      if (index === 0 || index === commands.length && !command && !file || index === commands.length + matchingSkills.length && file)
        host.append(el('div', 'slash-menu-section-title', () => t(command ? 'Commands' : file ? 'Files' : 'Skills')));
      const row = control('', 'skill-choice skill-autocomplete-option slash-menu-option');
      row.replaceChildren(); row.id = `skill-option-${index}`; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === selected));
      if (file) row.dataset.filePath = skill.file.path;
      else if (!command) row.dataset.skillId = skill.id;
      row.title = command ? `/${skill.command}` : file ? `@${skill.file.path}` : skill.path;
      const copy = el('span', 'slash-menu-copy');
      copy.append(el('strong', '', command ? t(skill.name) : file ? skill.file.name : title(skill)),
        el('small', '', command ? t(skill.description) : file ? skill.file.path : skill.shortDescription ?? skill.description));
      row.append(icon(command ? skill.glyph : file ? skill.file.kind === 'directory' ? 'i-folder' : 'i-file-text' : 'i-skill', 'ico slash-menu-icon'), copy,
        el('span', 'slash-menu-meta', () => command ? '' : file ? t('Project') : scopeLabel(skill)));
      row.addEventListener('pointerdown', event => event.preventDefault()); row.addEventListener('click', () => chooseCurrent(skill)); host.append(row);
    }
    const message = stateMessage(range, query);
    if (message) {
      const state = el('p', 'slash-menu-empty', message);
      state.setAttribute('role', error ? 'alert' : 'status'); host.append(state);
    }
    if (choices.length) { input.setAttribute('aria-activedescendant', `skill-option-${selected}`); host.querySelector(`#skill-option-${selected}`)?.scrollIntoView?.({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  };
  const load = async (): Promise<void> => {
    const request = ++epoch, owner = options.owner(), scope = options.scope(), range = fragment();
    surfaceOwner = owner; loading = true; error = '';
    if (range?.kind === 'file') {
      const projectId = scope.projectId, directory = range.directory ?? '', key = `files:${projectId ?? ''}:${directory}`;
      loadedKey = key; files = null; indexedFiles = []; paintInline();
      if (!projectId) { loading = false; paintInline(); return; }
      try {
        const result = await options.listFiles(projectId, directory);
        if (request !== epoch || owner !== options.owner() || scopeKey() !== JSON.stringify(scope) || fragment()?.kind !== 'file' || (fragment()?.directory ?? '') !== (range.directory ?? '')) return;
        if (result.projectId !== projectId || result.directory !== directory) throw new Error('The project folder changed. Choose the file again.');
        files = result;
        indexedFiles = result.entries.filter(entry => !/[\\\u0000-\u001f\u007f]/.test(entry.path))
          .map(entry => ({ entry, normalizedName: entry.name.toLocaleLowerCase() }));
      } catch (failure) { if (request === epoch && current()) error = failure instanceof Error ? failure.message : String(failure); }
      finally { if (request === epoch && current() && scopeKey() === JSON.stringify(scope) && fragment()?.kind === 'file' && (fragment()?.directory ?? '') === (range.directory ?? '') && options.scope().projectId) { loading = false; paintInline(); } }
      return;
    }
    const key = `skills:${JSON.stringify(scope)}`;
    loadedKey = key; library = cache.get(JSON.stringify(scope)) ?? null; paintInline();
    try {
      const result = await options.list(scope);
      if (request !== epoch || owner !== options.owner() || scopeKey() !== JSON.stringify(scope) || fragment()?.kind === 'file') return;
      if (!result.ok) error = result.error;
      else {
        library = result.data; cache.delete(JSON.stringify(scope)); cache.set(JSON.stringify(scope), library);
        while (cache.size > 12) cache.delete(cache.keys().next().value!);
      }
    } catch (failure) { if (request === epoch && current()) error = failure instanceof Error ? failure.message : String(failure); }
    finally { if (request === epoch && current()) { loading = false; paintInline(); renderSelected(); } }
  };
  const update = (): void => {
    options.saveDraft(authoredText());
    if (composing) return;
    const range = fragment();
    if (!range) { hideInline(); loadedKey = null; return; }
    if (range.kind === 'file' && !options.scope().projectId) { close(); return; }
    selected = 0;
    const key = range.kind === 'file' ? `files:${options.scope().projectId ?? ''}:${range.directory ?? ''}` : `skills:${scopeKey()}`;
    if (loadedKey !== key || !current()) void load(); else paintInline();
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
  input.addEventListener('click', () => { if (!host.hidden) update(); });
  document.addEventListener('click', event => {
    if (!host.contains(event.target as Node) && event.target !== input) hideInline();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing && !host.hidden) { hideInline(); input.focus(); }
  });
  const hasCommand = (name: string): boolean => split(prefixOwner === options.owner() ? displayedPrefix : '').ids.includes(name);
  const removeCommand = (name: string): void => {
    if (prefixOwner !== options.owner()) return;
    const retained = split(displayedPrefix).ids.filter(value => value !== name);
    project(`${retained.map(value => `/${value}\n`).join('')}${input.value}`);
  };
  return { close, restore, open: (): boolean => !host.hidden, authoredText, hasCommand, removeCommand, keydown: (event: KeyboardEvent): boolean => {
    if (host.hidden || !current() || composing || event.isComposing) return false;
    if (!fragment() || painted !== selectionKey()) { hideInline(); return false; }
    if (event.key === 'Escape') { hideInline(); event.preventDefault(); return true; }
    if (!choices.length || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;
    const range = fragment();
    if (range?.kind === 'file' && loadedKey !== `files:${options.scope().projectId ?? ''}:${range.directory ?? ''}`) {
      update(); event.preventDefault(); return true;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      selected = (selected + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length; paintInline();
    } else if (event.key === 'Enter' || event.key === 'Tab') choose(choices[selected]!);
    else return false;
    event.preventDefault(); return true;
  } };
}
