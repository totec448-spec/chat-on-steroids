/**
 * Packaged UI acceptance: proves the shipped renderer actually paints.
 *
 * `smoke-packaged-runtime.mjs` proves native dependency closure — it requires sharp, node-pty and
 * tree-sitter out of the packaged asar and would have caught the missing `detect-libc`. But it
 * runs the packaged binary with ELECTRON_RUN_AS_NODE=1, so there is no window, no compositor and
 * no renderer anywhere in it. It answers "do the modules load", which is why the 2026-09-17 build
 * passed packaging and still came up as a blank window: every check we had was satisfied by a
 * package whose UI never appeared.
 *
 * This adds the missing half. It loads the packaged renderer entry and preload straight out of
 * `app.asar`, under the same webPreferences the product uses, and requires three things that a
 * blank window cannot fake: the document finishes loading, the compositor produces a real frame,
 * and `capturePage` comes back with pixels that are not all one colour. The DOM check on top of
 * that distinguishes "the app's markup mounted" from "a white page painted successfully".
 *
 * It deliberately does not boot the application's main process. That bootstrap connects tunnels,
 * starts MCP servers and wakes a real Chrome for model discovery — side effects that have no
 * business running during a package smoke, and which would touch the operator's live state.
 *
 * Usage: node scripts/smoke-packaged-ui.mjs [--platform win32] [--arch x64] [--root <unpacked>]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { normalizeArch, normalizePlatform } from './packaging-targets.mjs';

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

// A renderer can only be proved on the machine that can actually run it. Cross-target packages
// are verified structurally by the runtime smoke and then on their own platform.
if (process.platform !== targetPlatform || process.arch !== targetArch) {
  process.stdout.write(`Packaged UI smoke skipped for ${targetPlatform}-${targetArch} on ${process.platform}-${process.arch}.\n`);
  process.exit(0);
}

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

const resourcesDir = targetPlatform === 'darwin'
  ? path.join(packageRoot, 'Chat On Steroids.app', 'Contents', 'Resources')
  : path.join(packageRoot, 'resources');
const asar = path.join(resourcesDir, 'app.asar');
if (!existsSync(asar)) throw new Error(`Packaged app.asar is missing at ${asar}`);

const expectedVersion = JSON.parse(readFileSync(path.join(repository, 'package.json'), 'utf8')).version;

/**
 * The harness runs inside Electron's main process. It is passed as a file rather than `-e`
 * because Electron only treats an argument as an app entry point when it is a real path.
 */
