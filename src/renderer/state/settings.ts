import type { SettingsPatch } from '../../preload/index.js';
import type { AppState } from '../../shared/types.js';

/** The editable settings surface excludes roots and secrets; main remains their authority. */
export function settingsFromState(state: AppState): SettingsPatch {
  const config = state.config;
  return {
    capabilities: structuredClone(config.capabilities),
    readOnly: config.readOnly,
    tunnel: structuredClone(config.tunnel),
    ui: structuredClone(config.ui),
    sessions: structuredClone(config.sessions),
    compaction: structuredClone(config.compaction),
    multiAgent: structuredClone(config.multiAgent),
    goal: structuredClone(config.goal),
    mcp: structuredClone(config.mcp),
  };
}
