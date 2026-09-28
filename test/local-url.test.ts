import { expect, it } from 'vitest';
import { displayLocalServer } from '../src/renderer/local-url.js';

it.each(['core', 'desktop', 'plugins'])('hides the %s local bearer token in Health', surface => {
  expect(displayLocalServer(`http://127.0.0.1:50939/mcp/${surface}/test-token_123`))
    .toBe(`127.0.0.1:50939/mcp/${surface}/…`);
});

it('preserves non-secret local endpoints', () => {
  expect(displayLocalServer('http://127.0.0.1:50939/mcp/desktop/abc123?x=1')).toBe('127.0.0.1:50939/mcp/desktop/…?x=1');
  expect(displayLocalServer('http://127.0.0.1:8765/health')).toBe('127.0.0.1:8765/health');
});
