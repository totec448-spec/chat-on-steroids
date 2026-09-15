import { t } from './i18n.js';
import { icon } from './dom.js';

export type ComposerSlashCommandId = 'plan' | 'goal' | 'loop' | 'compact';

export interface ComposerSlashCommand {
  id: ComposerSlashCommandId;
  label: string;
  description: string;
}

export const COMPOSER_SLASH_COMMANDS: readonly ComposerSlashCommand[] = [
  { id: 'plan', label: 'Plan', description: 'Turn the next composer request into editable stages.' },
  { id: 'goal', label: 'Goal', description: 'Pursue a saved objective and stop when it is complete.' },
  { id: 'loop', label: 'Loop', description: 'Keep continuing toward the saved objective.' },
  { id: 'compact', label: 'Compact', description: 'Compact this chat and resume it in a fresh conversation.' }
] as const;

const COMMAND_ICON: Record<ComposerSlashCommandId, string> = {
  plan: 'i-steps',
  goal: 'i-target',
  loop: 'i-retry',
  compact: 'i-copy'
};

export function parseComposerSlashCommand(text: string): { id: ComposerSlashCommandId } | null {
  const match = /^\s*\/(plan|goal|loop|compact)\s*$/i.exec(text);
  if (!match) return null;
  return { id: match[1]!.toLowerCase() as ComposerSlashCommandId };
}

function commandPrefix(input: HTMLTextAreaElement): string | null {
  if (input.selectionStart !== input.selectionEnd) return null;
  const caret = input.selectionStart;
  if (caret < 1 || caret !== input.value.length) return null;
  const before = input.value.slice(0, caret);
  const match = /^\/([^\s/]*)$/.exec(before);
  return match?.[1]?.toLowerCase() ?? null;
}

/** Shares the existing slash popup with Skills, but only while the token can be a built-in command. */
export function createComposerSlashAutocomplete(options: {
  input: HTMLTextAreaElement;
  popup: HTMLElement;
  commands?: readonly ComposerSlashCommand[];
  onActivate: (command: ComposerSlashCommand) => void;
}): {
  matchesInput: () => boolean;
  onInput: () => void;
  onKeydown: (event: KeyboardEvent) => boolean;
  hide: () => void;
} {
  const { input, popup } = options;
  const commands = options.commands ?? COMPOSER_SLASH_COMMANDS;
  let selected = 0;
  let matches: readonly ComposerSlashCommand[] = [];

  const candidates = (): readonly ComposerSlashCommand[] => {
    const prefix = commandPrefix(input);
    if (prefix === null) return [];
    return commands.filter(command => command.id.startsWith(prefix));
  };

  const hide = (): void => {
    matches = [];
    selected = 0;
    popup.hidden = true;
    popup.classList.remove('composer-command-autocomplete');
    popup.replaceChildren();
    input.removeAttribute('aria-controls');
    input.removeAttribute('aria-activedescendant');
    input.removeAttribute('aria-expanded');
  };

  const complete = (command: ComposerSlashCommand): void => {
    input.value = `/${command.id}`;
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // The shared composer input listener may have rendered the exact command again.
    // Tab is completion only, so close the list after that synchronous repaint.
    hide();
    input.focus();
  };

  const activate = (command: ComposerSlashCommand): void => {
    hide();
    options.onActivate(command);
  };

  const render = (): void => {
    matches = candidates();
    if (!matches.length) { hide(); return; }
    selected = Math.min(selected, matches.length - 1);
    popup.replaceChildren();
    popup.classList.add('composer-command-autocomplete');
    input.setAttribute('aria-controls', popup.id);
    input.setAttribute('aria-expanded', 'true');
    matches.forEach((command, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'skill-autocomplete-option composer-command-option';
      row.id = `composerCommandOption-${index}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === selected));
      const glyph = icon(COMMAND_ICON[command.id], 'ico composer-command-icon');
      glyph.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('span'); copy.className = 'composer-command-copy';
      const label = document.createElement('strong'); label.textContent = t(command.label);
      const description = document.createElement('small'); description.textContent = t(command.description);
      copy.append(label, description); row.append(glyph, copy);
      row.addEventListener('pointerdown', event => event.preventDefault());
      row.addEventListener('click', () => activate(command));
      popup.append(row);
    });
    popup.hidden = false;
    input.setAttribute('aria-activedescendant', `composerCommandOption-${selected}`);
  };

  return {
    matchesInput: () => candidates().length > 0,
    onInput: () => { selected = 0; render(); },
    onKeydown: (event: KeyboardEvent): boolean => {
      if (event.isComposing || popup.hidden || !matches.length) return false;
      const prefix = commandPrefix(input);
      if (prefix === null) { hide(); return false; }
      if (event.key === 'Escape') { event.preventDefault(); hide(); return true; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        selected = (selected + delta + matches.length) % matches.length;
        render();
        return true;
      }
      if (event.key === 'Tab') {
        event.preventDefault(); complete(matches[selected]!); return true;
      }
      if (event.key === 'Enter') {
        event.preventDefault(); activate(matches[selected]!); return true;
      }
      return false;
    },
    hide
  };
}
