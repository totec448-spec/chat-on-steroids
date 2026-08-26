/**
 * Bundle the pinned ripgrep release for one explicit packaging target.
 *
 * Windows uses the upstream zip; macOS and Linux use tar.gz releases. Linux intentionally
 * uses musl builds so the bundled rg stays portable across glibc-based distributions too.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RIPGREP } from './packaging-versions.mjs';
import { parseTarget, PLATFORM_INFO } from './packaging-targets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stagingRoot = path.join(root, 'resources', 'packaging', 'rg');
const devOutDir = path.join(root, 'resources', 'rg');
const cacheDir = path.join(root, 'node_modules', '.cache', 'ripgrep');
const say = (message) => process.stdout.write(`${message}\n`);

async function download(url, target) {
  if (existsSync(target)) return;
  const res = await fetch(url, { headers: { 'user-agent': 'chat-on-steroids-build' } });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  await writeFile(target, Buffer.from(await res.arrayBuffer()));
}

function extractArchive(archivePath, extension, outDir) {
  if (extension === 'zip') {
    if (process.platform === 'win32') execFileSync('tar.exe', ['-xf', archivePath, '-C', outDir], { stdio: 'inherit' });
    else execFileSync('unzip', ['-q', '-o', archivePath, '-d', outDir], { stdio: 'inherit' });
    return;
  }
  execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xzf', archivePath, '-C', outDir], { stdio: 'inherit' });
}

async function flattenSingleDirectory(outDir) {
  const entries = await readdir(outDir, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory()) return;
  const inner = path.join(outDir, entries[0].name);
  for (const name of await readdir(inner)) await rename(path.join(inner, name), path.join(outDir, name));
  await rm(inner, { recursive: true, force: true });
}

async function main() {
  const { platform, arch } = parseTarget();
  const target = RIPGREP.targets[platform]?.[arch];
  if (!target) throw new Error(`No ripgrep pin for ${platform}-${arch}`);

  const version = RIPGREP.version;
  const assetName = `ripgrep-${version}-${target.upstreamArch}-${target.triple}.${target.extension}`;
  const outDir = path.join(stagingRoot, platform, arch);
  const stamp = path.join(outDir, 'VERSION');

  await mkdir(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, assetName);
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${version}/${assetName}`;
  await download(url, archivePath);

  const actual = createHash('sha256').update(await readFile(archivePath)).digest('hex');
  if (actual !== target.sha256) {
    await rm(archivePath, { force: true });
    throw new Error(`Checksum mismatch for ${assetName}\n  expected ${target.sha256}\n  got      ${actual}`);
  }
  say(`ripgrep ${version} ${platform}-${arch} checksum ok (${actual.slice(0, 16)}...)`);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  extractArchive(archivePath, target.extension, outDir);
  await flattenSingleDirectory(outDir);

  const executable = path.join(outDir, `rg${PLATFORM_INFO[platform].executableSuffix}`);
  if (!existsSync(executable)) throw new Error(`${path.basename(executable)} was not in ${assetName}`);
  if (platform !== 'win32') await chmod(executable, 0o755);
  await writeFile(stamp, `${version}\n`, 'utf8');
  say(`ripgrep ${version} ${platform}-${arch} staged`);

  if (platform === process.platform && arch === process.arch) {
    await rm(devOutDir, { recursive: true, force: true });
    await cp(outDir, devOutDir, { recursive: true });
    say(`resources/rg mirrors ${platform}-${arch} for development`);
  }
}

main().catch((error) => {
  process.stderr.write(`\nCould not bundle ripgrep: ${error.message}\n`);
  process.exit(1);
});
