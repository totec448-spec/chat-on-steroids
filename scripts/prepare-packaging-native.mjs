/**
 * Stage native dependencies that npm intentionally omits when the host platform/CPU differs
 * from the packaging target. node-pty and both tree-sitter packages carry all supported
 * prebuilds in one npm package; Sharp publishes target-specific optional @img packages.
 *
 * electron-builder can therefore package x64 + arm64 from one checkout only after both Sharp
 * platform packages exist on disk. Their exact URL and integrity come from package-lock.json,
 * so this does not introduce a second dependency version source.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativePrebuildDir, parseTarget, sharpPackagesFor, tarExecutableForPlatform } from './packaging-targets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, 'node_modules', '.cache', 'packaging-native');
const stagingRoot = path.join(root, 'resources', 'packaging', 'native');

const say = (message) => process.stdout.write(`${message}\n`);

function sha512FromIntegrity(integrity) {
  const match = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity ?? '');
  if (!match) throw new Error(`Unsupported package-lock integrity: ${integrity}`);
  return Buffer.from(match[1], 'base64').toString('hex');
}

async function download(url, target) {
  if (existsSync(target)) return;
  const response = await fetch(url, { headers: { 'user-agent': 'chat-on-steroids-build' } });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
}

async function fileTree(dir, relative = '', files = new Map()) {
  if (!existsSync(dir)) return files;
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await fileTree(absolute, childRelative, files);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Unexpected non-file in native package: ${childRelative}`);
    const bytes = await readFile(absolute);
    files.set(childRelative, {
      absolute,
      sha256: createHash('sha256').update(bytes).digest('hex')
    });
  }
  return files;
}

async function syncVerifiedTree(source, destination) {
  const sourceFiles = await fileTree(source);
  const destinationFiles = await fileTree(destination);
  await mkdir(destination, { recursive: true });

  for (const [relative, sourceFile] of sourceFiles) {
    const existing = destinationFiles.get(relative);
    if (existing?.sha256 === sourceFile.sha256) continue;
    const target = path.join(destination, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(sourceFile.absolute, target);
  }

  for (const [relative, destinationFile] of destinationFiles) {
    if (!sourceFiles.has(relative)) await rm(destinationFile.absolute, { force: true });
  }

  const finalFiles = await fileTree(destination);
  if (finalFiles.size !== sourceFiles.size) return false;
  for (const [relative, sourceFile] of sourceFiles) {
    if (finalFiles.get(relative)?.sha256 !== sourceFile.sha256) return false;
  }
  return true;
}

async function stageSharpPackage(lock, packageName, platform, arch) {
  const lockEntry = lock.packages?.[`node_modules/${packageName}`];
  if (!lockEntry?.version || !lockEntry.resolved || !lockEntry.integrity) {
    throw new Error(`package-lock.json has no complete ${packageName} entry`);
  }

  const destination = path.join(root, 'node_modules', ...packageName.split('/'));

  await mkdir(cacheDir, { recursive: true });
  const tarball = path.join(cacheDir, `${packageName.replace('@img/', '')}-${lockEntry.version}.tgz`);
  await download(lockEntry.resolved, tarball);

  const expected = sha512FromIntegrity(lockEntry.integrity);
  const actual = createHash('sha512').update(await readFile(tarball)).digest('hex');
  if (actual !== expected) {
    await rm(tarball, { force: true });
    throw new Error(`Integrity mismatch for ${packageName}@${lockEntry.version}`);
  }

  const extractDir = path.join(cacheDir, `extract-${packageName.replace('@img/', '')}-${lockEntry.version}`);
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  execFileSync(tarExecutableForPlatform(), ['-xzf', tarball, '-C', extractDir], { stdio: 'inherit' });

  const extracted = path.join(extractDir, 'package');
  const metadata = JSON.parse(await readFile(path.join(extracted, 'package.json'), 'utf8'));
  if (metadata.version !== lockEntry.version || !metadata.cpu?.includes(arch) || !metadata.os?.includes(platform)) {
    throw new Error(`Unexpected metadata in ${packageName}@${lockEntry.version}`);
  }

  // Materialize exactly the lockfile tarball, but leave byte-identical files untouched.
  // Windows can legitimately have libvips loaded while a developer packages the running app;
  // rewriting an already-verified DLL would fail with EPERM for no reproducibility benefit.
  if (!(await syncVerifiedTree(extracted, destination))) {
    throw new Error(`${packageName}@${lockEntry.version} could not be synchronized exactly`);
  }
  const files = await fileTree(destination);
  if (files.size === 0) throw new Error(`${packageName} extracted empty`);
  say(`${packageName} ${lockEntry.version} verified from package-lock.json`);
}

function requirePrebuild(relative) {
  const target = path.join(root, 'node_modules', ...relative.split('/'));
  if (!existsSync(target)) throw new Error(`Required native prebuild is missing: ${relative}`);
}

async function stageTargetPayload(platform, arch, sharpPackages) {
  const payloadRoot = path.join(stagingRoot, platform, arch, 'node_modules');
  await rm(path.join(stagingRoot, platform, arch), { recursive: true, force: true });
  await mkdir(payloadRoot, { recursive: true });

  for (const packageName of sharpPackages) {
    const relative = packageName.split('/');
    await cp(path.join(root, 'node_modules', ...relative), path.join(payloadRoot, ...relative), { recursive: true });
  }

  const prebuildDir = nativePrebuildDir(platform, arch);
  for (const dependency of ['node-pty', 'tree-sitter', 'tree-sitter-bash']) {
    const source = path.join(root, 'node_modules', dependency, 'prebuilds', prebuildDir);
    const destination = path.join(payloadRoot, dependency, 'prebuilds', prebuildDir);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
  }
  // node-pty launches this helper as a process on macOS. Preserve the npm tarball's executable
  // contract explicitly instead of depending on host/filesystem copy-mode behaviour.
  if (platform === 'darwin') {
    await chmod(path.join(payloadRoot, 'node-pty', 'prebuilds', prebuildDir, 'spawn-helper'), 0o755);
  }
  say(`${platform}-${arch} native packaging payload staged.`);
}

async function main() {
  const { platform, arch } = parseTarget();
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const sharpPackages = sharpPackagesFor(platform, arch);
  for (const packageName of sharpPackages) {
    await stageSharpPackage(lock, packageName, platform, arch);
  }

  const prebuildDir = nativePrebuildDir(platform, arch);
  if (platform === 'win32') {
    requirePrebuild(`node-pty/prebuilds/win32-${arch}/conpty.node`);
    requirePrebuild(`node-pty/prebuilds/win32-${arch}/conpty_console_list.node`);
    requirePrebuild(`node-pty/prebuilds/win32-${arch}/conpty/OpenConsole.exe`);
  } else {
    requirePrebuild(`node-pty/prebuilds/${prebuildDir}/pty.node`);
    if (platform === 'darwin') requirePrebuild(`node-pty/prebuilds/${prebuildDir}/spawn-helper`);
  }
  requirePrebuild(`tree-sitter/prebuilds/${prebuildDir}/tree-sitter.node`);
  requirePrebuild(`tree-sitter-bash/prebuilds/${prebuildDir}/tree-sitter-bash.node`);
  await stageTargetPayload(platform, arch, sharpPackages);
  say(`${platform}-${arch} native dependency prebuilds are ready.`);
}

main().catch((error) => {
  process.stderr.write(`\nCould not prepare native packaging dependencies: ${error.message}\n`);
  process.exit(1);
});
