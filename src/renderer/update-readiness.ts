import type { AppState } from '../shared/types.js';
import { $, el } from './dom.js';
import { t, ui } from './i18n.js';

interface ReadinessRow {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'not-run' | 'skipped';
  detail: string;
  reason?: string;
  nextStep?: string;
  schemaUnchecked?: boolean;
}

/** Projects existing owners only. Unknown, old proof and a dismissed reminder cannot pass. */
export function updateReadiness(next: AppState): ReadinessRow[] {
  const { update, bridge, status } = next;
  const appReady = update.stage === 'idle' && !update.latest && update.checkedAt != null;
  const appDetail = update.stage === 'failed' ? t('Update check failed')
    : update.stage === 'checking' ? t('Checking for a newer version…')
    : update.stage === 'downloading' ? t('Downloading {0}', [update.latest])
    : update.latest ? (update.stage === 'ready' ? t('Ready to install {0}', [update.latest]) : t('Install {0} manually', [update.latest]))
    : appReady ? t('Up to date') : t('Not checked yet');
  const extensionReady = bridge.running && bridge.paired && bridge.present && bridge.extensionVersion === update.current;
  const extensionMismatch = !!bridge.extensionVersion && bridge.extensionVersion !== update.current;
  const connectionFailed = ['offline', 'auth-failed', 'tunnel-unavailable'].includes(status.state);
  const rows: ReadinessRow[] = [
    { id: 'app', label: 'Chat On Steroids', status: appReady ? 'pass' : update.stage === 'failed' ? 'fail' : 'not-run',
      detail: t('Version {0}', [update.current]) + ' · ' + appDetail,
      reason: update.stage === 'failed' ? update.error ?? undefined : undefined,
      nextStep: update.stage === 'failed' ? t('Choose Update all to retry. You can keep using the current app.') : undefined },
    { id: 'extension', label: t('Browser extension'), status: extensionReady ? 'pass' : 'not-run',
      detail: (bridge.extensionVersion ? t('Version {0}', [bridge.extensionVersion]) + ' · ' : '') +
        (extensionReady ? t('Connected') : !bridge.present || !bridge.paired ? t('Not connected') :
          bridge.extensionVersion ? t('App and extension versions differ') : t('Version not verified')),
      reason: !bridge.running ? bridge.error ?? undefined : undefined,
      nextStep: extensionReady ? undefined : extensionMismatch
        ? t('Let active chats finish, then reload the companion extension in your browser.')
        : t('Open ChatGPT with the companion extension enabled, then choose Review setup.') }
  ];
  const surfaces = status.surfaces ?? [];
  if (!surfaces.some(surface => surface.id === 'core')) {
    rows.push({ id: 'core', label: t('Core connector'), status: connectionFailed ? 'fail' : 'not-run', detail: t('Not connected'),
      reason: (connectionFailed || status.state === 'disconnected') && status.detail ? t(status.detail) : undefined,
      nextStep: t('Choose Review setup to check the connection, then choose Update all to retry.') });
  }
  for (const surface of surfaces) {
    const refresh = next.connectorRefresh?.[surface.id];
    const sameSchema = !!next.connectorSchemas?.[surface.id] && refresh?.schemaId === next.connectorSchemas[surface.id];
    const off = surface.optional && (surface.state === 'off' || surface.tools.length === 0);
    const connected = surface.state === 'live' && status.state === 'connected';
    const verified = connected && surface.lastRequestAt != null && sameSchema && refresh?.state === 'current';
    const functional = connected && sameSchema && refresh?.responding === true;
    const surfaceFailed = surface.state === 'error' || connectionFailed;
    const detail = off ? t('Not enabled') : !connected ? t('Not connected')
      : !sameSchema ? t('Not verified in ChatGPT')
      : functional && !verified && refresh?.state === 'unknown' ? t('Tool call succeeded; full schema not verified')
      : refresh?.state === 'manual' ? t('Manual refresh required in ChatGPT')
      : refresh?.state === 'failed' ? t('Connector refresh failed')
      : refresh?.state === 'refreshing' ? t('Waiting for refresh confirmation')
      : refresh?.state === 'pending' ? t('Refresh needed in ChatGPT')
      : refresh?.state !== 'current' ? t('Not verified in ChatGPT')
      : surface.lastRequestAt == null ? t('Waiting for a ChatGPT connection') : t('Verified in ChatGPT');
    const connectionDetail = surface.detail || status.detail;
    const reason = off ? undefined : !connected ? (surfaceFailed || status.state === 'disconnected') && connectionDetail ? t(connectionDetail) : undefined
      : sameSchema && refresh?.state === 'failed' ? refresh.failure === 'inspection'
        ? t('Could not inspect the installed connector in ChatGPT.')
        : refresh.failure === 'confirmation' ? t('Could not confirm the current connector schema in ChatGPT.') : undefined : undefined;
    const nextStep = off || verified ? undefined : !connected
      ? t('Choose Review setup to check the connection, then choose Update all to retry.')
      : sameSchema && refresh?.state === 'manual'
        ? t('Refresh or recreate this connector in ChatGPT, then choose Update all to recheck.')
      : sameSchema && refresh?.state === 'failed'
        ? t('Open this connector in ChatGPT and check its tool list, then choose Update all to recheck.')
      : sameSchema && refresh?.state === 'refreshing'
        ? t('Wait for confirmation. If it does not arrive, open this connector in ChatGPT and choose Update all to recheck.')
      : sameSchema && refresh?.state === 'current'
        ? t('Run a tool through this connector in ChatGPT to confirm this connection.')
      : t('Choose Update all to check the installed connector schema.');
    rows.push({ id: surface.id, label: surface.connectorName, reason, nextStep,
      schemaUnchecked: !off && functional && !verified,
      status: off ? 'skipped' : verified || (functional && refresh?.state === 'unknown') ? 'pass' : surfaceFailed || (sameSchema && refresh?.state === 'failed') ? 'fail' : 'not-run', detail });
  }
  return rows;
}

export function paintUpdateReadiness(next: AppState, operationError: string | null = null): void {
  const rows = updateReadiness(next);
  const ready = !operationError && rows.every(row => row.status === 'pass' || row.status === 'skipped');
  const schemaUnchecked = rows.some(row => row.schemaUnchecked);
  const summary = $('updateReadinessSummary');
  summary.dataset.ready = String(ready);
  ui(summary, 'textContent', () => ready ? schemaUnchecked ? t('Ready to use; full connector schema not verified') : t('All checks passed') : t('Checks incomplete'));
  const details = $<HTMLDetailsElement>('updateReadinessDetails');
  if (details.dataset.ready !== String(ready)) {
    if (!ready || !details.contains(document.activeElement)) details.open = !ready;
    details.dataset.ready = String(ready);
  }
  summary.classList.toggle('is-ok', ready);
  const error = $('updateAllError');
  error.hidden = !operationError;
  ui(error, 'textContent', () => operationError ? t('Update all could not finish: {0}. Choose Update all to retry.', [t(operationError)]) : '');
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
