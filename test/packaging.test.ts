import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-ignore js-yaml is a transitive electron-builder dependency; tests only need its runtime parser.
import { load as loadYaml } from 'js-yaml';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as packagingVersions from '../scripts/packaging-versions.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as packagingTargets from '../scripts/packaging-targets.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import { assertReleaseAbsent } from '../scripts/check-release-absent.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as macOSAuditUtils from '../scripts/macos-audit-utils.mjs';
const { RIPGREP, TUNNEL_CLIENT } = packagingVersions;
const {
  assertCompatibleMacOSDeploymentTargets,
  assertNoTrustBearingMacCodeSignature,
  macOSDeploymentTargetsFromOtool,
  withOtoolSafePath
} = macOSAuditUtils;
const {
  normalizeArch,
  normalizePlatform,
  PLATFORM_INFO,
  sharpPackagesFor,
  SUPPORTED_ARCHES,
  SUPPORTED_PLATFORMS,
  tarExecutableForPlatform,
  unpackedDirectoryPattern
} = packagingTargets;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function yamlFile(relative: string): any {
  return loadYaml(readFileSync(path.join(root, ...relative.split('/')), 'utf8'));
}

describe('cross-platform packaging targets', () => {
  it('normalizes supported OS spellings and rejects unsupported targets', () => {
    expect(normalizePlatform('windows')).toBe('win32');
    expect(normalizePlatform('macos')).toBe('darwin');
    expect(normalizePlatform('linux')).toBe('linux');
    expect(normalizeArch('x64')).toBe('x64');
    expect(normalizeArch('arm64')).toBe('arm64');
    expect(() => normalizePlatform('freebsd')).toThrow(/Unsupported packaging platform/);
    expect(() => normalizeArch('ia32')).toThrow(/Unsupported packaging architecture/);
  });

  it('pins tunnel-client and ripgrep for every release OS/CPU pair', () => {
    for (const platform of SUPPORTED_PLATFORMS) {
      for (const arch of SUPPORTED_ARCHES) {
        expect(TUNNEL_CLIENT.targets[platform][arch].sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(RIPGREP.targets[platform][arch].sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(PLATFORM_INFO[platform].builderFlag).toMatch(/^--(?:win|mac|linux)$/);
      }
    }
    expect(RIPGREP.targets.linux.x64.triple).toBe('unknown-linux-musl');
    expect(RIPGREP.targets.linux.arm64.triple).toBe('unknown-linux-musl');
  });

  it('selects only target Sharp packages and unpacked directory families', () => {
    expect(sharpPackagesFor('win32', 'x64')).toEqual(['@img/sharp-win32-x64']);
    expect(sharpPackagesFor('darwin', 'arm64')).toEqual([
      '@img/sharp-darwin-arm64',
      '@img/sharp-libvips-darwin-arm64'
    ]);
    expect(sharpPackagesFor('linux', 'x64')).toEqual([
      '@img/sharp-linux-x64',
      '@img/sharp-libvips-linux-x64'
    ]);
    expect(unpackedDirectoryPattern('win32').test('win-arm64-unpacked')).toBe(true);
    expect(unpackedDirectoryPattern('darwin').test('mac-arm64')).toBe(true);
    expect(unpackedDirectoryPattern('linux').test('linux-unpacked')).toBe(true);
    expect(unpackedDirectoryPattern('linux').test('mac-arm64')).toBe(false);
  });

  it('uses the host archive command spelling on every CI operating system', () => {
    expect(tarExecutableForPlatform('win32')).toBe('tar.exe');
    expect(tarExecutableForPlatform('darwin')).toBe('tar');
    expect(tarExecutableForPlatform('linux')).toBe('tar');
  });

  it('keeps scripts for all six release targets and legacy Windows aliases', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const script of [
      'dist', 'dist:x64', 'dist:arm64',
      'dist:mac:x64', 'dist:mac:arm64',
      'dist:linux:x64', 'dist:linux:arm64'
    ]) expect(pkg.scripts[script]).toBeTypeOf('string');
  });

  it('pins Electron 43.4.1 exactly and proves packaged runners use those runtime bytes', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const smoke = readFileSync(path.join(root, 'scripts', 'smoke-packaged-runtime.mjs'), 'utf8');

    expect(pkg.devDependencies.electron).toBe('43.4.1');
    expect(lock.packages?.['']?.devDependencies?.electron).toBe('43.4.1');
    expect(lock.packages?.['node_modules/electron']?.version).toBe('43.4.1');
    expect(smoke).toContain('const expectedElectronVersion = sourcePackage.devDependencies?.electron;');
    expect(smoke).toContain('electron: process.versions.electron');
    expect(smoke).toContain('runtime.electron !== expectedElectronVersion');
  });

  it('assembles every platform artifact in the reusable release workflow', () => {
    const workflow = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    const parsed = yamlFile('.github/workflows/release.yml');
    const matrix = parsed.jobs.package.strategy.matrix.include;
    expect(matrix).toHaveLength(6);
    expect(matrix).toEqual([
      {
        name: 'Windows x64', platform: 'win32', arch: 'x64', runner: 'windows-2025',
        script: 'dist:x64', artifact: 'package-windows-x64', files: 'release/Chat-On-Steroids-Setup-x64.exe'
      },
      {
        name: 'Windows arm64', platform: 'win32', arch: 'arm64', runner: 'windows-11-arm',
        script: 'dist:arm64', artifact: 'package-windows-arm64', files: 'release/Chat-On-Steroids-Setup-arm64.exe'
      },
      {
        name: 'macOS x64', platform: 'darwin', arch: 'x64', runner: 'macos-15-intel',
        script: 'dist:mac:x64', artifact: 'package-macos-x64',
        files: 'release/Chat-On-Steroids-macOS-x64.dmg\nrelease/Chat-On-Steroids-macOS-x64.zip\n'
      },
      {
        name: 'macOS arm64', platform: 'darwin', arch: 'arm64', runner: 'macos-15',
        script: 'dist:mac:arm64', artifact: 'package-macos-arm64',
        files: 'release/Chat-On-Steroids-macOS-arm64.dmg\nrelease/Chat-On-Steroids-macOS-arm64.zip\n'
      },
      {
        name: 'Linux x64', platform: 'linux', arch: 'x64', runner: 'ubuntu-24.04',
        script: 'dist:linux:x64', artifact: 'package-linux-x64',
        files: 'release/Chat-On-Steroids-Linux-x64.AppImage\nrelease/Chat-On-Steroids-Linux-x64.deb\n'
      },
      {
        name: 'Linux arm64', platform: 'linux', arch: 'arm64', runner: 'ubuntu-24.04-arm',
        script: 'dist:linux:arm64', artifact: 'package-linux-arm64',
        files: 'release/Chat-On-Steroids-Linux-arm64.AppImage\nrelease/Chat-On-Steroids-Linux-arm64.deb\n'
      }
    ]);
    expect(parsed.jobs.package['runs-on']).toBe('${{ matrix.runner }}');
    expect(workflow).toContain('name: chat-on-steroids-candidate-${{ github.run_id }}');
    expect(workflow).toContain('Install generated DEB on target distro');
    expect(workflow).toContain('Launch installed DEB normally under Xvfb');
    expect(workflow).toContain('CLF_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a /usr/bin/chat-on-steroids');
    expect(workflow).toContain('Execute generated static-runtime AppImage');
    expect(workflow).toContain('Verify generated macOS archives');
    expect(workflow).toContain('hdiutil verify "$dmg"');
    expect(workflow).toContain('codesign --display --verbose=4 "$dmg" >dmg-codesign.log 2>&1');
    expect(workflow).toContain('dmg_codesign_status=$?');
    expect(workflow).toContain("grep -Eqi 'code object is not signed( at all)?' dmg-codesign.log");
    expect(workflow).toContain('test -L "$mount_dir/Applications"');
    expect(workflow).toContain('test "$(readlink "$mount_dir/Applications")" = /Applications');
    expect(workflow).toContain('ditto -x -k "$zip" "$zip_dir"');
    expect(workflow).toContain("node scripts/smoke-macos-bundle.mjs '${{ matrix.arch }}' \"$mount_dir/Chat On Steroids.app\"");
    expect(workflow).toContain("node scripts/smoke-macos-bundle.mjs '${{ matrix.arch }}' \"$zip_dir/Chat On Steroids.app\"");
    expect(workflow).toContain('Audit packaged macOS bundle metadata and Mach-O payloads');
    expect(workflow).toContain('node scripts/smoke-macos-bundle.mjs ${{ matrix.arch }}');
    expect(workflow).toContain('Launch packaged macOS app normally');
    expect(workflow).toContain('node scripts/smoke-macos-gui.mjs ${{ matrix.arch }}');
    expect(workflow).toContain('architecture: ${{ matrix.arch }}');

    const macGui = workflow.slice(
      workflow.indexOf('      - name: Launch packaged macOS app normally'),
      workflow.indexOf('      - name: Install generated DEB on target distro')
    );
    expect(macGui).toContain('node scripts/smoke-macos-gui.mjs ${{ matrix.arch }}');
    expect(macGui).not.toContain('ELECTRON_RUN_AS_NODE');

    const macGuiScript = readFileSync(path.join(root, 'scripts', 'smoke-macos-gui.mjs'), 'utf8');
    expect(macGuiScript).toContain("CLF_DEBUG: '1'");
    expect(macGuiScript).toContain("output.includes('[info] app started')");
    expect(macGuiScript).toContain("output.includes('[info] window loaded')");
    expect(macGuiScript).toContain("output.includes('[info] renderer state ready')");
    expect(macGuiScript).toContain("output.includes('[error] window failed to load')");
    expect(macGuiScript).toContain("output.includes('[error] renderer:')");
    expect(macGuiScript).toContain('minimumSurvivalMs = 10_000');
    expect(macGuiScript).toContain('startupDeadlineMs = 15_000');
    expect(macGuiScript).toContain("child.kill('SIGTERM')");
    expect(macGuiScript).toContain("child.kill('SIGKILL')");
    expect(macGuiScript).not.toContain('ELECTRON_RUN_AS_NODE');

    const debGui = workflow.slice(
      workflow.indexOf('      - name: Launch installed DEB normally under Xvfb'),
      workflow.indexOf('      - name: Execute generated static-runtime AppImage')
    );
    expect(workflow).toContain('sudo apt-get install -y --no-install-recommends xvfb xauth');
    expect(workflow).toContain("grep -Fxq 'Name=Chat On Steroids' \"$desktop\"");
    expect(workflow).toContain("grep -Fxq 'Icon=chat-on-steroids' \"$desktop\"");
    expect(debGui).toContain('deb_smoke_root="$(mktemp -d)"');
    expect(debGui).toContain("trap 'rm -rf \"$deb_smoke_root\"' EXIT");
    expect(debGui).toContain('HOME="$deb_smoke_root/home"');
    expect(debGui).toContain('XDG_CONFIG_HOME="$deb_smoke_root/config"');
    expect(debGui).toContain('XDG_CACHE_HOME="$deb_smoke_root/cache"');
    expect(debGui).toContain('XDG_DATA_HOME="$deb_smoke_root/data"');
    expect(debGui).toContain('XDG_STATE_HOME="$deb_smoke_root/state"');
    expect(debGui).toContain('xvfb-run -a /usr/bin/chat-on-steroids');
    expect(debGui).toContain('--kill-after=5s 12s');
    expect(debGui).toContain("grep -Fq '[info] app started' deb-gui.log");
    expect(debGui).toContain("grep -Fq '[info] window loaded' deb-gui.log");
    expect(debGui).toContain("grep -Fq '[info] renderer state ready' deb-gui.log");
    expect(debGui).toContain("grep -Fq '[error] window failed to load' deb-gui.log");
    expect(debGui).toContain("grep -Fq '[error] renderer:' deb-gui.log");
    expect(debGui).not.toContain('ELECTRON_RUN_AS_NODE');

    const appImageGui = workflow.slice(
      workflow.indexOf('      - name: Execute generated static-runtime AppImage'),
      workflow.indexOf('      - name: Upload package artifacts')
    );
    expect(appImageGui).toContain('xvfb-run -a "$appimage"');
    expect(appImageGui).toContain('normal_smoke_root="$(mktemp -d)"');
    expect(appImageGui).toContain('fallback_smoke_root="$(mktemp -d)"');
    expect(appImageGui).toContain('rm -rf "$fake_bin" "$normal_smoke_root" "$fallback_smoke_root"');
    expect(appImageGui).toContain('HOME="$smoke_root/home"');
    expect(appImageGui).toContain('XDG_CONFIG_HOME="$smoke_root/config"');
    expect(appImageGui).toContain('XDG_CACHE_HOME="$smoke_root/cache"');
    expect(appImageGui).toContain('XDG_DATA_HOME="$smoke_root/data"');
    expect(appImageGui).toContain('XDG_STATE_HOME="$smoke_root/state"');
    expect(appImageGui).toContain("printf '#!/bin/sh\\nexit 1\\n' > \"$fake_bin/unshare\"");
    expect(appImageGui).toContain('PATH="$launch_path"');
    expect(appImageGui).toContain('CLF_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a "$appimage" >"$log"');
    expect(appImageGui).toContain("grep -Fq '[info] app started' \"$log\"");
    expect(appImageGui).toContain("grep -Fq '[info] window loaded' \"$log\"");
    expect(appImageGui).toContain("grep -Fq '[info] renderer state ready' \"$log\"");
    expect(appImageGui).toContain("grep -Fq '[error] window failed to load' \"$log\"");
    expect(appImageGui).toContain("grep -Fq '[error] renderer:' \"$log\"");
    expect(appImageGui).toContain('run_appimage_smoke normal "$normal_smoke_root" "$PATH" appimage-normal-gui.log');
    expect(appImageGui).toContain('run_appimage_smoke forced-fallback "$fallback_smoke_root" "$fake_bin:$PATH" appimage-fallback-gui.log');
    expect(appImageGui.replace(/^\s*#.*$/gm, '')).not.toContain('ELECTRON_RUN_AS_NODE');
  });

  it('only reports renderer readiness after the initial state snapshot has completed', () => {
    const ipc = readFileSync(path.join(root, 'src', 'main', 'ipc.ts'), 'utf8');
    const handler = ipc.indexOf("handle('state:get', async () => {");
    const state = ipc.indexOf('const state = await buildState();', handler);
    const ready = ipc.indexOf("logInfo('renderer state ready');", state);
    const returned = ipc.indexOf('return state;', ready);

    expect(handler).toBeGreaterThan(-1);
    expect(state).toBeGreaterThan(handler);
    expect(ready).toBeGreaterThan(state);
    expect(returned).toBeGreaterThan(ready);
  });

  it('keeps a losing second instance out of the async primary bootstrap', () => {
    const main = readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
    const lock = main.indexOf('const hasSingleInstanceLock = app.requestSingleInstanceLock();');
    const losingBranch = main.indexOf('if (!hasSingleInstanceLock) {', lock);
    const markQuitting = main.indexOf('quitting = true;', losingBranch);
    const ready = main.indexOf('void app.whenReady().then(async () => {', losingBranch);
    const readyGuard = main.indexOf('if (!shouldBeginAppBootstrap(hasSingleInstanceLock, quitting)) return;', ready);
    const firstSharedStateRead = main.indexOf("const userData = app.getPath('userData');", ready);

    expect(lock).toBeGreaterThan(-1);
    expect(losingBranch).toBeGreaterThan(lock);
    expect(markQuitting).toBeGreaterThan(losingBranch);
    expect(markQuitting).toBeLessThan(ready);
    expect(readyGuard).toBeGreaterThan(ready);
    expect(readyGuard).toBeLessThan(firstSharedStateRead);

    const beforeQuit = main.indexOf("app.on('before-quit', () => {");
    const beforeQuitOwner = main.indexOf('if (!ownsAppRuntime(hasSingleInstanceLock)) return;', beforeQuit);
    const beforeQuitMutation = main.indexOf('quitting = true;', beforeQuit);
    const windowAllClosed = main.indexOf("app.on('window-all-closed', () => {");
    const windowAllOwner = main.indexOf('if (!ownsAppRuntime(hasSingleInstanceLock)) return;', windowAllClosed);
    const windowAllConfig = main.indexOf('getConfig().ui.minimizeToTray', windowAllClosed);
    const willQuit = main.indexOf("app.on('will-quit', (event) => {");
    const willQuitOwner = main.indexOf('if (!ownsAppRuntime(hasSingleInstanceLock)) return;', willQuit);
    const preventDefault = main.indexOf('event.preventDefault();', willQuit);

    expect(beforeQuitOwner).toBeGreaterThan(beforeQuit);
    expect(beforeQuitOwner).toBeLessThan(beforeQuitMutation);
    expect(windowAllOwner).toBeGreaterThan(windowAllClosed);
    expect(windowAllOwner).toBeLessThan(windowAllConfig);
    expect(willQuitOwner).toBeGreaterThan(willQuit);
    expect(willQuitOwner).toBeLessThan(preventDefault);
  });

  it('applies the persisted native theme before the first packaged BrowserWindow can be created', () => {
    const main = readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
    const ready = main.indexOf('void app.whenReady().then(async () => {');
    const loadConfig = main.indexOf('await loadConfig();', ready);
    const theme = main.indexOf('nativeTheme.themeSource = getConfig().ui.theme;', loadConfig);
    const enableActivation = main.indexOf('windowActivation.enable();', theme);
    const firstWindowRequest = main.indexOf('windowActivation.request();', enableActivation);

    expect(ready).toBeGreaterThan(-1);
    expect(loadConfig).toBeGreaterThan(ready);
    expect(theme).toBeGreaterThan(loadConfig);
    expect(enableActivation).toBeGreaterThan(theme);
    expect(firstWindowRequest).toBeGreaterThan(enableActivation);

    const ipc = readFileSync(path.join(root, 'src', 'main', 'ipc.ts'), 'utf8');
    const save = ipc.indexOf("handle('settings:save', async (payload) => {");
    const liveTheme = ipc.indexOf('nativeTheme.themeSource = next.ui.theme;', save);
    const background = ipc.indexOf("getWindow()?.setBackgroundColor(next.ui.theme === 'dark' ? '#0e0e11' : '#ffffff');", liveTheme);
    expect(save).toBeGreaterThan(-1);
    expect(liveTheme).toBeGreaterThan(save);
    expect(background).toBeGreaterThan(liveTheme);
  });

  it('uses Noble-compatible Linux packages and a FUSE-independent AppImage runtime', () => {
    const builder = yamlFile('electron-builder.yml');
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const iconScript = readFileSync(path.join(root, 'scripts', 'make-icon.mjs'), 'utf8');
    expect(builder.toolsets.appimage).toBe('1.0.3');
    expect(builder.linux.artifactName).toBe('Chat-On-Steroids-Linux-${env.COS_PACKAGE_ARCH}.${ext}');
    expect(builder.deb.depends).toContain('libgtk-3-0 | libgtk-3-0t64');
    expect(builder.deb.depends).toContain('libatspi2.0-0 | libatspi2.0-0t64');
    expect(builder.linux.syncDesktopName).toBe(true);
    expect(builder.linux.maintainer).toMatch(/^Chat On Steroids <[^>]+@users\.noreply\.github\.com>$/);
    expect(pkg.desktopName).toBe('com.chatonsteroids.app.desktop');
    expect(pkg.homepage).toBe('https://github.com/totec448-spec/chat-on-steroids');
    expect(iconScript).toContain("build', 'icon.png'), pngFor(1024)");

    const packageScript = readFileSync(path.join(root, 'scripts', 'package.mjs'), 'utf8');
    expect(packageScript).toContain('COS_PACKAGE_ARCH: arch');
    const releaseWorkflow = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(releaseWorkflow).toContain('HOME="$deb_smoke_root/home"');
    expect(releaseWorkflow).toContain('HOME="$smoke_root/home"');
    expect(releaseWorkflow).toContain('PATH="$launch_path"');
    expect(releaseWorkflow).toContain('run_appimage_smoke normal "$normal_smoke_root" "$PATH" appimage-normal-gui.log');
    expect(releaseWorkflow).toContain('run_appimage_smoke forced-fallback "$fallback_smoke_root" "$fake_bin:$PATH" appimage-fallback-gui.log');
    expect(releaseWorkflow).toContain('CLF_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a "$appimage" >"$log"');
    expect(releaseWorkflow).toContain('CLF_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a /usr/bin/chat-on-steroids');
    expect(releaseWorkflow).toContain("grep -Fq '[info] app started' \"$log\"");
    expect(releaseWorkflow).toContain("grep -Fq '[info] window loaded' \"$log\"");
    expect(releaseWorkflow).toContain("test \"$(dpkg-deb --field \"$deb\" Package)\" = chat-on-steroids");
    expect(releaseWorkflow).toContain("test \"$(dpkg-deb --field \"$deb\" Version)\" = \"$(node -p \"require('./package.json').version\")\"");
    expect(releaseWorkflow).toContain('expected_deb_arch=amd64');
    expect(releaseWorkflow).toContain('test -L /usr/bin/chat-on-steroids');
    expect(releaseWorkflow).toContain('installed_executable="$(readlink -f /usr/bin/chat-on-steroids)"');
    expect(releaseWorkflow).toContain('test -x "$installed_executable"');
    expect(releaseWorkflow).toContain('dpkg-query -S "$installed_executable"');
    expect(releaseWorkflow).toContain("node scripts/smoke-packaged-runtime.mjs --platform linux --arch '${{ matrix.arch }}' --root \"$(dirname \"$installed_executable\")\"");
    expect(releaseWorkflow).toContain('node scripts/smoke-macos-gui.mjs ${{ matrix.arch }}');

    const appImageSection = releaseWorkflow.slice(
      releaseWorkflow.indexOf('      - name: Execute generated static-runtime AppImage'),
      releaseWorkflow.indexOf('      - name: Upload package artifacts')
    );
    expect(appImageSection.replace(/^\s*#.*$/gm, '')).not.toContain('ELECTRON_RUN_AS_NODE');

    const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
    const security = readFileSync(path.join(root, 'SECURITY.md'), 'utf8');
    const notes = readFileSync(path.join(root, 'docs', 'release-notes', 'v2.0.2.md'), 'utf8');
    for (const document of [readme, security, notes]) {
      expect(document).toContain('--no-sandbox');
      expect(document).toMatch(/unprivileged user namespaces/i);
    }
  });

  it('keeps the static AppImage sandbox fallback conditional and duplicate-safe', () => {
    // Read the shipped template rather than requiring app-builder-lib to render it. The
    // assertions below are on the template's own text, so loading that dependency graph buys
    // no coverage and is the reason this case could hit the global 30s timeout under full-suite
    // contention while passing in about 1.5s alone.
    const source = readFileSync(
      path.join(root, 'node_modules', 'app-builder-lib', 'out', 'targets', 'appimage', 'appImageUtil.js'),
      'utf8'
    );

    expect(source).toContain('HAVE_NO_SANDBOX=0');
    expect(source).toContain('if [ "$arg" = --no-sandbox ] ; then');
    expect(source).toContain('if [ $HAVE_NO_SANDBOX -eq 0 ] && ! unshare -Ur true 2>/dev/null ; then');
    expect(source).toContain('NO_SANDBOX=(--no-sandbox)');
    expect(source).toContain('exec "$BIN" "\\${NO_SANDBOX[@]}" "\\${args[@]}"');
  });

  it('pins the current macOS release to unsigned thin native bundles with explicit metadata checks', () => {
    const builder = yamlFile('electron-builder.yml');
    const macSmoke = readFileSync(path.join(root, 'scripts', 'smoke-macos-bundle.mjs'), 'utf8');
    expect(builder.mac.identity).toBeNull();
    expect(builder.mac.notarize).toBe(false);
    expect(builder.mac.category).toBe('public.app-category.developer-tools');
    expect(builder.mac.minimumSystemVersion).toBe('12.0');
    expect(builder.mac.artifactName).toBe('Chat-On-Steroids-macOS-${arch}.${ext}');
    const nativePrep = readFileSync(path.join(root, 'scripts', 'prepare-packaging-native.mjs'), 'utf8');
    expect(nativePrep).toContain("await chmod(path.join(payloadRoot, 'node-pty', 'prebuilds', prebuildDir, 'spawn-helper'), 0o755)");
    for (const marker of [
      "CFBundleIdentifier: 'com.chatonsteroids.app'",
      "CFBundleExecutable: 'Chat On Steroids'",
      "CFBundleName: 'Chat On Steroids'",
      "CFBundleDisplayName: 'Chat On Steroids'",
      "CFBundleIconFile: 'icon.icns'",
      'CFBundleShortVersionString: packageVersion',
      'CFBundleVersion: packageVersion',
      "LSApplicationCategoryType: 'public.app-category.developer-tools'",
      "LSMinimumSystemVersion: '12.0'",
      "path.join(ptyDir, 'spawn-helper')",
      "path.join(nodeModules, 'tree-sitter', 'prebuilds'",
      "path.join(nodeModules, 'tree-sitter-bash', 'prebuilds'",
      "relative of ['tunnel/tunnel-client', 'tunnel/cloudflared', 'rg/rg']",
      "run('lipo', ['-archs', file])",
      "withOtoolSafePath(file, (otoolPath) => run('otool', ['-l', otoolPath]).stdout)",
      'walkFiles(contents)',
      "normalized.includes('.app/Contents/MacOS/')",
      "path.basename(file) === 'chrome_crashpad_handler'",
      'requireThinMachO(file, launched)',
      'launchedMachOCount < 6',
      "run('plutil', ['-extract', key, 'raw', plist])",
      "run('codesign', ['--display', '--verbose=4', app]",
      'assertNoTrustBearingMacCodeSignature(',
      "path.join(contents, '_CodeSignature', 'CodeResources')"
    ]) expect(macSmoke).toContain(marker);
    expect(macSmoke).toContain("requireFile(path.join(resources, 'icon.icns'))");
    expect(macSmoke).toContain("iconBytes.toString('ascii', 0, 4) !== 'icns'");

    const packagedRuntime = readFileSync(path.join(root, 'scripts', 'smoke-packaged-runtime.mjs'), 'utf8');
    expect(packagedRuntime).toContain("for (const dependency of ['node-pty', 'tree-sitter', 'tree-sitter-bash'])");
    expect(packagedRuntime).toContain('directories.length !== 1 || directories[0] !== nativeDir');

    const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
    const notes = readFileSync(path.join(root, 'docs', 'release-notes', 'v2.0.2.md'), 'utf8');
    expect(readme).toContain('macOS 12 Monterey or newer');
    expect(notes).toContain('macOS 12');
    expect(notes).toContain('Monterey or newer');
  });

  it('hides Electron helper parentheses from otool-classic without changing the inspected file', () => {
    const file = '/Applications/Chat On Steroids.app/Contents/Frameworks/Chat On Steroids Helper (GPU).app/Contents/MacOS/Chat On Steroids Helper (GPU)';
    const calls: Array<{ kind: string; args: unknown[] }> = [];
    const result = withOtoolSafePath(
      file,
      (safePath: string) => {
        calls.push({ kind: 'inspect', args: [safePath] });
        expect(path.basename(safePath)).toBe('payload');
        expect(safePath).not.toMatch(/[()]/);
        return 'otool-output';
      },
      {
        tmpdir: '/tmp',
        mkdtempSync: (prefix: string) => {
          calls.push({ kind: 'mkdtemp', args: [prefix] });
          return '/tmp/cos-otool-safe';
        },
        symlinkSync: (target: string, alias: string) => {
          calls.push({ kind: 'symlink', args: [target, alias] });
        },
        rmSync: (target: string, options: unknown) => {
          calls.push({ kind: 'remove', args: [target, options] });
        }
      }
    );

    expect(result).toBe('otool-output');
    const safePrefix = path.join('/tmp', 'cos-otool-');
    const safeDirectory = '/tmp/cos-otool-safe';
    const safePayload = path.join(safeDirectory, 'payload');
    expect(calls).toEqual([
      { kind: 'mkdtemp', args: [safePrefix] },
      { kind: 'symlink', args: [file, safePayload] },
      { kind: 'inspect', args: [safePayload] },
      { kind: 'remove', args: [safeDirectory, { recursive: true, force: true }] }
    ]);
  });

  it('rejects Mach-O payloads whose deployment target exceeds the declared macOS floor', () => {
    const modern = `
Load command 10
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 1
    minos 11.0
      sdk 15.0
Load command 11
      cmd LC_VERSION_MIN_MACOSX
  cmdsize 16
  version 10.15
      sdk 11.0
`;
    expect(macOSDeploymentTargetsFromOtool(modern)).toEqual(['11.0', '10.15']);
    expect(() => assertCompatibleMacOSDeploymentTargets('good.node', modern, '12.0')).not.toThrow();

    const tooNew = modern.replace('minos 11.0', 'minos 13.0');
    expect(() => assertCompatibleMacOSDeploymentTargets('bad.node', tooNew, '12.0')).toThrow(
      /requires macOS 13\.0, newer than Info\.plist LSMinimumSystemVersion 12\.0/
    );
    expect(() => assertCompatibleMacOSDeploymentTargets('missing.node', 'Load command 1\n cmd LC_SEGMENT_64', '12.0')).toThrow(
      /no macOS deployment target load command/
    );
  });

  it('allows Apple-Silicon ad-hoc signatures but rejects publisher-bearing macOS signatures', () => {
    expect(() => assertNoTrustBearingMacCodeSignature('unsigned.app', {
      status: 1,
      stdout: '',
      stderr: 'code object is not signed at all'
    })).not.toThrow();
    expect(() => assertNoTrustBearingMacCodeSignature('adhoc.app', {
      status: 0,
      stdout: '',
      stderr: 'Identifier=com.example\nSignature=adhoc\nTeamIdentifier=not set\n'
    })).not.toThrow();

    expect(() => assertNoTrustBearingMacCodeSignature('developer-id.app', {
      status: 0,
      stdout: '',
      stderr: 'Signature size=9000\nAuthority=Developer ID Application: Example Corp (TEAM123456)\nTeamIdentifier=TEAM123456\n'
    })).toThrow(/trust-bearing code signature/);
    expect(() => assertNoTrustBearingMacCodeSignature('unknown-success.app', {
      status: 0,
      stdout: '',
      stderr: 'Identifier=com.example\n'
    })).toThrow(/trust-bearing code signature/);
    expect(() => assertNoTrustBearingMacCodeSignature('inspection-failed.app', {
      status: null,
      stdout: '',
      stderr: 'codesign was terminated unexpectedly'
    })).toThrow(/inspection failed unexpectedly/);
    expect(() => assertNoTrustBearingMacCodeSignature('enveloped.app', {
      status: 1,
      stdout: '',
      stderr: 'code object is not signed at all'
    }, true)).toThrow(/CodeResources signature envelope/);
  });

  it('fails release-existence preflight closed on API errors instead of spending packaging runners', async () => {
    const options = {
      repository: 'owner/repo',
      tag: 'v2.0.2',
      token: 'test-token'
    };
    await expect(assertReleaseAbsent({
      ...options,
      fetchImpl: async () => new Response('', { status: 404 })
    })).resolves.toBeUndefined();
    await expect(assertReleaseAbsent({
      ...options,
      fetchImpl: async () => new Response('{}', { status: 200 })
    })).rejects.toThrow(/already exists/);
    await expect(assertReleaseAbsent({
      ...options,
      fetchImpl: async () => new Response('{"message":"rate limited"}', { status: 403 })
    })).rejects.toThrow(/refusing to assume the release is absent/);
  });

  it('rejects invalid publishes before allocating the reusable six-runner build', () => {
    const workflow = readFileSync(path.join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
    const preflight = workflow.indexOf('  preflight:');
    const candidate = workflow.indexOf('  candidate:');
    const publish = workflow.indexOf('  publish:');
    expect(preflight).toBeGreaterThan(-1);
    expect(candidate).toBeGreaterThan(preflight);
    expect(publish).toBeGreaterThan(candidate);
    expect(workflow.slice(preflight, candidate)).toContain('node scripts/check-release-absent.mjs');
    expect(workflow.slice(preflight, candidate)).toContain('Verify release metadata agrees');
    expect(workflow.slice(preflight, candidate)).toContain("APP_VERSION = '([^']+)'");
    expect(workflow.slice(preflight, candidate)).toContain('must disclose unsigned and unnotarized macOS artifacts');
    expect(workflow.slice(candidate, publish)).toContain('needs: preflight');
    expect(workflow.slice(publish)).toContain('node scripts/check-release-absent.mjs');
    expect(workflow).toContain('name: chat-on-steroids-candidate-${{ github.run_id }}');
  });

  it('keeps the current changelog and reviewed release notes aligned with every published artifact', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
    const versionSource = readFileSync(path.join(root, 'src', 'main', 'version.ts'), 'utf8');
    const tag = `v${pkg.version}`;
    const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const notes = readFileSync(path.join(root, 'docs', 'release-notes', `${tag}.md`), 'utf8');
    const publish = readFileSync(path.join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
    const release = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');

    expect(lock.version).toBe(pkg.version);
    expect(lock.packages?.['']?.version).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
    expect(versionSource.match(/APP_VERSION = '([^']+)'/)?.[1]).toBe(pkg.version);
    expect(changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1]).toBe(pkg.version);
    expect(notes).toContain(`## ${pkg.version}`);
    expect(notes).toMatch(/unsigned/i);
    expect(notes).toMatch(/unnotarized/i);

    const artifacts = [
      'Chat-On-Steroids-Setup-x64.exe',
      'Chat-On-Steroids-Setup-arm64.exe',
      'Chat-On-Steroids-macOS-x64.dmg',
      'Chat-On-Steroids-macOS-x64.zip',
      'Chat-On-Steroids-macOS-arm64.dmg',
      'Chat-On-Steroids-macOS-arm64.zip',
      'Chat-On-Steroids-Linux-x64.AppImage',
      'Chat-On-Steroids-Linux-x64.deb',
      'Chat-On-Steroids-Linux-arm64.AppImage',
      'Chat-On-Steroids-Linux-arm64.deb',
      'Chat-On-Steroids-Extension.zip',
      'SHA256SUMS.txt'
    ];
    const checksumStep = release.slice(
      release.indexOf('      - name: Create SHA-256 checksums'),
      release.indexOf('      - name: Upload release candidate')
    );
    const candidateUpload = release.slice(release.indexOf('      - name: Upload release candidate'));
    const publishStep = publish.slice(publish.indexOf('      - name: Publish the release'));
    for (const artifact of artifacts) {
      expect(notes).toContain(`\`${artifact}\``);
      expect(candidateUpload).toContain(artifact);
      expect(publishStep).toContain(artifact);
    }
    for (const artifact of artifacts.filter((artifact) => artifact !== 'SHA256SUMS.txt')) {
      expect(checksumStep).toContain(artifact);
    }
  });
});
