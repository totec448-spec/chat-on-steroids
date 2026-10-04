import { expect, it } from 'vitest';
import { parseCodexPluginList } from '../src/main/codex-plugin-runtime.js';

it('parses the authoritative installed plugin snapshot and preserves package provenance', () => {
  const installed = parseCodexPluginList(JSON.stringify({
    installed: [{
      pluginId: 'review-pack@team-market', name: 'review-pack', marketplaceName: 'team-market',
      version: '1.4.0', installed: true, enabled: true,
      source: { source: 'git-subdir', url: 'https://github.com/example/plugins', path: 'review', ref: 'main', sha: 'a'.repeat(40) },
      marketplaceSource: { sourceType: 'git', source: 'https://github.com/example/marketplace' },
      installPolicy: 'AVAILABLE', authPolicy: 'ON_USE'
    }],
    available: [{ pluginId: 'other@team-market', installed: false }]
  }));
  expect(installed).toEqual([{
    pluginId: 'review-pack@team-market', pluginName: 'review-pack', marketplaceName: 'team-market', version: '1.4.0',
    installed: true, enabled: true,
    source: { source: 'git-subdir', url: 'https://github.com/example/plugins', path: 'review', ref: 'main', sha: 'a'.repeat(40) },
    marketplaceSource: { sourceType: 'git', source: 'https://github.com/example/marketplace' }
  }]);
});

it('rejects inconsistent identities and unsafe runtime versions instead of selecting another cache entry', () => {
  const base = { name: 'review-pack', marketplaceName: 'team-market', installed: true, enabled: true, source: { source: 'local', path: 'C:/marketplace/review' } };
  expect(() => parseCodexPluginList(JSON.stringify({ installed: [{ ...base, pluginId: 'other@team-market', version: '1.0.0' }] }))).toThrow(/identity/i);
  expect(() => parseCodexPluginList(JSON.stringify({ installed: [{ ...base, pluginId: 'review-pack@team-market', version: '../1.0.0' }] }))).toThrow(/version/i);
});

it('keeps local provenance without exposing native source paths', () => {
  const [plugin] = parseCodexPluginList(JSON.stringify({ installed: [{
    pluginId: 'review-pack@team-market', name: 'review-pack', marketplaceName: 'team-market', version: 'local',
    installed: true, enabled: true, source: { source: 'local', path: 'C:/private/marketplace/review' },
    marketplaceSource: { sourceType: 'local', source: 'C:/private/marketplace' }
  }] }));
  expect(plugin).toMatchObject({ source: { source: 'local' }, marketplaceSource: { sourceType: 'local' } });
  expect(JSON.stringify(plugin)).not.toContain('C:/private');
});