const harness = String.raw`
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const asar = process.env.COS_UI_SMOKE_ASAR;
const expectedVersion = process.env.COS_UI_SMOKE_VERSION;
const FRAME_TIMEOUT_MS = 30000;

function fail(message) {
  process.stderr.write('PACKAGED_UI_SMOKE_FAIL ' + message + '\n');
  app.exit(1);
}

// Chromium needs a real window to composite. Never take focus: this runs on the operator's
// desktop, and a smoke test that steals the foreground is its own kind of damage.
app.whenReady().then(async () => {
  const consoleErrors = [];
  let window;
  try {
    window = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      backgroundColor: '#0e0e11',
      webPreferences: {
        preload: path.join(asar, 'out', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        webSecurity: true
      }
    });

    window.webContents.on('did-fail-load', (_event, code, description) => {
      fail('packaged renderer failed to load (' + code + '): ' + description);
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      fail('packaged renderer process gone: ' + details.reason);
    });
    window.webContents.on('console-message', (details) => {
      if (details.level === 'error') consoleErrors.push(details.message);
    });

    const loaded = new Promise((resolve, reject) => {
      window.webContents.once('did-finish-load', resolve);
      setTimeout(() => reject(new Error('packaged renderer never finished loading')), FRAME_TIMEOUT_MS);
    });
    window.loadFile(path.join(asar, 'out', 'renderer', 'index.html'));
    await loaded;

    window.showInactive();

    // The single check a blank window cannot pass. requestAnimationFrame is driven by the
    // compositor, so it resolves only once frames are genuinely being produced.
    const frame = await Promise.race([
      window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => resolve(true)))', true),
      new Promise((_, reject) => setTimeout(() => reject(new Error('packaged renderer produced no frame')), FRAME_TIMEOUT_MS))
    ]);
    if (frame !== true) throw new Error('packaged renderer frame probe returned ' + JSON.stringify(frame));

    // A frame alone would also be satisfied by an empty page, so require the app's own markup.
    const dom = await window.webContents.executeJavaScript(
      '({ sidebar: !!document.getElementById("sidebar"), main: !!document.querySelector("main"), body: document.body.childElementCount })',
      true
    );
    if (!dom.sidebar || !dom.main || dom.body < 1) {
      throw new Error('packaged renderer painted without the application layout: ' + JSON.stringify(dom));
    }

    // And real pixels. A window that is composited but presenting nothing captures as a single
    // flat colour; the app's own chrome cannot.
    const image = await window.webContents.capturePage();
    const size = image.getSize();
    if (size.width < 1 || size.height < 1) throw new Error('capturePage returned an empty bitmap');
    const bitmap = image.toBitmap();
    let distinct = 0;
    const seen = new Set();
    for (let offset = 0; offset < bitmap.length; offset += 4 * 97) {
      seen.add(bitmap.readUInt32LE(offset));
      if (seen.size > 8) { distinct = seen.size; break; }
    }
    distinct = distinct || seen.size;
    if (distinct <= 1) throw new Error('packaged renderer captured a single flat colour; the UI did not paint');

    // The app's main process is deliberately not booted, so every IPC channel the preload offers
    // has no handler and the renderer's own calls reject. Those rejections are the expected cost
    // of not waking tunnels and Chrome. Anything else out of the renderer is a real packaging
    // failure and must not be waved through as "expected noise".
    const unexpected = consoleErrors.filter((message) => !/No handler registered for/.test(message));
    if (unexpected.length) {
      throw new Error('packaged renderer reported errors unrelated to the absent IPC host: ' + JSON.stringify(unexpected.slice(0, 5)));
    }

    process.stdout.write(JSON.stringify({
      version: expectedVersion,
      electron: process.versions.electron,
      frame: true,
      layout: dom,
      capture: { width: size.width, height: size.height, distinctSampledColours: distinct },
      expectedIpcGapErrors: consoleErrors.length,
      unexpectedRendererErrors: 0
    }) + '\n');
    app.exit(0);
  } catch (error) {
    fail(String(error && error.stack ? error.stack : error));
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
  }
}).catch((error) => fail(String(error && error.stack ? error.stack : error)));
`;

const require_ = createRequire(import.meta.url);
// The packaged binary is bound to its own asar and cannot be pointed at a harness, so the smoke
// uses the pinned Electron from node_modules. `smoke-packaged-runtime.mjs` separately asserts the
// packaged runtime reports exactly this version, which is what makes the two equivalent here.
const electronBinary = require_('electron');
if (typeof electronBinary !== 'string' || !existsSync(electronBinary)) {
  throw new Error('Electron binary is not materialized; run `node -e "require(\'electron\')"` first');
}

const harnessDir = path.join(repository, 'release', '.ui-smoke');
mkdirSync(harnessDir, { recursive: true });
writeFileSync(path.join(harnessDir, 'package.json'), JSON.stringify({ name: 'cos-ui-smoke', main: 'main.cjs' }));
writeFileSync(path.join(harnessDir, 'main.cjs'), harness);

// An inherited ELECTRON_RUN_AS_NODE would turn this back into the headless probe it exists to
// complement, and spawnSync stringifies `undefined` rather than dropping the key.
const environment = { ...process.env, COS_UI_SMOKE_ASAR: asar, COS_UI_SMOKE_VERSION: expectedVersion };
delete environment.ELECTRON_RUN_AS_NODE;

let result;
try {
  result = spawnSync(electronBinary, [harnessDir], { cwd: repository, encoding: 'utf8', timeout: 120_000, env: environment });
} finally {
  rmSync(harnessDir, { recursive: true, force: true });
}

if (result.error) throw result.error;
if (result.stdout) process.stdout.write(result.stdout);
// Electron logs every unhandled `invoke` to stderr itself, and with no main process there are
// several. They are expected; the harness fails the smoke on any renderer error that is not one
// of them. Say so, so a green build does not read as a broken one.
process.stdout.write("Note: \"No handler registered for ...\" is expected here; the UI smoke does not boot the app's main process.\n");
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) {
  throw new Error(`Packaged UI smoke failed for ${targetPlatform}-${targetArch} (exit ${result.status})`);
}
const report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
if (report.frame !== true || report.version !== expectedVersion) {
  throw new Error(`Packaged UI smoke returned an unusable report: ${JSON.stringify(report)}`);
}
process.stdout.write(`Packaged ${targetPlatform}-${targetArch} UI painted a real frame for ${expectedVersion}.\n`);
