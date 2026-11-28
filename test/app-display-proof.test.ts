import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';

const script = path.resolve('scripts/verify-app-display-name.cjs');
const { validateProof, runDisplayNameCheck } = createRequire(import.meta.url)(script);
const directories: string[] = [];
const temporary = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'display-proof-'));
  directories.push(directory);
  return directory;
};
const states = () => ['Chat On Steroids', 'Chat On Steroids (dev)'].map((name, i) => ({
  legacy: i === 0, nativeTitle: name, rendererTitle: name, header: 'Chat On Steroids', badge: i === 0 ? null : 'DEV', errors: [] as string[]
}));
const files = ['before.png', 'after.png', 'result.json'];
async function writeProof(directory: string) {
  // Different decoded pixels, not just different bytes; real Electron supplies window captures.
  for (const [file, background] of [['before.png', '#000000'], ['after.png', '#ffffff']] as const) {
    const png = await sharp({ create: { width: 1, height: 1, channels: 4, background } }).png().toBuffer();
    writeFileSync(path.join(directory, file), png);
  }
  writeFileSync(path.join(directory, 'result.json'), JSON.stringify(states()));
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it('accepts a complete triplet and reports each artifact size', async () => {
  const directory = temporary(); await writeProof(directory);
  expect(await validateProof(directory)).toEqual(files.map(file => ({
    file: path.join(directory, file), bytes: readFileSync(path.join(directory, file)).length
  })));
});
it.each(files)('rejects missing %s', async file => {
  const directory = temporary(); await writeProof(directory); rmSync(path.join(directory, file));
  await expect(validateProof(directory)).rejects.toThrow(`Missing proof: ${file}`);
});
it.each(['before.png', 'after.png'])('rejects empty %s', async file => {
  const directory = temporary(); await writeProof(directory); writeFileSync(path.join(directory, file), '');
  await expect(validateProof(directory)).rejects.toThrow('Empty or invalid PNG');
});
it('rejects a directory masquerading as an artifact', async () => {
  const directory = temporary(); await writeProof(directory); rmSync(path.join(directory, 'result.json'));
  mkdirSync(path.join(directory, 'result.json'));
  await expect(validateProof(directory)).rejects.toThrow('Not a proof file');
});
it('rejects non-PNG bytes and identical captures', async () => {
  const directory = temporary(); await writeProof(directory); writeFileSync(path.join(directory, 'after.png'), 'not a PNG image');
  await expect(validateProof(directory)).rejects.toThrow('Invalid PNG');
  writeFileSync(path.join(directory, 'after.png'), readFileSync(path.join(directory, 'before.png')));
  await expect(validateProof(directory)).rejects.toThrow('PNGs are identical');
});
it.each(['before.png', 'after.png'])('rejects signature-only and truncated %s', async file => {
  const directory = temporary(); await writeProof(directory);
  const png = readFileSync(path.join(directory, file));
  for (const truncated of [png.subarray(0, 9), png.subarray(0, 40)]) {
    writeFileSync(path.join(directory, file), truncated);
    await expect(validateProof(directory)).rejects.toThrow(`Invalid PNG: ${file}`);
  }
});
it('rejects identical pixels with different trailing bytes before publishing or logging PASS', async () => {
  const output = temporary(); const log = vi.fn();
  await expect(runDisplayNameCheck({ output, log, render: async (directory: string) => {
    await writeProof(directory);
    const png = readFileSync(path.join(directory, 'before.png'));
    writeFileSync(path.join(directory, 'after.png'), Buffer.concat([png, Buffer.from('different bytes, identical pixels')]));
  } })).rejects.toThrow('PNGs are identical');
  expect(log).not.toHaveBeenCalled();
  expect(() => readFileSync(path.join(output, 'before.png'))).toThrow();
});
it('rejects malformed JSON, a partial result and renderer errors', async () => {
  const directory = temporary(); await writeProof(directory); const result = path.join(directory, 'result.json');
  writeFileSync(result, '{'); await expect(validateProof(directory)).rejects.toThrow();
  writeFileSync(result, JSON.stringify(states().slice(0, 1)));
  await expect(validateProof(directory)).rejects.toThrow('Both display states');
  const proof = states(); proof[1]!.errors.push('renderer failed'); writeFileSync(result, JSON.stringify(proof));
  await expect(validateProof(directory)).rejects.toThrow();
});
it.each(['nativeTitle', 'rendererTitle', 'header', 'badge'] as const)('rejects a wrong %s even with all artifacts present', async field => {
  const directory = temporary(); await writeProof(directory); const proof = states(); proof[1]![field] = 'wrong';
  writeFileSync(path.join(directory, 'result.json'), JSON.stringify(proof));
  await expect(validateProof(directory)).rejects.toThrow(field);
});
it('does not trust a zero-exit renderer or stale canonical artifacts', async () => {
  const output = temporary(); await writeProof(output); const log = vi.fn();
  await expect(runDisplayNameCheck({ output, render: () => {}, log })).rejects.toThrow('Missing proof');
  expect(log).not.toHaveBeenCalled();
});
it('exits nonzero and never prints PASS when a zero-exit capture leaves no artifacts', async () => {
  const output = temporary();
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(script)}).runDisplayNameCheck({
    output: ${JSON.stringify(output)}, render: () => {}
  }).catch(error => { console.error(error); process.exitCode = 1; })`], { encoding: 'utf8' });
  expect(result.status).not.toBe(0); expect(result.stdout).not.toContain('PASS'); expect(result.stderr).toContain('Missing proof');
});
it('prints PASS last, after validating and publishing the complete triplet', async () => {
  const output = temporary(); const log = vi.fn();
  const artifacts = await runDisplayNameCheck({ output, render: writeProof, log });
  expect(artifacts).toHaveLength(3); expect(await validateProof(output)).toEqual(artifacts);
  expect(log.mock.calls).toHaveLength(2);
  expect(JSON.parse(log.mock.calls[0]![0]).artifacts).toEqual(artifacts);
  expect(log.mock.lastCall?.[0]).toBe('PASS app-display-name: both states and all three artifacts verified');
});
