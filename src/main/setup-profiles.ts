import { randomUUID } from 'node:crypto';
import type { Config } from '../shared/types.js';

/** Config commits the active identity and its IDs together; no copied active credential. */
export function switchSetupProfile(config: Config, id: string): Config {
  const currentId = config.tunnel.profileId ?? 'default';
  if (id === currentId) return config;
  const target = config.setupProfiles?.find(profile => profile.id === id);
  if (!target) throw new Error('Setup profile not found');
  const previous = {
    id: currentId, name: config.tunnel.profileName ?? 'Default',
    tunnelId: config.tunnel.tunnelId, desktopTunnelId: config.tunnel.desktopTunnelId,
    pluginsTunnelId: config.tunnel.pluginsTunnelId ?? ''
  };
  return {
    ...config,
    tunnel: { ...config.tunnel, profileId: target.id, profileName: target.name,
      profileEpoch: (config.tunnel.profileEpoch ?? 0) + 1,
      tunnelId: target.tunnelId, desktopTunnelId: target.desktopTunnelId, pluginsTunnelId: target.pluginsTunnelId },
    setupProfiles: [...(config.setupProfiles ?? []).filter(profile => profile.id !== id), previous]
  };
}

export function addSetupProfile(config: Config, name: string): Config {
  if ((config.setupProfiles?.length ?? 0) >= 11) throw new Error('Setup profile limit reached');
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) throw new Error('Enter a profile name (1–80 characters)');
  const id = randomUUID();
  return switchSetupProfile({ ...config, setupProfiles: [...(config.setupProfiles ?? []),
    { id, name: trimmed, tunnelId: '', desktopTunnelId: '', pluginsTunnelId: '' }] }, id);
}

/** Removing the active setup selects a surviving setup in the same config commit. */
export function removeSetupProfile(config: Config, id: string): Config {
  const currentId = config.tunnel.profileId ?? 'default';
  if (id !== currentId && !config.setupProfiles?.some(profile => profile.id === id)) {
    throw new Error('Setup profile not found');
  }
  if (!config.setupProfiles?.length) throw new Error('Keep at least one setup profile');
  const next = id === currentId ? switchSetupProfile(config, config.setupProfiles[0]!.id) : config;
  return { ...next, tunnel: { ...next.tunnel, profileEpoch: (config.tunnel.profileEpoch ?? 0) + 1 },
    setupProfiles: next.setupProfiles?.filter(profile => profile.id !== id) };
}
