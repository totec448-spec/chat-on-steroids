import { Text } from '@codemirror/state';
import { Chunk } from '@codemirror/merge';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { el } from './dom.js';
import { t } from './i18n.js';

export interface DiffLine { kind: 'context' | 'added' | 'removed' | 'gap'; old: number | null; next: number | null; text: string }
/** Bounded line projection of exact recorded snapshots. Counts remain recorder-owned. */
export function unifiedDiffLines(base: string, current: string, limit = 600): { lines: DiffLine[]; truncated: boolean } {
  const a = Text.of(base.split('\n')), b = Text.of(current.split('\n'));
  const chunks = Chunk.build(a, b, { scanLimit: 1000, timeout: 50 });
  const lines: DiffLine[] = [];
  let old = 1, next = 1, truncated = false;
  const add = (line: DiffLine): void => { if (lines.length < limit) lines.push(line); else truncated = true; };
  const context = (end: number): void => {
    const count = end - old;
    for (let i = 0; i < count; i++) {
      if (count > 6 && i === 3) {
        add({ kind: 'gap', old: null, next: null, text: t('{0} unchanged lines', [count - 6]) });
        old += count - 6; next += count - 6; i += count - 6;
      }
      add({ kind: 'context', old, next, text: a.line(old).text }); old++; next++;
    }
  };
  for (const chunk of chunks) {
    const startA = a.lineAt(Math.min(chunk.fromA, a.length)).number;
    const startB = b.lineAt(Math.min(chunk.fromB, b.length)).number;
    context(startA); next = startB;
    const endA = chunk.toA > chunk.fromA ? a.lineAt(Math.min(chunk.toA - 1, a.length)).number + 1 : startA;
    const endB = chunk.toB > chunk.fromB ? b.lineAt(Math.min(chunk.toB - 1, b.length)).number + 1 : startB;
    for (; old < endA; old++) if (base) add({ kind: 'removed', old, next: null, text: a.line(old).text });
    for (; next < endB; next++) if (current) add({ kind: 'added', old: null, next, text: b.line(next).text });
    if (truncated) break;
  }
  if (!truncated) context(a.lines + (base.endsWith('\n') ? 0 : 1));
  return { lines, truncated };
}

/** Text nodes only, with two line gutters and a small syntax palette. No executable HTML. */
export async function renderUnifiedDiff(host: HTMLElement, filename: string, base: string, current: string, currentOwner: () => boolean): Promise<void> {
  const description = LanguageDescription.matchFilename(languages, filename);
  let language = null;
  if (description) try { language = (await description.load()).language; } catch { /* Text remains readable. */ }
  if (!currentOwner()) return;
  const { lines, truncated } = unifiedDiffLines(base, current);
  const content = el('div', 'unified-diff-lines'); content.setAttribute('role', 'table');
  for (const line of lines) {
    const row = el('div', `diff-line is-${line.kind}`); row.setAttribute('role', 'row');
    row.append(el('span', 'diff-gutter', line.old === null ? '' : String(line.old)),
      el('span', 'diff-gutter', line.next === null ? '' : String(line.next)),
      el('span', 'diff-sign', line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '));
    const code = el('code', 'diff-code');
    if (language && line.text.length <= 4000 && line.kind !== 'gap') {
      let cursor = 0;
      highlightTree(language.parser.parse(line.text), classHighlighter, (from, to, classes) => {
        code.append(line.text.slice(cursor, from), el('span', classes, line.text.slice(from, to))); cursor = to;
      });
      code.append(line.text.slice(cursor));
    } else code.textContent = line.text;
    row.append(code); content.append(row);
  }
  host.replaceChildren(content);
  if (truncated) host.append(el('p', 'meta', () => t('Preview limited to 600 lines. Open Review for the complete edit.')));
}
