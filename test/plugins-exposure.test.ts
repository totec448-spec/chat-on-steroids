import { expect, it } from 'vitest';
import type { Tool } from '@modelcontextprotocol/client';
import { pluginExposure, PLUGIN_MAX_SCHEMA_BYTES, PLUGIN_MAX_TOOLS, type PluginExposureSource } from '../src/main/plugins/exposure.js';

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

it('publishes catalogs larger than 64 tools when they remain within the schema byte budget', () => {
  const many = source('one', 'Many', Array.from({ length: 118 }, (_, i) => `tool_${i}`));
  expect(Buffer.byteLength(JSON.stringify(many.tools))).toBeLessThan(PLUGIN_MAX_SCHEMA_BYTES);
  const result = pluginExposure([many]);
  expect(result.tools).toEqual(many.tools);
  expect(result.owners.size).toBe(118);
  expect(result.issues.size).toBe(0);
});

it('uses the schema byte budget before the emergency tool-count ceiling', () => {
  const large: PluginExposureSource = {
    id: 'one', name: 'Large', enabled: true, disabledTools: [],
    tools: Array.from({ length: 3 }, (_, i) => ({ ...tool(`large_${i}`), description: 'x'.repeat(100000) })),
  };
  const result = pluginExposure([large]);
  expect(result.tools).toHaveLength(2);
  expect(result.owners.has('large_2')).toBe(false);
  expect(result.issues.get('one')?.get('large_2')).toContain('limit');
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

// #1870: the Plugins server serves no resources, so a tool's widget template (an MCP Apps `ui://` page,
// or ChatGPT's own output template key) would make ChatGPT read a resource that is not there, and the
// whole connector failed to enroll (-32602). Only those references leave the published copy.
it('leaves out widget resource references the Plugins server cannot serve, and nothing else (#1870)', () => {
  const page = 'ui://desktop-commander/file-preview';
  const withWidget: Tool = {
    ...tool('read_file'),
    _meta: { 'ui/resourceUri': page, 'openai/outputTemplate': page, 'openai/widgetAccessible': true,
      ui: { resourceUri: page, visibility: ['model', 'app'] }, 'openai/toolInvocation/invoking': 'Reading…', fixture: 'unchanged' },
  };
  const onlyWidget: Tool = { ...tool('list_directory'), _meta: { ui: { resourceUri: page } } };
  const otherScheme: Tool = { ...tool('start_process'), _meta: { 'openai/outputTemplate': 'https://example.test/template.html' } };
  const flagOnly: Tool = { ...tool('get_usage'), _meta: { 'openai/widgetAccessible': true, fixture: 'unchanged' } };
  const plain = tool('get_config');
  const row: PluginExposureSource = { id: 'one', name: 'Desktop Commander', enabled: true, disabledTools: [], tools: [withWidget, onlyWidget, otherScheme, flagOnly, plain] };
  const before = structuredClone(row.tools);
  const result = pluginExposure([row]);
  expect(result.tools.map(item => item.name)).toEqual(['read_file', 'list_directory', 'start_process', 'get_usage', 'get_config']);
  expect(result.tools[0]).toEqual({ ...withWidget, _meta: { ui: { visibility: ['model', 'app'] }, 'openai/toolInvocation/invoking': 'Reading…', fixture: 'unchanged' } });
  expect(result.tools[1]).toEqual({ ...onlyWidget, _meta: {} });
  // No resource of any scheme can be read from this server.
  expect(result.tools[2]).toEqual({ ...otherScheme, _meta: {} });
  // The widget flag alone says nothing ChatGPT could use without a widget, so it goes too.
  expect(result.tools[3]).toEqual({ ...flagOnly, _meta: { fixture: 'unchanged' } });
  expect(result.tools[4]).toBe(plain);
  // The installed catalog, the call owners and the Plugins screen keep the upstream declaration.
  expect(row.tools).toEqual(before);
  expect([...result.owners.keys()]).toEqual(['read_file', 'list_directory', 'start_process', 'get_usage', 'get_config']);
  expect(JSON.stringify(result.tools)).not.toContain('ui://');
});

it('counts the published copy, not the upstream declaration, against the schema budget (#1870)', () => {
  const big = (name: string): Tool => ({ ...tool(name), _meta: { 'openai/outputTemplate': `ui://x/${'p'.repeat(60000)}` } });
  const row: PluginExposureSource = { id: 'one', name: 'Big', enabled: true, disabledTools: [], tools: Array.from({ length: 6 }, (_, i) => big(`big_${i}`)) };
  expect(Buffer.byteLength(JSON.stringify(row.tools))).toBeGreaterThan(PLUGIN_MAX_SCHEMA_BYTES);
  const result = pluginExposure([row]);
  expect(result.tools).toHaveLength(6);
  expect(result.issues.size).toBe(0);
});
