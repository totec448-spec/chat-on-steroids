/**
 * The updater, held to the two things that actually matter about it.
 *
 * One: a file that is going to be executed on quit is the published file and nothing else. The
 * release pipeline writes a `SHA256SUMS.txt` over the exact artifacts it uploads, so that is the
 * bar here — a byte count would pass a same-length wrong file straight into an installer.
 *
 * Two: nothing it does can wedge the app. Every failure has to leave the running version intact
 * and be retried the next time the app opens, which is the only schedule this has.
 *
 * The platform is faked rather than abstracted: `stagedArtifact()` reads `process.platform` and
 * `process.env.APPIMAGE` because those *are* the facts that decide what an installation can
 * apply to itself, and a seam in front of them would be a second answer to the same question.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawned: Array<{ file: string; args: string[] }> = [];
vi.mock('node:child_process', () => ({
  spawn: (file: string, args: string[]) => {
    spawned.push({ file, args });
    return { on: () => undefined, unref: () => undefined };
  }
}));

let userData = '';
let packaged = true;
vi.mock('electron', () => ({ app: { getPath: () => userData, get isPackaged() { return packaged; } } }));
vi.mock('../src/main/logger.js', () => ({ logInfo: () => undefined, logWarn: () => undefined }));

const { APP_VERSION } = await import('../src/main/version.js');
const { isNewer } = await import('../src/shared/types.js');
const {
  applyStagedUpdate,
  checkForUpdates,
  releaseVersion,
  resetUpdateForTests,
  stagedArtifact,
  updateStatus
} = await import('../src/main/update.js');

const NEXT = '99.0.0';
const WINDOWS_ASSET = `Chat-On-Steroids-Setup-${process.arch}.exe`;
const APPIMAGE_ASSET = `Chat-On-Steroids-Linux-${process.arch}.AppImage`;

const sha256 = (body: string): string => createHash('sha256').update(body).digest('hex');

/**
 * GitHub, as the three requests this makes: the release, its checksums, and one artifact.
 *
 * `checksums` is supplied as text so a test can hand over a manifest that disagrees with the
 * bytes, which is the whole point of having one.
 */
function github(options: {
  version?: string;
  body?: string;
  checksums?: string;
  fail?: 'release' | 'sums' | 'asset';
} = {}) {
  const version = options.version ?? NEXT;
  const body = options.body ?? 'installer bytes';
  const sums = options.checksums ?? `${sha256(body)}  ${WINDOWS_ASSET}\n${sha256(body)}  ${APPIMAGE_ASSET}\n`;
  const asked: string[] = [];
  const fetch = vi.fn(async (input: string | URL) => {
    const url = String(input);
    const name = url.split('/').pop()!;
    asked.push(name);
    if (url.includes('api.github.com')) {
      if (options.fail === 'release') return new Response('nope', { status: 503 });
      return new Response(JSON.stringify({ tag_name: `v${version}` }), { status: 200 });
    }
    if (name === 'SHA256SUMS.txt') {
      if (options.fail === 'sums') return new Response('nope', { status: 404 });
      return new Response(sums, { status: 200 });
    }
    if (options.fail === 'asset') return new Response('nope', { status: 500 });
    return new Response(body, { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  return { asked, fetch, body };
}

/** Runs the pass as an installation of the given shape, and puts the real one back. */
async function asPlatform(platform: string, appImage: string | undefined, run: () => Promise<void>): Promise<void> {
  const realPlatform = process.platform;
  const realAppImage = process.env.APPIMAGE;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  if (appImage) process.env.APPIMAGE = appImage;
  else delete process.env.APPIMAGE;
  try {
    await run();
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    if (realAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = realAppImage;
  }
}

beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), 'cos-update-'));
  packaged = true;
  spawned.length = 0;
  resetUpdateForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('which installations update themselves', () => {
  it('takes the Windows installer and the Linux AppImage, and nothing else', () => {
    expect(stagedArtifact('win32', 'x64')).toMatchObject({ name: 'Chat-On-Steroids-Setup-x64.exe', kind: 'installer' });
    expect(stagedArtifact('linux', 'arm64', '/opt/cos.AppImage')).toMatchObject({
      name: 'Chat-On-Steroids-Linux-arm64.AppImage',
      kind: 'appimage',
      target: '/opt/cos.AppImage'
    });
  });

  /**
   * A `.deb` is the system package manager's file and replacing it needs root. Asking for a
   * password during quit is not something this app does, so that installation is told a new
   * version exists and given the release page - it is not quietly left waiting for a download
   * that was never going to happen. Same for macOS, where the artifacts ship unsigned.
   */
  it('leaves a Linux package install and macOS to be updated by hand', async () => {
    expect(stagedArtifact('linux', 'x64', undefined)).toBeNull();
    expect(stagedArtifact('darwin', 'arm64')).toBeNull();
    expect(stagedArtifact('win32', 'ia32')).toBeNull();

    const { asked } = github();
    await asPlatform('linux', undefined, () => checkForUpdates());

    // Told, and told exactly: a version that is newer, and no pretence of a download.
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'idle', error: null });
    expect(asked).toEqual(['latest']);
    await applyStagedUpdate();
    expect(spawned).toEqual([]);
  });

  /**
   * A development tree is not an installation. It is permanently "behind" the moment a release
   * ships, and staging for it would mean quitting `electron-vite dev` silently ran an NSIS
   * installer over the maintainer's real per-user install.
   */
  it('never stages for an unpackaged run', async () => {
    packaged = false;
    expect(stagedArtifact('win32', 'x64')).toBeNull();

    const { asked } = github();
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'idle', error: null });
    expect(asked).toEqual(['latest']);
    await applyStagedUpdate();
    expect(spawned).toEqual([]);
  });
});

