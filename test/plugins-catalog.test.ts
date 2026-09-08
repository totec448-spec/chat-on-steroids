import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { pluginCatalog, reviewedPluginLicense } from '../src/main/plugins/catalog.js';

it('uses reviewed transitional licenses only for the exact installed distribution', () => {
  const memory = pluginCatalog.find(recipe => recipe.id === 'memory')!;
  expect(reviewedPluginLicense(memory.source, 'MIT')).toBe(memory.license);
  expect(reviewedPluginLicense({ ...memory.source, version: '2099.1.0' }, 'New upstream terms')).toBe('New upstream terms');
  expect(reviewedPluginLicense({ ...memory.source, kind: 'python' }, 'Python terms')).toBe('Python terms');
  const fetch = pluginCatalog.find(recipe => recipe.id === 'fetch')!;
  expect(reviewedPluginLicense({ ...fetch.source, version: '2099.1.0' }, 'See installed dist-info licenses')).toBe('See installed dist-info licenses');
});

it('offers seven distinct reviewed recipes with packaged local artwork', async () => {
  expect(pluginCatalog).toHaveLength(7);
  expect(new Set(pluginCatalog.map(recipe => recipe.id)).size).toBe(pluginCatalog.length);
  for (const recipe of pluginCatalog) {
    if (recipe.source.kind === 'remote') {
      expect(recipe.source.auth).toBe('oauth');
      expect(recipe.source.url).toMatch(/^https:\/\//);
      expect(recipe.source.version).toBeUndefined();
    } else expect(recipe.source.version).toMatch(/^\d+(\.\d+)+([a-z0-9.+_-]*)$/i);
    await expect(fs.access(new URL(`../src/renderer/plugin-icons/${recipe.icon}.svg`, import.meta.url))).resolves.toBeUndefined();
  }
});

it('keeps the curated catalog focused on capabilities beyond Core file and exec tools', () => {
  expect(pluginCatalog.map(recipe => recipe.id)).toEqual([
    'blender', 'memory', 'playwright', 'fetch', 'heygen', 'recraft', 'unity',
  ]);
  for (const recipe of pluginCatalog) {
    expect(recipe.tools?.length).toBeGreaterThan(0);
    expect(new Set(recipe.tools).size).toBe(recipe.tools?.length);
    for (const field of recipe.fields) expect(field.secret).toBe(true);
    expect(recipe.source.args?.join(' ') ?? '').not.toMatch(/api.?key|token/i);
  }
});

it('preserves an exact license reference for every pinned catalog distribution', async () => {
  const directory = new URL('../docs/licenses/plugins/', import.meta.url);
  const inventory = JSON.parse(await fs.readFile(new URL('inventory.json', directory), 'utf8')) as {
    id: string; package?: string; version?: string; endpoint?: string; notices: { file: string; sha256: string }[];
  }[];
  expect(inventory.map(row => row.id).sort()).toEqual(pluginCatalog.map(row => row.id).sort());
  for (const recipe of pluginCatalog) {
    const record = inventory.find(row => row.id === recipe.id)!;
    if (recipe.source.kind === 'remote') expect(record.endpoint).toBe(recipe.source.url);
    else {
      expect(record.package).toBe(recipe.source.package);
      expect(record.version).toBe(recipe.source.version);
    }
    expect(record.notices.length).toBeGreaterThan(0);
    for (const notice of record.notices) {
      const bytes = await fs.readFile(new URL(notice.file, directory));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(notice.sha256);
    }
  }
});
