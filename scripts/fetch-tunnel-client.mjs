/**
 * Bundle the pinned tunnel-client release for one explicit packaging target.
 *
 * The release is pinned by version + SHA-256 in packaging-versions.mjs. Packaging stages
 * platform/arch-specific resources under resources/packaging; a host-target invocation also
 * mirrors the same verified files to resources/tunnel for development runs.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TUNNEL_CLIENT } from './packaging-versions.mjs';
import { parseTarget, PLATFORM_INFO } from './packaging-targets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stagingRoot = path.join(root, 'resources', 'packaging', 'tunnel');
const devOutDir = path.join(root, 'resources', 'tunnel');
const cacheDir = path.join(root, 'node_modules', '.cache', 'tunnel-client');
const say = (message) => process.stdout.write(`${message}\n`);

async function download(url, target) {
  if (existsSync(target)) return;
  const res = await fetch(url, { headers: { 'user-agent': 'chat-on-steroids-build' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  await writeFile(target, Buffer.from(await res.arrayBuffer()));
}

function extractZip(zipPath, outDir) {
  if (process.platform === 'win32') {
    execFileSync('tar.exe', ['-xf', zipPath, '-C', outDir], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', outDir], { stdio: 'inherit' });
  }
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
  const target = TUNNEL_CLIENT.targets[platform]?.[arch];
  if (!target) throw new Error(`No tunnel-client pin for ${platform}-${arch}`);

  const tag = TUNNEL_CLIENT.version;
  const upstreamOs = PLATFORM_INFO[platform].upstreamOs;
  const assetName = `tunnel-client-${tag}-${upstreamOs}-${target.upstreamArch}.zip`;
  const outDir = path.join(stagingRoot, platform, arch);
  const stamp = path.join(outDir, 'VERSION');

  await mkdir(cacheDir, { recursive: true });
  const zipPath = path.join(cacheDir, assetName);
  const url = `https://github.com/openai/tunnel-client/releases/download/${tag}/${assetName}`;
  await download(url, zipPath);

  const actual = createHash('sha256').update(await readFile(zipPath)).digest('hex');
  if (actual !== target.sha256) {
    await rm(zipPath, { force: true });
    throw new Error(`Checksum mismatch for ${assetName}\n  expected ${target.sha256}\n  got      ${actual}`);
  }
  say(`tunnel-client ${tag} ${platform}-${arch} checksum ok (${actual.slice(0, 16)}...)`);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  extractZip(zipPath, outDir);
  await flattenSingleDirectory(outDir);

  const suffix = PLATFORM_INFO[platform].executableSuffix;
  const tunnelExecutable = path.join(outDir, `tunnel-client${suffix}`);
  const cloudflaredExecutable = path.join(outDir, `cloudflared${suffix}`);
  if (!existsSync(tunnelExecutable)) throw new Error(`${path.basename(tunnelExecutable)} was not in ${assetName}`);
  if (!existsSync(cloudflaredExecutable)) throw new Error(`${path.basename(cloudflaredExecutable)} was not in ${assetName}`);
  if (platform !== 'win32') {
    await chmod(tunnelExecutable, 0o755);
    await chmod(cloudflaredExecutable, 0o755);
  }
  await writeFile(stamp, `${tag}\n`, 'utf8');
  say(`tunnel-client ${tag} ${platform}-${arch} staged`);

  if (platform === process.platform && arch === process.arch) {
    await rm(devOutDir, { recursive: true, force: true });
    await cp(outDir, devOutDir, { recursive: true });
    say(`resources/tunnel mirrors ${platform}-${arch} for development`);
  }
}

main().catch((err) => {
  process.stderr.write(`\nCould not bundle tunnel-client: ${err.message}\n`);
  process.exit(1);
});
