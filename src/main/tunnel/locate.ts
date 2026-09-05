/**
 * Finds the tunnel executables.
 *
 * The installer ships the release that was current when it was built, so a fresh
 * install works without a detour to a GitHub releases page. An explicit path the user
 * chose still wins. Otherwise the bundled copy wins: it is the version this app was
 * tested with, so an unrelated stale executable on PATH must not silently replace it.
 * PATH/common locations remain a fallback for development or a damaged/missing bundle.
 */

import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathEntries } from '../env.js';

export type BinaryName = 'tunnel-client' | 'cloudflared';

const locateCache = new Map<string, string | null>();
const bundledVersionCache = new Map<string, string | null>();

function isExecutableFile(candidate: string): boolean {
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;
    if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function tunnelExecutableName(name: BinaryName, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

/** Walks PATH by hand rather than shelling out to `where`. */
function searchPath(fileName: string): string | null {
  for (const dir of pathEntries()) {
    if (!dir) continue;
    const candidate = path.join(dir.replace(/^"|"$/g, ''), fileName);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export function commonBinaryDirsForPlatform(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = env.HOME ?? env.USERPROFILE ?? os.homedir()
): string[] {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    const home = env.USERPROFILE ?? homeDirectory;
    const localAppData = env.LOCALAPPDATA ?? '';
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
    return [
      localAppData && platformPath.join(localAppData, 'Programs', 'tunnel-client'),
      localAppData && platformPath.join(localAppData, 'tunnel-client'),
      home && platformPath.join(home, '.tunnel-client'),
      home && platformPath.join(home, 'bin'),
      home && platformPath.join(home, 'Downloads', 'tunnel-client'),
      platformPath.join(programFiles, 'tunnel-client'),
      platformPath.join(programFiles, 'cloudflared')
    ].filter((d): d is string => d.length > 0);
  }

  const homeDirs = homeDirectory
    ? [
        platformPath.join(homeDirectory, '.tunnel-client'),
        platformPath.join(homeDirectory, '.local', 'bin'),
        platformPath.join(homeDirectory, 'bin'),
        platformPath.join(homeDirectory, 'Downloads', 'tunnel-client')
      ]
    : [];
  const systemDirs =
    platform === 'darwin'
      ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
      : ['/home/linuxbrew/.linuxbrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin'];
  return [...homeDirs, ...systemDirs];
}

/**
 * Resolves a binary, preferring an explicit user-supplied path.
 * `hint` may be either the executable itself or the folder containing it.
 */
export function locateBinary(name: BinaryName, hint?: string): string | null {
  const key = [
    name,
    hint ?? '',
    process.platform,
    process.resourcesPath ?? '',
    process.env.PATH ?? process.env.Path ?? '',
    process.env.USERPROFILE ?? '',
    process.env.HOME ?? '',
    process.env.LOCALAPPDATA ?? '',
    process.env.ProgramFiles ?? ''
  ].join('\u0000');
  if (locateCache.has(key)) return locateCache.get(key) ?? null;

  const fileName = tunnelExecutableName(name);

  if (hint && hint.trim() !== '') {
    const trimmed = hint.trim();
    if (existsSync(trimmed)) {
      // Accept a folder as well as the exe itself, since users paste both.
      const asDir = path.join(trimmed, fileName);
      if (isExecutableFile(asDir)) {
        locateCache.set(key, asDir);
        return asDir;
      }
      if (path.basename(trimmed).toLowerCase() === fileName.toLowerCase() && isExecutableFile(trimmed)) {
        locateCache.set(key, trimmed);
        return trimmed;
      }
    }
    // cloudflared normally sits beside tunnel-client in the release archive.
    const sibling = path.join(path.dirname(trimmed), fileName);
    if (isExecutableFile(sibling)) {
      locateCache.set(key, sibling);
      return sibling;
    }
  }

  const bundled = bundledDir();
  if (bundled) {
    const candidate = path.join(bundled, fileName);
    if (isExecutableFile(candidate)) {
      locateCache.set(key, candidate);
      return candidate;
    }
  }

  const onPath = searchPath(fileName);
  if (onPath) {
    locateCache.set(key, onPath);
    return onPath;
  }

  for (const dir of commonBinaryDirsForPlatform(process.platform)) {
    const candidate = path.join(dir, fileName);
    if (isExecutableFile(candidate)) {
      locateCache.set(key, candidate);
      return candidate;
    }
  }
  locateCache.set(key, null);
  return null;
}

/**
 * Where the packaged app keeps its copy.
 *
 * In a packaged build extraResources land in resourcesPath; during development the
 * same files sit in resources/ at the repository root.
 */
function bundledDir(): string | null {
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'tunnel') : null;
  if (packaged && existsSync(packaged)) return packaged;
  // electron-vite bundles every main-process module into one out/main/index.js, so
  // __dirname here is out/main regardless of this file's own src/main/tunnel nesting —
  // two levels up is the repo root, matching ripgrep.ts's own dev-mode resolution below.
  const dev = path.resolve(__dirname, '..', '..', 'resources', 'tunnel');
  return existsSync(dev) ? dev : null;
}

/** The bundled tunnel-client version, for the diagnostics panel. */
export function bundledVersion(): string | null {
  const dir = bundledDir();
  if (!dir) return null;
  if (bundledVersionCache.has(dir)) return bundledVersionCache.get(dir) ?? null;
  try {
    const value = readFileSync(path.join(dir, 'VERSION'), 'utf8').trim() || null;
    bundledVersionCache.set(dir, value);
    return value;
  } catch {
    bundledVersionCache.set(dir, null);
    return null;
  }
}

/** Test seam for environment/path-resolution cases. */
export function resetTunnelLocatorCacheForTests(): void {
  locateCache.clear();
  bundledVersionCache.clear();
}
