import { expect, it } from 'vitest';
import { toolResultText } from '../src/renderer/tool-result.js';

it('projects MCP text content without the protocol envelope', () => {
  expect(toolResultText(JSON.stringify({ content: [{ type: 'text', text: 'Scene: Cube' }], isError: false }), false, false)).toBe('Scene: Cube');
});
it('withholds binary content and truncated image envelopes without altering stored text', () => {
  const result = JSON.stringify({ content: [{ type: 'image', mimeType: 'image/png', data: 'a'.repeat(200) }] });
  expect(toolResultText(result, false, true)).toBe('');
  expect(toolResultText(result.slice(0, 90), true, true)).not.toContain('aaaa');
  expect(result).toContain('a'.repeat(200));
});
it('retains plain results and presents structured-only output', () => {
  expect(toolResultText('Command completed', false, false)).toBe('Command completed');
  expect(toolResultText('{"content":[],"structuredContent":{"count":3}}', false, false)).toBe('{\n  "count": 3\n}');
});
