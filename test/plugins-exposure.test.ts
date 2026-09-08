import { expect, it } from 'vitest';
import type { Tool } from '@modelcontextprotocol/client';
import { pluginExposure, PLUGIN_MAX_TOOLS, type PluginExposureSource } from '../src/main/plugins/exposure.js';

const tool = (name: string): Tool => ({
  name, description: `Upstream ${name}`,
  inputSchema: { type: 'object', properties: { value: { $ref: '#/$defs/value' } }, $defs: { value: { type: 'string' } } },
  outputSchema: { type: 'object', properties: { result: { type: 'string' } } },
  annotations: { readOnlyHint: true }, _meta: { fixture: 'unchanged' },
});
const source = (id: string, name: string, names: string[]): PluginExposureSource => ({ id, name, enabled: true, disabledTools: [], tools: names.map(tool) });

it('publishes exact upstream names and complete schemas without IDs, prefixes or hashes', () => {
  const memory = source('opaque-installation-id', 'Knowledge Memory', ['create_entities', 'read_graph']);
  const blender = source('another-opaque-id', 'Blender MCP', ['get_scene_info']);
  const result = pluginExposure([memory, blender]);
  expect(result.tools).toEqual([...memory.tools, ...blender.tools]);
  expect(result.tools.map(tool => tool.name)).toEqual(['create_entities', 'read_graph', 'get_scene_info']);
  expect(result.owners.get('get_scene_info')).toBe(blender.id);
  expect(result.issues.size).toBe(0);
});

it('withholds every conflicting name independent of installation order and keeps other tools', () => {
  const first = source('first', 'First integration', ['shared_action', 'first_only']);
  const second = source('second', 'Second integration', ['shared_action', 'second_only']);
  for (const sources of [[first, second], [second, first]]) {
    const result = pluginExposure(sources);
    expect(result.tools.map(tool => tool.name).sort()).toEqual(['first_only', 'second_only']);
    expect(result.owners.has('shared_action')).toBe(false);
    expect(result.issues.get(first.id)?.get('shared_action')).toContain('First integration');
    expect(result.issues.get(first.id)?.get('shared_action')).toContain('Second integration');
    expect(result.issues.get(second.id)?.get('shared_action')).toContain('not exposed');
  }
});

it('retains collision ownership while a plugin or tool is disabled and releases it on uninstall', () => {
  const first = source('first', 'First', ['shared']);
  const second = source('second', 'Second', ['shared']);
  first.enabled = false;
  expect(pluginExposure([first, second]).owners.has('shared')).toBe(false);
  first.enabled = true;
  first.disabledTools = ['shared'];
  expect(pluginExposure([first, second]).owners.has('shared')).toBe(false);
  expect(pluginExposure([second]).owners.get('shared')).toBe(second.id);
});

it('does not normalize distinct upstream names into aliases and rejects duplicate declarations', () => {
  const result = pluginExposure([source('one', 'One', ['Echo.Mixed', 'echo_mixed', 'echo-mixed'])]);
  expect(result.tools.map(tool => tool.name)).toEqual(['Echo.Mixed', 'echo_mixed', 'echo-mixed']);
  const duplicate = pluginExposure([source('one', 'One', ['echo', 'echo'])]);
  expect(duplicate.tools).toEqual([]);
  expect(duplicate.owners.size).toBe(0);
  expect(duplicate.issues.get('one')?.get('echo')).toContain('conflicting');
});

it('uses the same bounded publication for discovery and callable ownership', () => {
  const result = pluginExposure([source('one', 'Many', Array.from({ length: PLUGIN_MAX_TOOLS + 1 }, (_, i) => `tool_${i}`))]);
  expect(result.tools).toHaveLength(PLUGIN_MAX_TOOLS);
  expect(result.owners.has(`tool_${PLUGIN_MAX_TOOLS}`)).toBe(false);
  expect(result.issues.get('one')?.get(`tool_${PLUGIN_MAX_TOOLS}`)).toContain('limit');
});
