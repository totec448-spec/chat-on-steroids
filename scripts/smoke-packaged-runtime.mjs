import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { RIPGREP, TUNNEL_CLIENT } from './packaging-versions.mjs';
import { normalizeArch, normalizePlatform, PLATFORM_INFO } from './packaging-targets.mjs';

const repository = path.resolve(import.meta.dirname, '..');
const releaseDir = path.join(repository, 'release');

function argValue(name, fallback) {
  const direct = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const targetPlatform = normalizePlatform(argValue('platform', process.platform));
const targetArch = normalizeArch(argValue('arch', process.arch));

function packageRootCandidates() {
  if (targetPlatform === 'win32') {
    return targetArch === 'x64'
      ? [path.join(releaseDir, 'win-unpacked'), path.join(releaseDir, 'win-x64-unpacked')]
      : [path.join(releaseDir, 'win-arm64-unpacked')];
  }
  if (targetPlatform === 'darwin') {
    return targetArch === 'x64' ? [path.join(releaseDir, 'mac'), path.join(releaseDir, 'mac-x64')] : [path.join(releaseDir, 'mac-arm64')];
  }
  return targetArch === 'x64'
    ? [path.join(releaseDir, 'linux-unpacked'), path.join(releaseDir, 'linux-x64-unpacked')]
    : [path.join(releaseDir, 'linux-arm64-unpacked')];
}

const explicitRoot = argValue('root', null);
const packageRoot = explicitRoot ? path.resolve(explicitRoot) : packageRootCandidates().find((candidate) => existsSync(candidate));
if (!packageRoot) throw new Error(`Could not find unpacked ${targetPlatform}-${targetArch} package under ${releaseDir}`);

const sourcePackage = JSON.parse(readFileSync(path.join(repository, 'package.json'), 'utf8'));
const expectedVersion = sourcePackage.version;
const expectedElectronVersion = sourcePackage.devDependencies?.electron;
if (!/^\d+\.\d+\.\d+$/.test(expectedElectronVersion ?? '')) {
  throw new Error(`Electron must be pinned to an exact release version, got ${JSON.stringify(expectedElectronVersion)}`);
}
const suffix = PLATFORM_INFO[targetPlatform].executableSuffix;
const tunnelTarget = TUNNEL_CLIENT.targets[targetPlatform][targetArch];
const upstreamOs = PLATFORM_INFO[targetPlatform].upstreamOs;
const tunnelLicenseStem = `tunnel-client-${TUNNEL_CLIENT.version}-${upstreamOs}-${tunnelTarget.upstreamArch}`;
const nativeDir = `${targetPlatform}-${targetArch}`;

let resourcesDir;
let appExecutable;
if (targetPlatform === 'darwin') {
  const appBundle = path.join(packageRoot, 'Chat On Steroids.app');
  resourcesDir = path.join(appBundle, 'Contents', 'Resources');
  appExecutable = path.join(appBundle, 'Contents', 'MacOS', 'Chat On Steroids');
} else {
  resourcesDir = path.join(packageRoot, 'resources');
  appExecutable = path.join(packageRoot, targetPlatform === 'win32' ? 'Chat On Steroids.exe' : 'chat-on-steroids');
}

function required(relative) {
  const target = path.join(resourcesDir, ...relative.split('/'));
  if (!statSync(target).isFile()) throw new Error(`Packaged runtime is missing ${relative}`);
  return target;
}

for (const relative of [
  'app.asar',
  'LICENSE',
  'extension/manifest.json',
  'extension/background.js',
  'extension/chatgpt-dom.js',
  'extension/content.js',
  'extension/fiber.js',
  'extension/overlay.css',
  'extension/popup.html',
  'extension/popup.css',
  'extension/popup.js',
  'extension/icons/icon16.png',
  'extension/icons/icon32.png',
  'extension/icons/icon48.png',
  'extension/icons/icon128.png',
  `tunnel/tunnel-client${suffix}`,
  `tunnel/cloudflared${suffix}`,
  'tunnel/VERSION',
  'tunnel/LICENSE',
  'tunnel/NOTICE',
  `tunnel/${tunnelLicenseStem}-licenses.txt`,
  `tunnel/${tunnelLicenseStem}.spdx.json`,
  `rg/rg${suffix}`,
  'rg/VERSION',
  'rg/COPYING',
  'rg/LICENSE-MIT',
  'rg/UNLICENSE',
  'app.asar.unpacked/node_modules/sharp/LICENSE',
  'app.asar.unpacked/node_modules/node-pty/LICENSE',
  'app.asar.unpacked/node_modules/tree-sitter/LICENSE',
  'app.asar.unpacked/node_modules/tree-sitter-bash/LICENSE',
  `app.asar.unpacked/node_modules/tree-sitter/prebuilds/${nativeDir}/tree-sitter.node`,
  `app.asar.unpacked/node_modules/tree-sitter-bash/prebuilds/${nativeDir}/tree-sitter-bash.node`
]) required(relative);

if (targetPlatform === 'win32') {
  required(`THIRD-PARTY-NOTICES-sharp-win32-${targetArch}.md`);
  required(`app.asar.unpacked/node_modules/@img/sharp-win32-${targetArch}/LICENSE`);
  required(`app.asar.unpacked/node_modules/node-pty/prebuilds/${nativeDir}/conpty.node`);
  required(`app.asar.unpacked/node_modules/node-pty/prebuilds/${nativeDir}/conpty_console_list.node`);
  required(`app.asar.unpacked/node_modules/node-pty/prebuilds/${nativeDir}/conpty/OpenConsole.exe`);
} else {
  required(`THIRD-PARTY-NOTICES-sharp-libvips-${targetPlatform}-${targetArch}.md`);
  required(`app.asar.unpacked/node_modules/@img/sharp-${targetPlatform}-${targetArch}/LICENSE`);
  // The pinned sharp-libvips 1.3.2 npm packages declare LGPL-3.0-or-later in package.json
  // but do not ship a LICENSE file. Require the metadata + version manifest they actually
  // publish instead of making every macOS/Linux smoke test fail on an invented file.
  required(`app.asar.unpacked/node_modules/@img/sharp-libvips-${targetPlatform}-${targetArch}/package.json`);
  required(`app.asar.unpacked/node_modules/@img/sharp-libvips-${targetPlatform}-${targetArch}/versions.json`);
  required(`app.asar.unpacked/node_modules/node-pty/prebuilds/${nativeDir}/pty.node`);
  if (targetPlatform === 'darwin') required(`app.asar.unpacked/node_modules/node-pty/prebuilds/${nativeDir}/spawn-helper`);
  if (targetPlatform === 'darwin') {
    required('desktop/macos-desktop-addon.node');
    required('desktop/libcos-desktop.dylib');
  }
}

const extensionManifest = JSON.parse(readFileSync(path.join(resourcesDir, 'extension', 'manifest.json'), 'utf8'));
if (extensionManifest.version !== expectedVersion) {
  throw new Error(`Packaged extension ${extensionManifest.version} does not match app ${expectedVersion}`);
}
const tunnelVersion = readFileSync(path.join(resourcesDir, 'tunnel', 'VERSION'), 'utf8').trim();
const rgVersion = readFileSync(path.join(resourcesDir, 'rg', 'VERSION'), 'utf8').trim();
if (tunnelVersion !== TUNNEL_CLIENT.version) throw new Error(`Packaged tunnel-client ${tunnelVersion} != ${TUNNEL_CLIENT.version}`);
if (rgVersion !== RIPGREP.version) throw new Error(`Packaged ripgrep ${rgVersion} != ${RIPGREP.version}`);

for (const packageName of readdirSync(path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', '@img')).filter((name) => name.startsWith('sharp-'))) {
  const expected = targetPlatform === 'win32'
    ? new Set([`sharp-win32-${targetArch}`])
    : new Set([`sharp-${targetPlatform}-${targetArch}`, `sharp-libvips-${targetPlatform}-${targetArch}`]);
  if (!expected.has(packageName)) throw new Error(`Packaged wrong-target Sharp payload ${packageName}`);
}

for (const dependency of ['node-pty', 'tree-sitter', 'tree-sitter-bash']) {
  const prebuilds = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', dependency, 'prebuilds');
  const directories = readdirSync(prebuilds, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (directories.length !== 1 || directories[0] !== nativeDir) {
    throw new Error(`Packaged ${dependency} prebuilds are ${directories.join(',') || '(none)'}, expected only ${nativeDir}`);
  }
}

for (const forbidden of [
  'app.asar.unpacked/node_modules/node-pty/build/Release',
  'app.asar.unpacked/node_modules/node-pty/build/Debug',
  'app.asar.unpacked/node_modules/node-pty/third_party/conpty'
]) {
  if (existsSync(path.join(resourcesDir, ...forbidden.split('/')))) {
    throw new Error(`Packaged node-pty host build leaked into target package: ${forbidden}`);
  }
}

function runExecutable(executable, args, expectedText, input) {
  const result = spawnSync(executable, args, { cwd: packageRoot, encoding: 'utf8', timeout: 15_000, input });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} exited ${result.status}: ${result.stderr || result.stdout}`);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (expectedText && !output.includes(expectedText)) throw new Error(`${executable} output did not contain ${expectedText}: ${output}`);
}

if (process.platform !== targetPlatform || process.arch !== targetArch) {
  process.stdout.write(`Packaged ${targetPlatform}-${targetArch} resources verified for ${expectedVersion}; native execution skipped on ${process.platform}-${process.arch}.\n`);
  process.exit(0);
}

runExecutable(path.join(resourcesDir, 'rg', `rg${suffix}`), ['--version'], RIPGREP.version);
runExecutable(path.join(resourcesDir, 'tunnel', `tunnel-client${suffix}`), ['--version'], TUNNEL_CLIENT.version.replace(/^v/, ''));
runExecutable(path.join(resourcesDir, 'tunnel', `cloudflared${suffix}`), ['--version']);
const probe = String.raw`
(async () => {
  const base = process.env.COS_RESOURCES_DIR;
  const sharp = require(base + '/app.asar/node_modules/sharp');
  const pty = require(base + '/app.asar/node_modules/node-pty');
  const Parser = require(base + '/app.asar/node_modules/tree-sitter');
  const Bash = require(base + '/app.asar/node_modules/tree-sitter-bash');
  const manifest = require(base + '/app.asar/package.json');
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
  const parser = new Parser();
  parser.setLanguage(Bash);
  const tree = parser.parse('echo packaged-tree-sitter');
  let desktop = null;
  if (process.platform === 'darwin') {
    const addon = require(base + '/desktop/macos-desktop-addon.node');
    addon.initialize(base + '/desktop/libcos-desktop.dylib');
    desktop = JSON.parse(addon.handle('{"op":"warm"}')).ready === true;
  }
  const win = process.platform === 'win32';
  const terminal = pty.spawn(win ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh', win ? ['/d', '/s', '/c', 'echo packaged-pty'] : ['-lc', 'printf packaged-pty'], {
    cols: 80, rows: 24, cwd: process.cwd(), env: process.env
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('node-pty packaged spawn timed out')), 10000);
    terminal.onData((data) => { output += data; });
    terminal.onExit(({ exitCode }) => { clearTimeout(timer); exitCode === 0 ? resolve() : reject(new Error('node-pty child exited ' + exitCode)); });
  });
  process.stdout.write(JSON.stringify({ version: manifest.version, electron: process.versions.electron, sharp: sharp.versions.sharp, vips: sharp.versions.vips, png: png.length, pty: output.includes('packaged-pty'), tree: tree.rootNode.type, desktop }) + '\n');
  process.exit(0);
})().catch((error) => process.stderr.write(String(error?.stack || error) + '\n', () => process.exit(1)));`;

const result = spawnSync(appExecutable, ['-e', probe], {
  cwd: packageRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', COS_RESOURCES_DIR: resourcesDir },
  encoding: 'utf8',
  timeout: 30_000
});
if (result.error) throw result.error;
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status ?? 1);
const runtime = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
if (runtime.version !== expectedVersion || runtime.electron !== expectedElectronVersion || !runtime.sharp || !runtime.vips || runtime.png <= 0 || !runtime.pty || runtime.tree !== 'program' || (targetPlatform === 'darwin' && runtime.desktop !== true)) {
  throw new Error(`Packaged native runtime probe failed: ${JSON.stringify(runtime)}`);
}
process.stdout.write(`Packaged ${targetPlatform}-${targetArch} resources and native runtimes verified for ${expectedVersion}.\n`);
