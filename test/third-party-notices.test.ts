import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempDir, removeTempDir } from './helpers.js';

let root: string;
async function write(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text);
}
function generate(...args: string[]) {
  return spawnSync(process.execPath, ['scripts/generate-third-party-notices.mjs', ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
}
beforeEach(async () => {
  root = await makeTempDir('notices-');
  await write('scripts/generate-third-party-notices.mjs', await fs.readFile(new URL('../scripts/generate-third-party-notices.mjs', import.meta.url), 'utf8'));
  await write('package-lock.json', JSON.stringify({ packages: { 'node_modules/fixture': { version: '1.0.0' } } }));
  await write('node_modules/fixture/package.json', JSON.stringify({ name: 'fixture', version: '1.0.0', license: 'MIT' }));
  await write('node_modules/fixture/LICENSE', 'Fixture copyright and permission\n');
  await write('node_modules/fixture/NOTICE', 'Fixture attribution\n');
  await write('docs/licenses/plugins/inventory.json', '[]');
  await write('docs/licenses/codex/LICENSE', 'Codex license fixture\n');
  await write('docs/licenses/codex/NOTICE', 'Codex notice fixture\n');
  for (const name of ['README.md', 'COMPONENT-NOTICES.txt', 'LGPL-3.0.txt', 'GPL-3.0.txt', 'MPL-2.0.txt']) await write(`docs/licenses/native/${name}`, `Fixture ${name}\n`);
});
afterEach(async () => { await removeTempDir(root); });

it('preserves license and NOTICE text; check mode leaves the shipped inventory untouched', async () => {
  expect(generate().status).toBe(0);
  const notice = await fs.readFile(path.join(root, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
  expect(notice).toContain('Fixture copyright and permission\n');
  expect(notice).toContain('Fixture attribution\n');
  expect(notice).toContain('Codex license fixture\n');
  expect(notice).toContain('Codex notice fixture\n');
  await write('THIRD-PARTY-NOTICES.txt', 'other platform inventory');
  expect(generate('--check').status).toBe(0);
  expect(await fs.readFile(path.join(root, 'THIRD-PARTY-NOTICES.txt'), 'utf8')).toBe('other platform inventory');
});

it('rejects a manifest license label with no license or NOTICE material', async () => {
  await fs.unlink(path.join(root, 'node_modules/fixture/LICENSE'));
  await fs.unlink(path.join(root, 'node_modules/fixture/NOTICE'));
  const result = generate('--check');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Missing license texts for production packages: fixture@1.0.0');
});

it('rejects an installed package that differs from the lockfile version', async () => {
  await write('node_modules/fixture/package.json', JSON.stringify({ name: 'fixture', version: '2.0.0' }));
  expect(generate('--check').stderr).toContain('version differs from lockfile');
});

it('allows absent optional targets but rejects an invalid installed optional manifest', async () => {
  await write('package-lock.json', JSON.stringify({ packages: { 'node_modules/optional': { version: '1.0.0', optional: true } } }));
  expect(generate('--check').status).toBe(0);
  await write('node_modules/optional/package.json', '{broken');
  const result = generate('--check');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Missing or invalid production dependency');
});

it('rejects changed catalog notice bytes before publishing an inventory', async () => {
  await write('docs/licenses/plugins/inventory.json', JSON.stringify([{ package: 'fixture', version: '1.0.0', notices: [{ file: 'LICENSE', sha256: '0'.repeat(64) }] }]));
  await write('docs/licenses/plugins/LICENSE', 'changed');
  const result = generate();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Catalog license hash mismatch');
  await expect(fs.stat(path.join(root, 'THIRD-PARTY-NOTICES.txt'))).rejects.toThrow();
});
