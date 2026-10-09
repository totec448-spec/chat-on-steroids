import type { AppState } from '../shared/types.js';
import { $, el } from './dom.js';
import { t, ui } from './i18n.js';

interface ReadinessRow {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'not-run' | 'skipped';
  detail: string;
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
  const rows: ReadinessRow[] = [
    { id: 'app', label: 'Chat On Steroids', status: appReady ? 'pass' : update.stage === 'failed' ? 'fail' : 'not-run',
      detail: t('Version {0}', [update.current]) + ' · ' + appDetail },
    { id: 'extension', label: t('Browser extension'), status: extensionReady ? 'pass' : 'not-run',
      detail: (bridge.extensionVersion ? t('Version {0}', [bridge.extensionVersion]) + ' · ' : '') +
        (extensionReady ? t('Connected') : !bridge.present || !bridge.paired ? t('Not connected') :
          bridge.extensionVersion ? t('App and extension versions differ') : t('Version not verified')) }
  ];
  const surfaces = status.surfaces ?? [];
  if (!surfaces.some(surface => surface.id === 'core')) {
    rows.push({ id: 'core', label: t('Core connector'), status: 'not-run', detail: t('Not connected') });
  }
  for (const surface of surfaces) {
    const refresh = next.connectorRefresh?.[surface.id];
    const sameSchema = !!next.connectorSchemas?.[surface.id] && refresh?.schemaId === next.connectorSchemas[surface.id];
    const off = surface.optional && surface.state === 'off';
    const connected = surface.state === 'live' && status.state === 'connected';
    const verified = connected && surface.lastRequestAt != null && sameSchema && refresh?.state === 'current';
    const detail = off ? t('Not enabled') : !connected ? t('Not connected')
      : !sameSchema ? t('Not verified in ChatGPT')
      : refresh?.state === 'manual' ? t('Manual refresh required in ChatGPT')
      : refresh?.state === 'failed' ? t('Connector refresh failed')
      : refresh?.state === 'refreshing' ? t('Waiting for refresh confirmation')
      : refresh?.state === 'pending' ? t('Refresh needed in ChatGPT')
      : refresh?.state !== 'current' ? t('Not verified in ChatGPT')
      : surface.lastRequestAt == null ? t('Waiting for a ChatGPT connection') : t('Verified in ChatGPT');
    rows.push({ id: surface.id, label: surface.connectorName,
      status: off ? 'skipped' : verified ? 'pass' : surface.state === 'error' || (sameSchema && refresh?.state === 'failed') ? 'fail' : 'not-run', detail });
  }
  return rows;
}

export function paintUpdateReadiness(next: AppState): void {
  const rows = updateReadiness(next);
  const ready = rows.every(row => row.status === 'pass' || row.status === 'skipped');
  const summary = $('updateReadinessSummary');
  summary.dataset.ready = String(ready);
  ui(summary, 'textContent', () => ready ? t('All checks passed') : t('Checks incomplete'));
  summary.classList.toggle('is-ok', ready);
  $('updateReadinessRows').replaceChildren(...rows.map(row => {
    const item = el('li', row.status === 'pass' ? 'check is-ok' : row.status === 'fail' ? 'check is-bad' : `check is-${row.status}`);
    item.dataset.updatePart = row.id;
    const mark = el('span', 'check-mark', row.status === 'pass' ? '✓' : row.status === 'fail' ? '!' : row.status === 'skipped' ? '–' : '…');
    mark.setAttribute('aria-hidden', 'true');
    const body = el('div');
    // Re-evaluate translated copy on language changes even before the next state push.
    body.append(el('strong', '', () => updateReadiness(next).find(current => current.id === row.id)?.label ?? ''),
      el('p', '', () => updateReadiness(next).find(current => current.id === row.id)?.detail ?? ''));
    item.append(mark, body);
    return item;
  }));
}
