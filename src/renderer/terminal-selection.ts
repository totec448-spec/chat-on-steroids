import { currentLanguage, t, tn } from './i18n.js';

/**
 * Send a terminal selection to the composer: the selected lines go into the draft as a fenced
 * block, after what is already typed, with the caret below it for the question. Nothing is sent.
 */

/** A selection can be all 5,000 lines of scrollback; the end of it is what usually matters. */
export const MAX_TERMINAL_LINES = 400;
export const MAX_TERMINAL_CHARACTERS = 20_000;

/**
 * The selection as a fenced block, or null when it holds no text. Over the caps, the last lines
 * are kept and a line above the block says how much is left out.
 */
export function terminalSelectionBlock(selection: string): string | null {
  const lines = selection.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd());
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (!lines.length) return null;
  const total = lines.length;
  let kept = lines.slice(-MAX_TERMINAL_LINES);
  let size = kept.reduce((sum, line) => sum + line.length + 1, -1);
  while (kept.length > 1 && size > MAX_TERMINAL_CHARACTERS) { size -= kept[0]!.length + 1; kept = kept.slice(1); }
  let note = '';
  if (size > MAX_TERMINAL_CHARACTERS) {
    // One line longer than the whole cap: its end stays.
    kept = [kept[0]!.slice(-MAX_TERMINAL_CHARACTERS)];
    note = t('Only the end of the selection is here: the last {0} characters.', [MAX_TERMINAL_CHARACTERS.toLocaleString(currentLanguage())]);
  } else if (kept.length < total) {
    note = tn('Only the end of the selection is here: the last {0} of {1} line.', 'Only the end of the selection is here: the last {0} of {1} lines.',
      total, [kept.length.toLocaleString(currentLanguage()), total.toLocaleString(currentLanguage())]);
  }
  const text = kept.join('\n');
  // A fence longer than any run of backticks in the output, so none of it can close the block.
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${note ? `${note}\n\n` : ''}${fence}\n${text}\n${fence}`;
}

/** The draft with the block after what is typed, and an empty line under it to write on. */
export function draftWithTerminalBlock(draft: string, block: string): string {
  // Only the empty lines at the end go; spaces typed on the last line stay.
  const typed = draft.trim() ? draft.replace(/(?:\r?\n[ \t]*)+$/, '') : '';
  return `${typed ? `${typed}\n\n` : ''}${block}\n\n`;
}

/** Adds the selection to the composer and puts the caret after it; false when there was no text. */
export function sendTerminalSelection(input: HTMLTextAreaElement, selection: string): boolean {
  const block = terminalSelectionBlock(selection);
  if (!block) return false;
  input.value = draftWithTerminalBlock(input.value, block);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}
