import { expect, it } from 'vitest';
import { readableToolOutput, toolCommand } from '../src/renderer/tool-presentation.js';
import type { ToolCallRecord } from '../src/shared/session.js';
const call = (tool: string, args: string, result = '') => ({ tool, args: { text: args }, result: { text: result }, outcome: 'ok' }) as ToolCallRecord;
it('shows exact command text without modifying it or presenting a patch argument as output', () => {
  expect(toolCommand(call('exec_command', '{"cmd":"find . | head -30"}'))).toBe('find . | head -30');
  expect(toolCommand(call('apply_patch', '{"patch":"*** Begin Patch"}'))).toBeNull();
  expect(readableToolOutput(call('apply_patch', '{}'), '{"ok":true}')).toBe('');
});
it('uses structured terminal output and keeps execution ids and envelopes in inspection', () => {
  expect(readableToolOutput(call('exec_command', '{}', '{"structuredContent":{"output":"passed\\n","session_id":"123"}}'), 'protocol text')).toBe('passed\n');
  expect(readableToolOutput(call('exec_command', '{}'), 'Chunk ID: foo\nWall time: 1 seconds\nOutput:\n[INFO] ok')).toBe('[INFO] ok');
  expect(readableToolOutput(call('read', '{}'), '{"paths":["a"]}')).toBe('');
  expect(readableToolOutput(call('read', '{}'), '{"paths":["a"')).toBe('');
});
it('retains plain log text, errors and string results without exposing arbitrary objects', () => {
  expect(readableToolOutput(call('exec_command', '{}'), '[INFO] done')).toBe('[INFO] done');
  expect(readableToolOutput(call('read', '{}'), '{"message":"Permission denied"}')).toBe('Permission denied');
  expect(readableToolOutput(call('read', '{}'), '"hello"')).toBe('hello');
});
