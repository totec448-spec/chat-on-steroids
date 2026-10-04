import type { ToolCallRecord } from '../shared/session.js';
import { disclosureChevron, el, icon, run } from './dom.js';
import { t, ui } from './i18n.js';

/** Immutable per-call review assets supply diffs, never today's filesystem or patch intent. */
export function renderEditCards(call: ToolCallRecord, sessionId: string, current: () => boolean): HTMLElement {
  const cards = el('div', 'edit-cards');
  for (const [index, change] of (call.changes ?? []).slice(0, 32).entries()) {
    const card = document.createElement('details'); card.className = 'edit-card';
    const header = el('summary', 'edit-card-header');
    header.append(icon('i-file-text'), el('b', '', () => `${t(call.summary.kind === 'create' ? 'Created' : call.summary.kind === 'delete' ? 'Deleted' : 'Edited')} ${change.path.split(/[\\/]/).pop()}`),
      el('span', 'metric-added', `+${change.added}`), el('span', 'metric-removed', `−${change.removed}`), disclosureChevron('edit-chevron'));
    if (change.approximate) header.append(el('span', 'meta', () => t(' (approx.)')));
    const path = el('div', 'edit-card-path', change.path);
    const controls = el('div', 'edit-card-controls');
    const copy = el('button', 'tool-copy', () => t('Copy')) as HTMLButtonElement; copy.type = 'button'; copy.disabled = true;
    const expand = el('button', 'tool-copy', () => t('Expand')) as HTMLButtonElement; expand.type = 'button';
    expand.onclick = () => { const full = card.classList.toggle('is-expanded'); expand.setAttribute('aria-pressed', String(full)); };
    expand.setAttribute('aria-pressed', 'false');
    controls.append(copy, expand);
    const viewport = el('div', 'unified-diff'); viewport.tabIndex = 0;
    ui(viewport, 'aria-label', () => t('Diff for {0}', [change.path]));
    const body = el('div', 'edit-card-body'); body.append(path, controls, viewport); card.append(header, body);
    let loaded = false;
    card.addEventListener('toggle', async () => {
      if (!card.open || loaded || !card.isConnected || !current()) return;
      loaded = true;
      viewport.replaceChildren(el('p', 'meta', () => t('Loading edit…')));
      if (!change.reviewAssetId) {
        viewport.replaceChildren(el('p', 'meta', () => t(change.reviewUnavailable === 'too-large'
          ? 'Diff unavailable: this edit was too large to keep' : 'Diff unavailable: this edit was not kept'))); return;
      }
      const reply = await run(window.api.getToolEditReview(sessionId, call.callId, index));
      if (!current() || !card.isConnected) return;
      if (!reply || reply.callId !== call.callId || reply.changeIndex !== index || reply.path !== change.path) {
        viewport.replaceChildren(el('p', 'meta', () => t('Recorded edit is unavailable.'))); return;
      }
      copy.disabled = false;
      copy.onclick = () => { if (current() && card.isConnected) void run(window.api.writeClipboard(reply.currentText)); };
      if (reply.baseText.length + reply.currentText.length > 512 * 1024) {
        viewport.replaceChildren(el('p', 'meta', () => t('Recorded edit is unavailable.')));
        copy.disabled = true; return;
      }
      const module = await import('./unified-diff.js');
      if (!current() || !card.isConnected) return;
      await module.renderUnifiedDiff(viewport, change.path, reply.baseText, reply.currentText, () => current() && card.isConnected);
    });
    cards.append(card);
  }
  if ((call.changes?.length ?? 0) > 32) cards.append(el('p', 'meta', () => t('More edited files are available in the recording.')));
  return cards;
}
