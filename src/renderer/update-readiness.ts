import type { AppState } from '../shared/types.js';
import { isNewer } from '../shared/types.js';
import { $, el } from './dom.js';
import { t, ui } from './i18n.js';
import { updateErrorNextStep, updateErrorText } from './update-error.js';

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
  const extensionOlder = !!bridge.extensionVersion && isNewer(update.current, bridge.extensionVersion);
  const appOlder = !!bridge.extensionVersion && isNewer(bridge.extensionVersion, update.current);
  const connectionFailed = ['offline', 'auth-failed', 'tunnel-unavailable'].includes(status.state);
  const rows: ReadinessRow[] = [
    { id: 'app', label: 'Chat On Steroids', status: appReady ? 'pass' : update.stage === 'failed' ? 'fail' : 'not-run',
      detail: t('Version {0}', [update.current]) + ' · ' + appDetail,
      reason: update.stage === 'failed' && update.error ? updateErrorText(update.error) : undefined,
      nextStep: update.stage === 'failed' ? t('Choose Update all to retry. You can keep using the current app.')
        : next.platform?.family === 'macos' && update.stage === 'idle' && update.latest
          ? t('Finish active work and fully quit Chat On Steroids. Replace the app in /Applications, then open the updated app from there.') : undefined },
    { id: 'extension', label: t('Browser extension'), status: extensionReady ? 'pass' : 'not-run',
      detail: (bridge.extensionVersion ? t('Version {0}', [bridge.extensionVersion]) + ' · ' : '') +
        (extensionReady ? t('Connected') : !bridge.present || !bridge.paired ? t('Not connected') :
          bridge.extensionVersion ? t('App and extension versions differ') : t('Version not verified')),
      reason: !bridge.running ? bridge.error ?? undefined : undefined,
      nextStep: extensionReady ? undefined : extensionOlder
        ? t('Let active chats finish, then reload the companion extension in your browser.')
        : appOlder ? t('Choose Update all to check for updates and update the app.')
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
    const disabled = surface.optional && surface.state === 'off';
    const noTools = surface.optional && !disabled && surface.tools.length === 0;
    const off = disabled || noTools;
    const connected = surface.state === 'live' && status.state === 'connected';
    const verified = connected && surface.lastRequestAt != null && sameSchema && refresh?.state === 'current';
    const functional = connected && sameSchema && refresh?.responding === true;
    const surfaceFailed = surface.state === 'error' || connectionFailed;
    const detail = disabled ? t('Not enabled') : noTools ? t('No tools published') : !connected ? t('Not connected')
      : !sameSchema ? t('Not verified in ChatGPT')
      : functional && !verified && refresh?.state === 'unknown' ? t('Tool call succeeded; full tool definitions not verified')
      : refresh?.state === 'manual' ? t('Manual refresh required in ChatGPT')
      : refresh?.state === 'failed' ? t(refresh.failure === 'inspection' ? 'Connector check failed' : 'Connector refresh failed')
      : refresh?.state === 'refreshing' ? t('Waiting for refresh confirmation')
      : refresh?.state === 'pending' ? t('Refresh needed in ChatGPT')
      : refresh?.state !== 'current' ? t('Not verified in ChatGPT')
      : surface.lastRequestAt == null ? t('Waiting for a ChatGPT connection') : t('Verified in ChatGPT');
    const connectionDetail = surface.detail || status.detail;
    const reason = off ? undefined : !connected ? (surfaceFailed || status.state === 'disconnected') && connectionDetail ? t(connectionDetail) : undefined
      : sameSchema && refresh?.state === 'failed' ? refresh.failure === 'inspection'
        ? t('Could not inspect the installed connector in ChatGPT.')
        : refresh.failure === 'confirmation' ? t('Could not confirm the current connector tool definitions in ChatGPT.') : undefined : undefined;
    const nextStep = off || verified ? undefined : !connected
      ? t('Choose Review setup to check the connection, then choose Update all to retry.')
      : sameSchema && refresh?.state === 'manual'
        ? t("In ChatGPT's connector settings, refresh or recreate this connector, then choose Update all to recheck.")
      : sameSchema && refresh?.state === 'failed'
        ? t("Open this connector's settings in ChatGPT, then choose Update all to recheck. If the check still fails, save a Diagnostics report from Activity.")
      : sameSchema && refresh?.state === 'refreshing'
        ? t('Wait for confirmation. If it does not arrive, open this connector in ChatGPT and choose Update all to recheck.')
      : sameSchema && refresh?.state === 'current'
        ? t('Run a tool through this connector in ChatGPT to confirm this connection.')
      : t('Choose Update all to check the installed connector tool definitions.');
    const row: ReadinessRow = { id: surface.id, label: surface.connectorName, reason, nextStep,
      schemaUnchecked: !off && functional && !verified,
      status: off ? 'skipped' : verified || (functional && refresh?.state === 'unknown') ? 'pass' : surfaceFailed || (sameSchema && refresh?.state === 'failed') ? 'fail' : 'not-run', detail };
    if (surface.id === 'desktop' && !off && connected && next.platform?.family === 'macos') {
      const permissions = [
        ...(next.config.capabilities.screen ? [{ label: 'Screen Recording: {0}', state: next.desktopAccess?.screen ?? 'unknown' }] : []),
        ...(next.config.capabilities.control && !next.config.readOnly ? [{ label: 'Accessibility: {0}', state: next.desktopAccess?.accessibility ?? 'unknown' }] : [])
      ].filter(permission => permission.state !== 'granted');
      if (permissions.length) {
        // The native backend owns these verdicts. Reading them never requests an OS grant.
        row.status = row.status === 'fail' || permissions.some(permission => permission.state === 'missing') ? 'fail' : 'not-run';
        row.reason = [row.reason, ...permissions.map(permission => t(permission.label, [t(permission.state === 'missing' ? 'required' : 'unknown')]))].filter(Boolean).join(' · ');
        row.nextStep = [row.nextStep, t('Choose Review setup to check macOS permissions, then fully quit and reopen the app.')].filter(Boolean).join(' ');
      }
    }
    rows.push(row);
  }
  return rows;
}

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
  ui(summary, 'textContent', () => ready ? schemaUnchecked ? t('Ready to use; tool definitions not fully verified') : t('All checks passed') : t('Checks incomplete'));
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
