import { expect, it } from 'vitest';
import { displayLocalServer } from '../src/renderer/local-url.js';

it('shows where the local MCP server listens without its secret path token', () => {
  expect(displayLocalServer('http://127.0.0.1:50939/mcp/core/xXy_-HyLI6MsJvThkmGmYGofp9KYLoDkmEw05gfg8kU'))
    .toBe('127.0.0.1:50939/mcp/core/…');
  expect(displayLocalServer('http://127.0.0.1:50939/mcp/desktop/abc123?x=1')).toBe('127.0.0.1:50939/mcp/desktop/…?x=1');
  expect(displayLocalServer('http://127.0.0.1:8765/health')).toBe('127.0.0.1:8765/health');
});
