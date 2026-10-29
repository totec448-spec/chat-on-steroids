import type { SessionEvent } from '../shared/session.js';
import type { TurnFileChange } from '../main/session/turn-changes.js';
import { shortPath } from '../shared/virtual-path.js';
import { disclosureChevron, el, run } from './dom.js';
import { t, tn, ui } from './i18n.js';

/**
 * The "Changed files" summary under a finished answer that edited files (#1827, Haz's review).
 * Collapsed, always: one line with the files the answer really changed and their net +/−. A file
 * changed and put back in the same answer is named apart ("1 put back"), never counted as
 * changed. Open, each file once, in the order it was first changed, with its net diff on demand;
 * approximate counts and diffs the recording did not keep say so. Open in Review hands over to
 * the Review dock. The answer's tool rows stay the step-by-step record.
 */

const WORKER = /^worker-\d+$/;

/** How many of the chat's own calls in this turn recorded a successful edit, as loaded; a worker's do not count. */
export function turnEditCount(events: readonly SessionEvent[], turnId: string): number {
  return events.filter(event => event.kind === 'tool_call' && event.turnId === turnId && !(event.agent && WORKER.test(event.agent)) &&
    event.call.outcome === 'ok' && (event.call.changes?.length ?? 0) > 0).length;
}

/** Whether the chat's own calls in this turn recorded a successful edit; a worker's do not count. */
export function turnEdited(events: readonly SessionEvent[], turnId: string): boolean {
  return turnEditCount(events, turnId) > 0;
}

/**
 * Whether the turn is over: its latest boundary is its end, or another turn began after both its
 * answer and that boundary. A turn that started again after its answer runs until one does.
 */
export function turnFinished(events: readonly SessionEvent[], turnId: string, anchorSeq: number): boolean {
  let latest: SessionEvent | null = null;
  for (const event of events)
    if ((event.kind === 'turn_start' || event.kind === 'turn_end') && event.turnId === turnId && (!latest || event.seq > latest.seq)) latest = event;
  if (latest?.kind === 'turn_end') return true;
  const after = Math.max(anchorSeq, latest?.seq ?? anchorSeq);
  return events.some(event => event.seq > after && event.kind === 'turn_start' && event.turnId !== turnId);
}

/** Where the store's read of the turn starts: its first recorded row, or the top when that is not loaded. */
/**
 * Where a turn's edits are read from: its first start when that is loaded, else the chat's start.
 * An app-authored reopening (a turn_start with \`detail\`) is not the first start: the turn's earlier
 * edits lie before it, possibly outside the loaded page (CodeRabbit on #1836).
 */
export function turnFrom(events: readonly SessionEvent[], turnId: string): number {
  return firstTurnStart(events, turnId)?.seq ?? 0;
}
/** The turn's own first start, if loaded; a reopening never stands in for it. */
export function firstTurnStart(events: readonly SessionEvent[], turnId: string): SessionEvent | undefined {
  return events.find(event => event.kind === 'turn_start' && event.turnId === turnId && !event.detail);
}

const MAX_DIFF_CHARS = 512 * 1024;

function counts(change: Pick<TurnFileChange, 'added' | 'removed' | 'approximate' | 'state'>): string {
  const parts = [change.added || change.state === 'created' ? `+${change.added}` : '', change.removed || change.state === 'deleted' ? `−${change.removed}` : '']
    .filter(Boolean).join(' ');
  return parts && change.approximate ? `${parts}${t(' (approx.)')}` : parts;
}

const STATE_WORDS: Record<TurnFileChange['state'], () => string> = {
  edited: () => t('edited'), created: () => t('created'), deleted: () => t('deleted'), unchanged: () => t('no net change')
};

function headline(changes: readonly TurnFileChange[], total: number): string {
  const changed = changes.filter(change => change.state !== 'unchanged');
  const putBack = changes.length - changed.length;
  const more = Math.max(0, total - changes.length);
  if (!changed.length && !more) return tn('Touched {0} file, no net change', 'Touched {0} files, no net change', putBack);
  const sum = { added: changed.reduce((n, c) => n + c.added, 0), removed: changed.reduce((n, c) => n + c.removed, 0),
    approximate: changed.some(change => change.approximate) };
  return [tn('Changed {0} file', 'Changed {0} files', changed.length), `+${sum.added} −${sum.removed}${sum.approximate ? t(' (approx.)') : ''}`,
    ...(putBack ? [tn('{0} put back', '{0} put back', putBack)] : []), ...(more ? [tn('{0} more not listed', '{0} more not listed', more)] : [])].join(' · ');
}

