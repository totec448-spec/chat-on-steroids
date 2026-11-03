import { expect, it } from 'vitest';
import { AgentOutputStream, exitSummary } from '../src/main/agent-output.js';

// The read-only view of an agent's command (#1920): what the person sees, shielded like tool results.
const key = 'sk-proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';

function collect(shield: boolean) {
  const shown: string[] = [];
  return { shown, stream: new AgentOutputStream(shield, text => shown.push(text)) };
}

it('shows the output so far at once, then whole lines, masking a key split across two chunks', () => {
  const { shown, stream } = collect(true);
  stream.start(Buffer.from('build started\n'));
  expect(shown).toEqual(['build started\n']);
  stream.push(Buffer.from(`token=${key.slice(0, 12)}`));
  stream.flush(1_000);
  // The line has no end yet: held back, so the key is not shown in two halves that both pass.
  expect(shown).toHaveLength(1);
  stream.push(Buffer.from(`${key.slice(12)}\nnext line\n`));
  stream.flush(1_100);
  expect(shown[1]).toBe('token=[redacted]\nnext line\n');
});

it('keeps a character split across chunks whole', () => {
  const { shown, stream } = collect(false);
  const text = Buffer.from('Größe ✓ done\n');
  const cut = text.indexOf(Buffer.from('✓')) + 1;
  stream.push(text.subarray(0, cut)); stream.flush(0);
  stream.push(text.subarray(cut)); stream.flush(10);
  expect(shown.join('')).toBe('Größe ✓ done\n');
});

it('shows a line without its end after a second, or once it is long, so a progress bar still moves', () => {
  const { shown, stream } = collect(false);
  stream.push(Buffer.from('Downloading 10%'));
  stream.flush(0);
  expect(shown).toEqual([]);
  stream.flush(999);
  expect(shown).toEqual([]);
  stream.flush(1_000);
  expect(shown).toEqual(['Downloading 10%']);
  stream.push(Buffer.from('x'.repeat(5_000)));
  stream.flush(1_001);
  expect(shown[1]).toHaveLength(5_000);
});

it('shows everything left when the command ends, and the key is still masked', () => {
  const { shown, stream } = collect(true);
  stream.push(Buffer.from(`last ${key}`));
  stream.flush(0, true);
  expect(shown).toEqual(['last [redacted]']);
  expect(exitSummary(1, 252_400)).toEqual({ exitCode: 1, seconds: 252 });
  expect(exitSummary(null, -5)).toEqual({ exitCode: null, seconds: 0 });
});

it('shows the key as it is when the shield is off', () => {
  const { shown, stream } = collect(false);
  stream.start(Buffer.from(`${key}\n`));
  expect(shown).toEqual([`${key}\n`]);
});
