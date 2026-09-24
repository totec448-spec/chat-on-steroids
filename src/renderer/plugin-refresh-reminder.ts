import type { SurfaceId } from '../shared/types.js';

const ACKNOWLEDGED_SCHEMAS_KEY = 'cos.plugins.refreshReminder.acknowledgedSchemas';
const SURFACES: readonly SurfaceId[] = ['core', 'desktop', 'plugins'];
type ConnectorSchemas = Partial<Record<SurfaceId, string>>;

let acknowledgedSchemas: ConnectorSchemas = {};
try {
  const saved = JSON.parse(window.localStorage.getItem(ACKNOWLEDGED_SCHEMAS_KEY) ?? '{}') as unknown;
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    for (const surface of SURFACES) {
      const schemaId = (saved as Record<string, unknown>)[surface];
      if (typeof schemaId === 'string' && schemaId) acknowledgedSchemas[surface] = schemaId;
    }
  }
} catch { /* Acknowledgement still works for this window when storage is unavailable. */ }

function persistAcknowledgement(): void {
  try { window.localStorage.setItem(ACKNOWLEDGED_SCHEMAS_KEY, JSON.stringify(acknowledgedSchemas)); }
  catch { /* Keep the in-memory acknowledgement for this window. */ }
}

/**
 * A reminder belongs to an exact connector declaration, never to an app-version bump.
 *
 * The first schema observed after this behavior ships becomes a silent baseline. That avoids
 * telling an upgraded user to refresh merely because the app version changed. Once a surface has
 * a baseline, a different schema id is actionable until acknowledged. Dismissing remains only a
 * UI acknowledgement; it does not claim that ChatGPT actually refreshed its cached tools.
 */
export function paintPluginRefreshReminder(currentSchemas: ConnectorSchemas): void {
  const notice = document.getElementById('pluginRefreshReminder')!;
  let changed = false;
  let learnedBaseline = false;
  for (const surface of SURFACES) {
    const current = currentSchemas[surface];
    if (!current) continue;
    const acknowledged = acknowledgedSchemas[surface];
    if (!acknowledged) {
      acknowledgedSchemas[surface] = current;
      learnedBaseline = true;
    } else if (acknowledged !== current) changed = true;
  }
  if (learnedBaseline) persistAcknowledgement();
  notice.hidden = !changed;
  document.getElementById('dismissPluginRefreshReminder')!.onclick = () => {
    for (const surface of SURFACES) {
      const current = currentSchemas[surface];
      if (current) acknowledgedSchemas[surface] = current;
    }
    persistAcknowledgement();
    notice.hidden = true;
  };
}
