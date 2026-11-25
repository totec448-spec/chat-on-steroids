import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';

const script = path.resolve('scripts/verify-app-display-name.cjs');
const { validateProof, runDisplayNameCheck } = createRequire(import.meta.url)(script);
const directories: string[] = [];
const temporary = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'display-proof-'));
  directories.push(directory);
  return directory;
};
const states = () => ['Chat On Steroids', 'Chat On Steroids (dev)'].map((name, i) => ({
  legacy: i === 0, nativeTitle: name, rendererTitle: name, header: name, errors: [] as string[]
}));
const files = ['before.png', 'after.png', 'result.json'];
function writeProof(directory: string) {
  // Known one-pixel PNGs; the real-Electron check supplies actual window captures.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  writeFileSync(path.join(directory, 'before.png'), png);
  writeFileSync(path.join(directory, 'after.png'), Buffer.concat([png, Buffer.from('different capture')]));
  writeFileSync(path.join(directory, 'result.json'), JSON.stringify(states()));
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it('accepts a complete triplet and reports each artifact size', () => {
  const directory = temporary(); writeProof(directory);
  expect(validateProof(directory)).toEqual(files.map(file => ({
    file: path.join(directory, file), bytes: readFileSync(path.join(directory, file)).length
  })));
});
it.each(files)('rejects missing %s', file => {
  const directory = temporary(); writeProof(directory); rmSync(path.join(directory, file));
  expect(() => validateProof(directory)).toThrow(`Missing proof: ${file}`);
});
it.each(['before.png', 'after.png'])('rejects empty %s', file => {
  const directory = temporary(); writeProof(directory); writeFileSync(path.join(directory, file), '');
  expect(() => validateProof(directory)).toThrow('Empty or invalid PNG');
});
it('rejects a directory masquerading as an artifact', () => {
  const directory = temporary(); writeProof(directory); rmSync(path.join(directory, 'result.json'));
  mkdirSync(path.join(directory, 'result.json'));
  expect(() => validateProof(directory)).toThrow('Not a proof file');
});
it('rejects non-PNG bytes and identical captures', () => {
  const directory = temporary(); writeProof(directory); writeFileSync(path.join(directory, 'after.png'), 'not a PNG image');
  expect(() => validateProof(directory)).toThrow('Invalid PNG');
  writeFileSync(path.join(directory, 'after.png'), readFileSync(path.join(directory, 'before.png')));
  expect(() => validateProof(directory)).toThrow('PNGs are identical');
});
it('rejects malformed JSON, a partial result and renderer errors', () => {
  const directory = temporary(); writeProof(directory); const result = path.join(directory, 'result.json');
  writeFileSync(result, '{'); expect(() => validateProof(directory)).toThrow();
  writeFileSync(result, JSON.stringify(states().slice(0, 1)));
  expect(() => validateProof(directory)).toThrow('Both display states');
  const proof = states(); proof[1]!.errors.push('renderer failed'); writeFileSync(result, JSON.stringify(proof));
  expect(() => validateProof(directory)).toThrow();
});
it.each(['nativeTitle', 'rendererTitle', 'header'] as const)('rejects a wrong %s even with all artifacts present', field => {
  const directory = temporary(); writeProof(directory); const proof = states(); proof[1]![field] = 'wrong';
  writeFileSync(path.join(directory, 'result.json'), JSON.stringify(proof));
  expect(() => validateProof(directory)).toThrow(field);
});
it('does not trust a zero-exit renderer or stale canonical artifacts', () => {
  const output = temporary(); writeProof(output); const log = vi.fn();
  expect(() => runDisplayNameCheck({ output, render: () => {}, log })).toThrow('Missing proof');
  expect(log).not.toHaveBeenCalled();
});
it('exits nonzero and never prints PASS when a zero-exit capture leaves no artifacts', () => {
  const output = temporary();
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(script)}).runDisplayNameCheck({
    output: ${JSON.stringify(output)}, render: () => {}
  })`], { encoding: 'utf8' });
  expect(result.status).not.toBe(0); expect(result.stdout).not.toContain('PASS'); expect(result.stderr).toContain('Missing proof');
});
it('prints PASS last, after validating and publishing the complete triplet', () => {
  const output = temporary(); const log = vi.fn();
  const artifacts = runDisplayNameCheck({ output, render: writeProof, log });
  expect(artifacts).toHaveLength(3); expect(validateProof(output)).toEqual(artifacts);
  expect(log.mock.calls).toHaveLength(2);
  expect(JSON.parse(log.mock.calls[0]![0]).artifacts).toEqual(artifacts);
  expect(log.mock.lastCall?.[0]).toBe('PASS app-display-name: both states and all three artifacts verified');
});
