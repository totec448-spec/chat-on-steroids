import { execFileSync } from 'node:child_process';
import { chmod, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeArch, normalizePlatform, parseTarget } from './packaging-targets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'native', 'macos-desktop-helper', 'main.swift');

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
  await mkdir(destinationDir, { recursive: true });
  await rm(destination, { force: true });

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
  await chmod(destination, 0o755);
  const architectures = execFileSync('lipo', ['-archs', destination], { encoding: 'utf8' }).trim().split(/\s+/);
  if (architectures.length !== 1 || architectures[0] !== (normalizedArch === 'arm64' ? 'arm64' : 'x86_64')) {
    throw new Error(`Unexpected macOS desktop helper architecture: ${architectures.join(' ')}`);
  }
  process.stdout.write(`macOS ${normalizedArch} desktop helper built and verified.\n`);
  return destination;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = parseTarget();
  prepareMacOSDesktopHelper(target).catch((error) => {
    process.stderr.write(`\nCould not prepare the macOS desktop helper: ${error.message}\n`);
    process.exit(1);
  });
}
