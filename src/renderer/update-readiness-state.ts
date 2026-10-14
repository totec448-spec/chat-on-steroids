import type { AppState } from '../shared/types.js';
import { isNewer } from '../shared/types.js';
import { t } from './i18n.js';
import { updateErrorText } from './update-error.js';

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
        ? t("Let active chats finish, then reload the browser extension in your browser.")
        : appOlder ? t('Choose Update all to check for updates and update the app.')
        : t("Open ChatGPT with the browser extension enabled, then choose Review setup.") }
  ];
  const surfaces = status.surfaces ?? [];
  if (!surfaces.some(surface => surface.id === 'core')) {
    rows.push({ id: 'core', label: t("Core plugin"), status: connectionFailed ? 'fail' : 'not-run', detail: t('Not connected'),
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
      : refresh?.state === 'failed' ? t(refresh.failure !== 'confirmation' ? "Plugin check failed" : "Plugin refresh failed")
      : refresh?.state === 'refreshing' ? t('Waiting for refresh confirmation')
      : refresh?.state === 'pending' ? t('Refresh needed in ChatGPT')
      : refresh?.state !== 'current' ? t('Not verified in ChatGPT')
      : surface.lastRequestAt == null ? t('Waiting for a ChatGPT connection') : t('Verified in ChatGPT');
    const connectionDetail = surface.detail || status.detail;
    const reason = off ? undefined : !connected ? (surfaceFailed || status.state === 'disconnected') && connectionDetail ? t(connectionDetail) : undefined
      : sameSchema && refresh?.state === 'failed' ? refresh.failure === 'inspection'
        ? t("Could not inspect the installed plugin in ChatGPT.")
        : refresh.failure === 'migration' ? t("Could not verify the saved plugin against the current tool definitions.")
        : refresh.failure === 'confirmation' ? t("Could not confirm the plugin's current tool definitions in ChatGPT.") : undefined : undefined;
    const nextStep = off || verified ? undefined : !connected
      ? t('Choose Review setup to check the connection, then choose Update all to retry.')
      : sameSchema && refresh?.state === 'manual'
        ? t("In ChatGPT's plugin settings, refresh or recreate this plugin, then choose Update all to recheck.")
      : sameSchema && refresh?.state === 'failed' && refresh.failure === 'migration'
        ? t("In ChatGPT, refresh this existing plugin, then choose Update all to recheck. If Refresh is unavailable, save a Diagnostics report from Activity.")
      : sameSchema && refresh?.state === 'failed'
        ? t("Open this plugin's settings in ChatGPT, then choose Update all to recheck. If the check still fails, save a Diagnostics report from Activity.")
      : sameSchema && refresh?.state === 'refreshing'
        ? t("Wait for confirmation. If it does not arrive, open this plugin in ChatGPT and choose Update all to recheck.")
      : sameSchema && refresh?.state === 'current'
        ? t("Run a tool through this plugin in ChatGPT to confirm this connection.")
      : t("Choose Update all to check the installed plugin's tool definitions.");
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
