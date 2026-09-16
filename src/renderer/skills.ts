import type { SkillSummary } from '../shared/skills.js';
import { el, run } from './dom.js';
import { t } from './i18n.js';
import { invokedSkills } from '../shared/skill-invocation.js';

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
  input: HTMLTextAreaElement; button: HTMLElement; host: HTMLElement;
  owner: () => string;
  list: () => Promise<Reply<SkillSummary[]>>;
  importFile: () => Promise<Reply<SkillSummary | null>>;
};

/** The authored /id is the only selection state. Catalog requests never own a draft. */
export function initSkills(options: Options): { close: () => void; keydown: (event: KeyboardEvent) => boolean } {
  const { input, button, host } = options;
  let epoch = 0, owner = '', manual = false, loading = false, loaded = false;
  let painted = '';
  let composing = false;
  let catalog: SkillSummary[] = [], choices: SkillSummary[] = [], selected = 0;
  const fragment = () => skillCompletion(input.value, input.selectionStart, input.selectionEnd);
  const selectionKey = (): string => `${input.value}:${input.selectionStart}:${input.selectionEnd}`;
  const close = (): void => { epoch++; host.hidden = true; manual = false; loading = false; loaded = false; choices = []; input.removeAttribute('aria-controls'); input.removeAttribute('aria-expanded'); };
  const current = (): boolean => owner === options.owner();
  const choose = (skill: SkillSummary): void => {
    if (!current() || composing) { close(); return; }
    const range = fragment();
    if (!manual && (!range || painted !== selectionKey())) { close(); return; }
    let caret = 0;
    if (range) {
      input.value = input.value.slice(0, range.start) + `/${skill.id} ` + input.value.slice(range.end).replace(/^\s+/, '');
      caret = range.start + skill.id.length + 2;
    } else {
      let present = false;
      try { present = invokedSkills(input.value).includes(skill.id); } catch { /* Preserve incomplete authored commands. */ }
      if (!present) input.value = `/${skill.id}\n${input.value}`;
      caret = input.value.length;
    }
    close(); input.focus(); input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const paint = (): void => {
    if (!current()) { close(); return; }
    const query = manual ? '' : fragment()?.query ?? null;
    if (query === null) { close(); return; }
    choices = loading ? [] : catalog.filter(skill => `${skill.id} ${skill.name}`.toLowerCase().includes(query)).slice(0, 8);
    selected = Math.min(selected, Math.max(0, choices.length - 1));
    host.replaceChildren();
    painted = selectionKey();
    host.hidden = !manual && !choices.length;
    input.setAttribute('aria-expanded', String(!host.hidden));
    input.setAttribute('aria-controls', host.id);
    for (const [index, skill] of choices.entries()) {
      const row = el('button', 'skill-choice') as HTMLButtonElement; row.type = 'button';
      row.classList.toggle('selected', index === selected);
      row.append(el('strong', '', `/${skill.id}`), el('span', '', skill.description || skill.name));
      row.title = skill.path;
      row.addEventListener('click', () => choose(skill)); host.append(row);
    }
    if (manual) {
      if (!choices.length) host.append(el('p', 'muted', () => t(loading ? 'Loading skills…' : 'No skills installed. Import a Markdown or text file.')));
      const add = el('button', 'skill-import', () => t('Import skill…')) as HTMLButtonElement;
      add.type = 'button'; add.disabled = loading;
      add.addEventListener('click', async () => {
        const request = epoch, draft = options.owner(); add.disabled = true;
        try {
          const skill = await run(options.importFile());
          if (request !== epoch || draft !== options.owner()) return;
          if (skill) choose(skill); else add.disabled = false;
        } finally { if (add.isConnected) add.disabled = false; }
      });
      host.append(add);
    }
  };
  const open = async (fromButton: boolean): Promise<void> => {
    const request = ++epoch; owner = options.owner(); manual = fromButton; selected = 0; loading = true; paint();
    const rows = await run(options.list());
    if (request !== epoch || !current()) return;
    catalog = rows ?? []; loading = false; loaded = true; paint();
  };
  button.addEventListener('click', () => { input.focus(); void open(true); });
  const update = (): void => {
    if (composing) { close(); return; }
    if (fragment() === null) { close(); return; }
    if (!loaded && !loading) void open(false); else { manual = false; selected = 0; paint(); }
  };
  input.addEventListener('compositionstart', () => { composing = true; close(); });
  input.addEventListener('compositionend', () => { composing = false; update(); });
  input.addEventListener('input', event => { if ((event as InputEvent).isComposing) { close(); return; } update(); });
  input.addEventListener('click', () => { if (!host.hidden && !manual) paint(); });
  document.addEventListener('click', event => { if (!host.contains(event.target as Node) && !button.contains(event.target as Node) && event.target !== input) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !host.hidden) { close(); input.focus(); } });
  return { close, keydown: event => {
    if (host.hidden || !current() || event.isComposing) return false;
    if (!manual && (!fragment() || painted !== selectionKey())) { close(); return false; }
    if (event.key === 'Escape') { close(); event.preventDefault(); return true; }
    if (!choices.length || loading || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      selected = (selected + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length; paint();
    } else if (event.key === 'Enter' || event.key === 'Tab') choose(choices[selected]!);
    else return false;
    event.preventDefault(); return true;
  } };
}