describe('finding a newer release', () => {
  it('reads a release tag, and refuses anything that is not one', () => {
    expect(releaseVersion('v2.1.0')).toBe('2.1.0');
    expect(releaseVersion('2.1.0')).toBe('2.1.0');
    expect(releaseVersion('v2.1.0-rc.1')).toBeNull();
    expect(releaseVersion(null)).toBeNull();
  });

  /** A published downgrade must not install itself over a newer app. */
  it('compares versions as numbers, not as strings', () => {
    expect(isNewer('2.0.10', '2.0.9')).toBe(true);
    expect(isNewer('2.0.9', '2.0.10')).toBe(false);
    expect(isNewer('2.0.2', '2.0.2')).toBe(false);
    expect(isNewer('1.9.9', '2.0.0')).toBe(false);
  });

  /**
   * `checkedAt` is the difference between "checked, nothing to install" and "has not asked yet",
   * which are the same `{latest: null, stage: 'idle'}` record otherwise. The renderer says "up to
   * date" on the strength of that timestamp, so a pass that never reached GitHub must not set it.
   */
  it('reports nothing when the published release is the version already running', async () => {
    const { asked } = github({ version: APP_VERSION });
    expect(updateStatus().checkedAt).toBeNull();
    await checkForUpdates();
    expect(updateStatus()).toMatchObject({ current: APP_VERSION, latest: null, stage: 'idle' });
    expect(updateStatus().checkedAt).toBeGreaterThan(0);
    // It stopped at the release: no checksums, no artifact, nothing written.
    expect(asked).toEqual(['latest']);
    expect(readdirSync(userData)).toEqual([]);
  });
});

describe('staging the new version', () => {
  it('downloads the artifact, checks it against the published SHA-256, and installs it on quit', async () => {
    const { asked, body } = github();
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
    expect(asked).toEqual(['latest', 'SHA256SUMS.txt', WINDOWS_ASSET]);

    const staged = path.join(userData, 'updates', WINDOWS_ASSET);
    expect(readFileSync(staged, 'utf8')).toBe(body);
    expect(existsSync(`${staged}.part`)).toBe(false);

    // The quit half of the restart: the file that was staged is the one handed over, silently.
    await applyStagedUpdate();
    expect(spawned).toEqual([{ file: staged, args: ['/S'] }]);
  });

  /**
   * The one that a length check would wave through, and the reason the digest is the bar: the
   * artifact that arrives is the wrong build at exactly the right size. Nothing may be staged,
   * and nothing may be left on disk for a later quit to find.
   */
  it('stages nothing when the artifact is not the file the release published', async () => {
    github({ checksums: `${sha256('a different build')}  ${WINDOWS_ASSET}\n` });
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(updateStatus().stage).toBe('failed');
    expect(updateStatus().error).toContain('not the published file');
    expect(readdirSync(path.join(userData, 'updates'))).toEqual([]);

    await applyStagedUpdate();
    expect(spawned).toEqual([]);
  });

  it('stages nothing when the release does not publish an artifact for this installation', async () => {
    github({ checksums: `${sha256('x')}  Chat-On-Steroids-Extension.zip\n` });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus().stage).toBe('failed');
    expect(updateStatus().error).toContain(`publishes no ${WINDOWS_ASSET}`);
    expect(spawned).toEqual([]);
  });

  /**
   * An AppImage has no installer: the running file is the whole application, so the update is
   * that file being replaced. By rename, never by writing through it - the old build is still
   * executing out of that path while this runs.
   */
  it('replaces the running AppImage with the staged one', async () => {
    const live = path.join(userData, 'Chat-On-Steroids.AppImage');
    writeFileSync(live, 'the old build');
    const { body } = github();

    await asPlatform('linux', live, async () => {
      await checkForUpdates();
      expect(updateStatus().stage).toBe('ready');
      await applyStagedUpdate();
    });

    expect(readFileSync(live, 'utf8')).toBe(body);
    expect(existsSync(`${live}.new`)).toBe(false);
    expect(spawned).toEqual([]);
  });
});

describe('one pass at a time, and one more next time the app opens', () => {
  it('joins a check that is already running instead of downloading twice', async () => {
    const { asked } = github();
    await asPlatform('win32', undefined, async () => {
      await Promise.all([checkForUpdates(), checkForUpdates(), checkForUpdates()]);
    });
    expect(asked).toEqual(['latest', 'SHA256SUMS.txt', WINDOWS_ASSET]);
    expect(updateStatus().stage).toBe('ready');
  });

  /**
   * The only schedule this has is the app being opened, so a pass that failed has to leave
   * itself repeatable. A retained in-flight promise would turn one unreachable network into an
   * app that never checks again for as long as it runs.
   */
  it('retries the next time the app opens after a check that could not reach GitHub', async () => {
    github({ fail: 'release' });
    await checkForUpdates();
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed', checkedAt: null });
    expect(updateStatus().error).toContain('503');

    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
  });

  it('retries the next time the app opens after a download that stopped', async () => {
    github({ fail: 'asset' });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'failed' });

    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus().stage).toBe('ready');
  });

  /** Already staged: the same release is not fetched a second time. */
  it('does not download a version it has already staged', async () => {
    const first = github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(first.asked).toEqual(['latest', 'SHA256SUMS.txt', WINDOWS_ASSET]);

    const second = github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(second.asked).toEqual(['latest']);
    expect(updateStatus().stage).toBe('ready');
  });

  /** Handed over once. A second quit has nothing to install and must not re-run an installer. */
  it('hands a staged update over exactly once', async () => {
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    await applyStagedUpdate();
    await applyStagedUpdate();
    expect(spawned).toHaveLength(1);
  });
});
