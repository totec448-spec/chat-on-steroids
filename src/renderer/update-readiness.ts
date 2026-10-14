import type { AppState } from '../shared/types.js';
import { $, el } from './dom.js';
import { t, ui } from './i18n.js';
import { updateErrorNextStep, updateErrorText } from './update-error.js';
import { updateReadiness } from './update-readiness-state.js';

/** Native details owns the person's choice; this only synchronizes its compact presentation. */
function syncDisclosure(): void {
  const details = $<HTMLDetailsElement>('updateReadinessDetails');
  const compact = $('updateReadinessSummary').dataset.complete === 'true' && !details.open;
  $('updateReadinessCard').classList.toggle('is-compact', compact);
  $('updateReadinessTitle').hidden = compact;
  $('updateAllNotice').hidden = compact;
  $('updateReadinessToggle').setAttribute('aria-expanded', String(details.open));
}

export function initUpdateReadiness(): void {
  const details = $<HTMLDetailsElement>('updateReadinessDetails');
  details.addEventListener('toggle', syncDisclosure);
  $('updateReadinessToggle').addEventListener('click', () => { details.open = !details.open; syncDisclosure(); });
}

export function paintUpdateReadiness(next: AppState, operationError: string | null = null): void {
  const rows = updateReadiness(next);
  const busy = $('updateAll').getAttribute('aria-busy') === 'true';
  const ready = !operationError && !busy && rows.every(row => row.status === 'pass' || row.status === 'skipped');
  const schemaUnchecked = rows.some(row => row.schemaUnchecked);
  const summary = $('updateReadinessSummary');
  summary.dataset.ready = String(ready);
  summary.dataset.complete = String(ready && !schemaUnchecked);
  const summaryText = () => ready ? schemaUnchecked ? t('Ready to use; tool definitions not fully verified') : t('All checks passed') : t('Checks incomplete');
  ui(summary, 'textContent', summaryText);
  const announce = $('updateReadinessAnnounce');
  if (announce.textContent !== summaryText()) ui(announce, 'textContent', summaryText);
  const details = $<HTMLDetailsElement>('updateReadinessDetails');
  // Compare meaningful owner facts, never translated copy or frequently changing timestamps.
  // A new version/schema/error reopens an incomplete card; identical pushes preserve the choice.
  const signature = JSON.stringify([
    operationError, busy, next.update.current, next.update.latest, next.update.stage, next.update.error,
    next.update.checkedAt != null, next.bridge.extensionVersion, next.bridge.running, next.bridge.paired,
    next.bridge.present, next.bridge.error, next.status.state,
    next.status.state !== 'connected' ? next.status.detail : null,
    rows.map(row => [row.id, row.status, !!row.schemaUnchecked]),
    (next.status.surfaces ?? []).map(surface => [surface.id, surface.connectorName,
      next.connectorSchemas?.[surface.id], next.connectorRefresh?.[surface.id]?.schemaId,
      next.connectorRefresh?.[surface.id]?.state, next.connectorRefresh?.[surface.id]?.failure,
      surface.state === 'live' ? null : surface.detail]),
    rows.some(row => row.id === 'desktop' && row.status !== 'skipped') && next.platform?.family === 'macos'
      ? [next.config.capabilities.screen && next.desktopAccess?.screen,
        next.config.capabilities.control && !next.config.readOnly && next.desktopAccess?.accessibility] : null
  ]);
  if (details.dataset.state !== signature) {
    const needsAttention = !ready || schemaUnchecked;
    if (needsAttention || !details.contains(document.activeElement)) details.open = needsAttention;
    details.dataset.state = signature;
  }
  syncDisclosure();
  summary.classList.toggle('is-ok', ready);
  const error = $('updateAllError');
  error.hidden = !operationError;
  $('updateDiagnosticsReport').hidden = operationError !== 'Could not read plugin-refresh state';
  ui(error, 'textContent', () => operationError ? t('Update all could not finish: {0}', [updateErrorText(operationError)]) + '\n' + updateErrorNextStep(operationError) : '');
  $('updateReadinessRows').replaceChildren(...rows.map(row => {
    const item = el('li', row.status === 'pass' ? 'check is-ok' : row.status === 'fail' ? 'check is-bad' : `check is-${row.status}`);
    item.dataset.updatePart = row.id;
    const mark = el('span', 'check-mark', row.status === 'pass' ? '✓' : row.status === 'fail' ? '!' : row.status === 'skipped' ? '–' : '…');
    mark.setAttribute('aria-hidden', 'true');
    const body = el('div');
    // Re-evaluate translated copy on language changes even before the next state push.
    body.append(el('strong', '', () => updateReadiness(next).find(current => current.id === row.id)?.label ?? ''),
      el('p', '', () => updateReadiness(next).find(current => current.id === row.id)?.detail ?? ''));
    if (row.reason) body.append(el('p', 'is-warn', () => updateReadiness(next).find(current => current.id === row.id)?.reason ?? ''));
    if (row.nextStep) body.append(el('p', 'muted', () => updateReadiness(next).find(current => current.id === row.id)?.nextStep ?? ''));
    item.append(mark, body);
    return item;
  }));
}