export function renderTurnChanges(options: {
  sessionId: string; turnId: string; from: number; current: () => boolean; openReview: (() => void) | null;
}): HTMLElement {
  const card = document.createElement('details');
  card.className = 'turn-changes';
  card.hidden = true;
  const head = el('summary', 'turn-changes-head');
  const list = el('div', 'turn-changes-list');
  card.append(head, list);
  void (async () => {
    const reply = await run(window.api.turnChanges(options.sessionId, options.turnId, options.from));
    if (!reply || !reply.changes.length || !options.current() || !card.isConnected) return;
    const { changes, total } = reply;
    head.replaceChildren(el('span', 'turn-changes-title', () => headline(changes, total)), disclosureChevron('turn-changes-chevron'));
    const labels = turnChangeLabels(changes.map(change => change.path));
    changes.forEach((change, index) => list.append(fileRow(change, labels[index]!, options)));
    if (total > changes.length) list.append(el('p', 'meta', () => tn('and {0} more', 'and {0} more', total - changes.length)));
    if (options.openReview) {
      const review = el('button', 'btn btn-quiet turn-changes-review', () => t('Open in Review')) as HTMLButtonElement;
      review.type = 'button';
      review.addEventListener('click', () => { if (options.current()) options.openReview?.(); });
      list.append(review);
    }
    card.hidden = false;
  })();
  return card;
}

/**
 * Each file named the way the answer's tool rows name it, without the approved root's virtual
 * name; two files that would then read the same keep their roots, so the rows stay apart.
 */
export function turnChangeLabels(paths: readonly string[]): string[] {
  const short = paths.map(path => path.startsWith('/') ? shortPath(path) : path);
  return short.map((label, index) => short.filter(other => other === label).length > 1 ? paths[index]! : label);
}

function fileRow(change: TurnFileChange, label: string, options: { sessionId: string; turnId: string; from: number; current: () => boolean }): HTMLElement {
  const row = document.createElement('details');
  row.className = 'turn-change';
  row.dataset.state = change.state;
  const head = el('summary', 'turn-change-head');
  // The full path stays in the tooltip.
  const path = el('span', 'turn-change-path', label);
  head.append(path);
  const shown = counts(change);
  if (shown && change.state !== 'unchanged') head.append(el('span', 'turn-change-count', () => counts(change)));
  head.append(el('span', 'turn-change-state', STATE_WORDS[change.state]));
  ui(head, 'title', () => change.path);
  const viewport = el('div', 'unified-diff');
  viewport.tabIndex = 0;
  ui(viewport, 'aria-label', () => t('Diff for {0}', [change.path]));
  row.append(head, viewport);
  let loaded = false;
  const say = (message: () => string) => viewport.replaceChildren(el('p', 'meta', message));
  row.addEventListener('toggle', async () => {
    if (!row.open || loaded || !options.current()) return;
    loaded = true;
    if (change.state === 'unchanged') { say(() => t('Changed and put back in this answer: no net change.')); return; }
    if (change.diff !== 'kept') {
      say(() => change.diff === 'too-large' ? t('Diff unavailable: this edit was too large to keep') : t('Diff unavailable: this edit was not kept'));
      return;
    }
    say(() => t('Loading edit…'));
    const ends = await run(window.api.turnFileDiff(options.sessionId, options.turnId, options.from, change.path));
    if (!options.current() || !row.isConnected) return;
    if (!ends || ends.before.length + ends.after.length > MAX_DIFF_CHARS) { loaded = false; say(() => t('Recorded edit is unavailable.')); return; }
    const module = await import('./unified-diff.js');
    if (!options.current() || !row.isConnected) return;
    await module.renderUnifiedDiff(viewport, change.path, ends.before, ends.after, () => options.current() && row.isConnected);
  });
  return row;
}
