import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { extractBundle, resolveGithub, installSource } from '../src/main/plugins/installer.js';
import { makeTempDir, removeTempDir } from './helpers.js';
let dir: string;
beforeEach(async () => {
  dir = await makeTempDir('plugin-bundle-');
});
afterEach(async () => {
  await removeTempDir(dir);
});
const manifest = {
  manifest_version: '0.3',
  name: 'fixture',
  version: '1.0.0',
  description: 'MCP fixture',
  author: { name: 'CoS' },
  license: 'MIT',
  server: { type: 'node', entry_point: 'server.js', mcp_config: { command: 'node', args: ['${__dirname}/server.js'] } },
};
it('imports and validates a real MCPB ZIP with upstream schema tooling', async () => {
  const file = path.join(dir, 'fixture.mcpb');
  await fs.writeFile(
    file,
    zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'server.js': strToU8('console.log(1)') }),
  );
  expect(await extractBundle(file, path.join(dir, 'extracted'))).toMatchObject({ name: 'fixture', version: '1.0.0' });
  expect(await fs.readFile(path.join(dir, 'extracted', 'server.js'), 'utf8')).toBe('console.log(1)');
});
it.each(['../escape', '/absolute', 'C:/drive', 'a\\escape', 'NUL.txt', 'trailing.'])(
  'rejects unsafe archive name %s before writing',
  async (name) => {
    const file = path.join(dir, 'bad.mcpb');
    await fs.writeFile(
      file,
      zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), [name]: strToU8('unsafe') }),
    );
    await expect(extractBundle(file, path.join(dir, 'extracted'))).rejects.toThrow();
    await expect(fs.stat(path.join(dir, 'extracted'))).rejects.toThrow();
  },
);
it('rejects file/directory collisions and malformed manifests', async () => {
  const file = path.join(dir, 'bad.mcpb');
  await fs.writeFile(file, zipSync({ 'manifest.json': strToU8('{}'), a: strToU8('file'), 'a/b': strToU8('nested') }));
  await expect(extractBundle(file, path.join(dir, 'extracted'))).rejects.toThrow('collision');
});
it('resolves known GitHub recipes and explains unknown repositories', () => {
  expect(resolveGithub({ kind: 'github', url: 'https://github.com/ahujasid/blender-mcp' }).package).toBe('blender-mcp');
  expect(() => resolveGithub({ kind: 'github', url: 'https://github.com/example/unknown' })).toThrow(
    'no reviewed recipe',
  );
});
it('refuses installation package flags, URLs and floating versions', async () => {
  await expect(
    installSource({ kind: 'npm', package: '--prefix', version: 'latest' }, path.join(dir, 'install')),
  ).rejects.toThrow('package name');
  await expect(
    installSource({ kind: 'python', package: 'https://example.com', version: '1' }, path.join(dir, 'install')),
  ).rejects.toThrow('package name');
});
it.each([
  { package: '--index-url', version: '1.0.0' },
  { package: 'https://example.com/sdk', version: '1.0.0' },
  { package: 'mcp', version: '>=1,<2' },
  { package: 'mcp', version: 'latest' },
])('refuses unsafe or floating Python dependency pin %j before installation', async dependency => {
  await expect(installSource({ kind: 'python', package: 'mcp-server-fetch', version: '2025.4.7', dependencies: [dependency] }, path.join(dir, 'install'))).rejects.toThrow('Dependency pins need');
  await expect(fs.stat(path.join(dir, 'install'))).rejects.toThrow();
});
it('rejects ambiguous Python pins and pins attached to a different source kind', async () => {
  for (const dependencies of [
    [{ package: 'MCP.Server.Fetch', version: '2025.4.7' }],
    [{ package: 'some-sdk', version: '1.0.0' }, { package: 'Some_Sdk', version: '2.0.0' }],
  ]) await expect(installSource({ kind: 'python', package: 'mcp-server-fetch', version: '2025.4.7', dependencies }, path.join(dir, 'install'))).rejects.toThrow('repeat or replace');
  await expect(installSource({ kind: 'npm', package: 'fixture', version: '1.0.0', dependencies: [{ package: 'mcp', version: '1.30.0' }] }, path.join(dir, 'install'))).rejects.toThrow('Python source');
});

it.skipIf(process.platform === 'win32')('keeps npm package materialization inside its generation when an ancestor is an npm project', async () => {
  const ancestor = path.join(dir, 'home-project');
  const generation = path.join(ancestor, 'plugins', 'plugin-id', 'g-test');
  const fakeBin = path.join(dir, 'bin');
  await fs.mkdir(path.join(ancestor, 'node_modules'), { recursive: true });
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(path.join(ancestor, 'package.json'), JSON.stringify({ name: 'ancestor-project' }));

  const npm = path.join(fakeBin, 'npm');
  await fs.writeFile(npm, `#!${process.execPath}\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst args = process.argv.slice(2);\nconst prefixAt = args.indexOf('--prefix');\nlet prefix = prefixAt >= 0 ? args[prefixAt + 1] : process.cwd();\nif (prefixAt < 0) {\n  while (path.dirname(prefix) !== prefix && !fs.existsSync(path.join(prefix, 'package.json')) && !fs.existsSync(path.join(prefix, 'node_modules'))) prefix = path.dirname(prefix);\n}\nconst packageDir = path.join(prefix, 'node_modules', 'fixture-mcp');\nfs.mkdirSync(packageDir, { recursive: true });\nfs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '1.2.3', license: 'MIT', bin: 'server.js' }));\nfs.writeFileSync(path.join(packageDir, 'server.js'), '');\n`);
  await fs.chmod(npm, 0o700);

  vi.stubEnv('PATH', `${fakeBin}${path.delimiter}${path.dirname(process.execPath)}`);
  try {
    const launch = await installSource({ kind: 'npm', package: 'fixture-mcp', version: '1.2.3' }, generation);
    expect(launch.version).toBe('1.2.3');
    expect(launch.args[0]).toBe(path.join(generation, 'node_modules', 'fixture-mcp', 'server.js'));
    await expect(fs.stat(path.join(ancestor, 'node_modules', 'fixture-mcp'))).rejects.toThrow();
  } finally {
    vi.unstubAllEnvs();
  }
});
