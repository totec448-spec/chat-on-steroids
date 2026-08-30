import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeArch, normalizePlatform, parseTarget } from './packaging-targets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'native', 'macos-desktop-helper', 'main.swift');
const addonRoot = path.join(root, 'native', 'macos-desktop-addon');
const electronVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).devDependencies.electron;

function targetTriple(arch) {
  return `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos12.3`;
}

export async function prepareMacOSDesktopHelper({ platform, arch }) {
  if (normalizePlatform(platform) !== 'darwin') return null;
  if (process.platform !== 'darwin') {
    throw new Error('The macOS desktop helper must be built on a native macOS runner.');
  }
  const normalizedArch = normalizeArch(arch);
  const destinationDir = path.join(root, 'resources', 'packaging', 'desktop', 'darwin', normalizedArch);
  const destination = path.join(destinationDir, 'macos-desktop-helper');
  const library = path.join(destinationDir, 'libcos-desktop.dylib');
  const addon = path.join(destinationDir, 'macos-desktop-addon.node');
  await mkdir(destinationDir, { recursive: true });
  await Promise.all([rm(destination, { force: true }), rm(library, { force: true }), rm(addon, { force: true })]);

  const swiftc = execFileSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).trim();
  const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
  execFileSync(
    swiftc,
    [
      '-O',
      '-swift-version',
      '5',
      '-parse-as-library',
      '-sdk',
      sdk,
      '-target',
      targetTriple(normalizedArch),
      source,
      '-o',
      destination,
      '-framework',
      'AppKit',
      '-framework',
      'ApplicationServices',
      '-framework',
      'Carbon',
      '-framework',
      'ScreenCaptureKit',
      '-framework',
      'CoreMedia',
      '-framework',
      'CoreImage',
      '-framework',
      'ImageIO',
      '-framework',
      'UniformTypeIdentifiers'
    ],
    { cwd: root, stdio: 'inherit' }
  );
  execFileSync(
    swiftc,
    [
      '-O',
      '-swift-version',
      '5',
      '-parse-as-library',
      '-D',
      'COS_DESKTOP_ADDON',
      '-emit-library',
      '-sdk',
      sdk,
      '-target',
      targetTriple(normalizedArch),
      source,
      '-o',
      library,
      '-framework',
      'AppKit',
      '-framework',
      'ApplicationServices',
      '-framework',
      'Carbon',
      '-framework',
      'ScreenCaptureKit',
      '-framework',
      'CoreMedia',
      '-framework',
      'CoreImage',
      '-framework',
      'ImageIO',
      '-framework',
      'UniformTypeIdentifiers'
    ],
    { cwd: root, stdio: 'inherit' }
  );

  const nodeGyp = path.join(root, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
  execFileSync(
    process.execPath,
    [
      nodeGyp,
      'rebuild',
      `--target=${electronVersion}`,
      `--arch=${normalizedArch}`,
      '--dist-url=https://electronjs.org/headers'
    ],
    { cwd: addonRoot, stdio: 'inherit' }
  );
  await copyFile(path.join(addonRoot, 'build', 'Release', 'macos_desktop_addon.node'), addon);
  await Promise.all([chmod(destination, 0o755), chmod(library, 0o755), chmod(addon, 0o755)]);

  const wanted = normalizedArch === 'arm64' ? 'arm64' : 'x86_64';
  for (const file of [destination, library, addon]) {
    const architectures = execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim().split(/\s+/);
    if (architectures.length !== 1 || architectures[0] !== wanted) {
      throw new Error(`Unexpected architecture for ${path.basename(file)}: ${architectures.join(' ')}`);
    }
  }
  process.stdout.write(`macOS ${normalizedArch} desktop helper, in-process library and Node addon built and verified.\n`);
  return destination;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = parseTarget();
  prepareMacOSDesktopHelper(target).catch((error) => {
    process.stderr.write(`\nCould not prepare the macOS desktop helper: ${error.message}\n`);
    process.exit(1);
  });
}
