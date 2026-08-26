import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  assertCompatibleMacOSDeploymentTargets,
  assertNoTrustBearingMacCodeSignature,
  withOtoolSafePath
} from './macos-audit-utils.mjs';

if (process.platform !== 'darwin') {
  throw new Error(`smoke-macos-bundle.mjs must run on macOS, got ${process.platform}`);
}

const arch = process.argv[2];
if (arch !== 'x64' && arch !== 'arm64') throw new Error(`Expected x64 or arm64, got ${arch ?? '(missing)'}`);
const expectedMachArch = arch === 'x64' ? 'x86_64' : 'arm64';
const oppositeMachArch = arch === 'x64' ? 'arm64' : 'x86_64';
const releaseDir = path.resolve('release');
const unpackedDir = arch === 'arm64' ? 'mac-arm64' : 'mac';
const app = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(releaseDir, unpackedDir, 'Chat On Steroids.app');
const contents = path.join(app, 'Contents');
const resources = path.join(contents, 'Resources');
const plist = path.join(contents, 'Info.plist');
const packageVersion = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')).version;

if (!existsSync(app)) throw new Error(`Missing packaged app: ${app}`);

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result;
}

function plistValue(key) {
  return run('plutil', ['-extract', key, 'raw', plist]).stdout.trim();
}

const expectedPlist = {
  CFBundleIdentifier: 'com.chatonsteroids.app',
  CFBundleExecutable: 'Chat On Steroids',
  CFBundleName: 'Chat On Steroids',
  CFBundleDisplayName: 'Chat On Steroids',
  CFBundleIconFile: 'icon.icns',
  CFBundleShortVersionString: packageVersion,
  CFBundleVersion: packageVersion,
  LSApplicationCategoryType: 'public.app-category.developer-tools',
  LSMinimumSystemVersion: '12.0'
};
for (const [key, expected] of Object.entries(expectedPlist)) {
  const actual = plistValue(key);
  if (actual !== expected) throw new Error(`Info.plist ${key}=${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function requireFile(file) {
  if (!statSync(file).isFile()) throw new Error(`Missing packaged file: ${file}`);
  return file;
}

function requireExecutable(file) {
  requireFile(file);
  if ((statSync(file).mode & 0o111) === 0) throw new Error(`Packaged executable bit is missing: ${file}`);
  return file;
}

function requireThinMachO(file, executable = false, minimumSystemVersion = expectedPlist.LSMinimumSystemVersion) {
  executable ? requireExecutable(file) : requireFile(file);
  const archs = run('lipo', ['-archs', file]).stdout.trim().split(/\s+/).filter(Boolean);
  if (archs.length !== 1 || archs[0] !== expectedMachArch || archs.includes(oppositeMachArch)) {
    throw new Error(`${file} has Mach-O arches ${archs.join(',') || '(none)'}, expected only ${expectedMachArch}`);
  }
  const otoolOutput = withOtoolSafePath(file, (otoolPath) => run('otool', ['-l', otoolPath]).stdout);
  assertCompatibleMacOSDeploymentTargets(file, otoolOutput, minimumSystemVersion);
}

function walkFiles(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const target = path.join(root, entry);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) files.push(...walkFiles(target));
    else if (stat.isFile()) files.push(target);
  }
  return files;
}

function isLaunchedMachO(file) {
  const normalized = file.split(path.sep).join('/');
  return normalized.includes('.app/Contents/MacOS/') || path.basename(file) === 'chrome_crashpad_handler';
}

const nativeDir = `darwin-${arch}`;
const nodeModules = path.join(resources, 'app.asar.unpacked', 'node_modules');
const mainExecutable = path.join(contents, 'MacOS', 'Chat On Steroids');
const appIcon = requireFile(path.join(resources, 'icon.icns'));
const ptyDir = path.join(nodeModules, 'node-pty', 'prebuilds', nativeDir);
const sharpLib = path.join(nodeModules, '@img', `sharp-darwin-${arch}`, 'lib');
const vipsLib = path.join(nodeModules, '@img', `sharp-libvips-darwin-${arch}`, 'lib');

const iconBytes = readFileSync(appIcon);
if (iconBytes.length < 8 || iconBytes.toString('ascii', 0, 4) !== 'icns') {
  throw new Error(`Packaged macOS icon is not an ICNS file: ${appIcon}`);
}

requireThinMachO(mainExecutable, true);
requireThinMachO(path.join(ptyDir, 'pty.node'));
requireThinMachO(path.join(ptyDir, 'spawn-helper'), true);
requireThinMachO(path.join(nodeModules, 'tree-sitter', 'prebuilds', nativeDir, 'tree-sitter.node'));
requireThinMachO(path.join(nodeModules, 'tree-sitter-bash', 'prebuilds', nativeDir, 'tree-sitter-bash.node'));

const sharpNodes = readdirSync(sharpLib).filter((name) => name.endsWith('.node'));
if (sharpNodes.length !== 1) throw new Error(`Expected one Sharp addon in ${sharpLib}, found ${sharpNodes.length}`);
requireThinMachO(path.join(sharpLib, sharpNodes[0]));

const vipsLibraries = readdirSync(vipsLib).filter((name) => name.endsWith('.dylib'));
if (vipsLibraries.length < 1) throw new Error(`No libvips dylib found in ${vipsLib}`);
for (const name of vipsLibraries) requireThinMachO(path.join(vipsLib, name));

for (const relative of ['tunnel/tunnel-client', 'tunnel/cloudflared', 'rg/rg']) {
  requireThinMachO(path.join(resources, ...relative.split('/')), true);
}

// Audit every Mach-O that actually ships, including Electron frameworks/helpers and any native
// addon we did not anticipate by filename. This catches opposite-architecture leakage and binaries
// that would silently raise the real OS floor above LSMinimumSystemVersion on an older Mac.
let machOCount = 0;
let launchedMachOCount = 0;
for (const file of walkFiles(contents)) {
  const probe = run('lipo', ['-archs', file], { allowFailure: true });
  if (probe.status !== 0) continue;
  machOCount++;
  const launched = isLaunchedMachO(file);
  if (launched) launchedMachOCount++;
  // ZIP integrity alone does not prove POSIX modes survived archive creation/extraction. In
  // particular, Electron's nested Helper.app processes and crashpad handler must remain directly
  // executable. The same bundle audit runs on the unpacked app, mounted DMG and ditto-extracted ZIP.
  requireThinMachO(file, launched);
}
if (machOCount < 8) throw new Error(`Only found ${machOCount} Mach-O files in ${app}; bundle audit is unexpectedly shallow`);
if (launchedMachOCount < 6) {
  throw new Error(`Only found ${launchedMachOCount} launchable Mach-O files in ${app}; executable-mode audit is unexpectedly shallow`);
}

// The release notes promise no publisher/Developer-ID signature. `codesign --verify --deep` is the
// wrong predicate here: a signed outer bundle with one broken nested signature would fail verify
// and look "unsigned". Conversely, Apple-Silicon executables can carry ad-hoc LC_CODE_SIGNATURE
// commands even when there is no publisher identity. Inspect the displayed identity semantics and
// the whole-bundle CodeResources envelope instead of treating every successful display as trusted.
const signature = run('codesign', ['--display', '--verbose=4', app], { allowFailure: true });
assertNoTrustBearingMacCodeSignature(
  app,
  signature,
  existsSync(path.join(contents, '_CodeSignature', 'CodeResources'))
);

process.stdout.write(
  `macOS ${arch} bundle metadata/icon, ${launchedMachOCount} launchable executable modes, ${machOCount} thin Mach-O payloads, deployment floors and unsigned policy verified.\n`
);
