/**
 * Finds the tunnel executables.
 *
 * The installer ships the release that was current when it was built, so a fresh
 * install works without a detour to a GitHub releases page. An explicit path the user
 * chose still wins. Otherwise the bundled copy wins: it is the version this app was
 * tested with, so an unrelated stale executable on PATH must not silently replace it.
 * PATH/common locations remain a fallback for development or a damaged/missing bundle.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type BinaryName = 'tunnel-client' | 'cloudflared';

const locateCache = new Map<string, string | null>();
const bundledVersionCache = new Map<string, string | null>();

function exeName(name: BinaryName): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

/** Walks PATH by hand rather than shelling out to `where`. */
function searchPath(fileName: string): string | null {
  const raw = process.env.PATH ?? process.env.Path ?? '';
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir.replace(/^"|"$/g, ''), fileName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function commonDirs(): string[] {
  const home = process.env.USERPROFILE ?? '';
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  return [
    localAppData && path.join(localAppData, 'Programs', 'tunnel-client'),
    localAppData && path.join(localAppData, 'tunnel-client'),
    home && path.join(home, '.tunnel-client'),
    home && path.join(home, 'bin'),
    home && path.join(home, 'Downloads', 'tunnel-client'),
    path.join(programFiles, 'tunnel-client'),
    path.join(programFiles, 'cloudflared')
  ].filter((d): d is string => d.length > 0);
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
    process.env.LOCALAPPDATA ?? '',
    process.env.ProgramFiles ?? ''
  ].join('\u0000');
  if (locateCache.has(key)) return locateCache.get(key) ?? null;

  const fileName = exeName(name);

  if (hint && hint.trim() !== '') {
    const trimmed = hint.trim();
    if (existsSync(trimmed)) {
      // Accept a folder as well as the exe itself, since users paste both.
      const asDir = path.join(trimmed, fileName);
      if (existsSync(asDir)) {
        locateCache.set(key, asDir);
        return asDir;
      }
      if (path.basename(trimmed).toLowerCase() === fileName.toLowerCase()) {
        locateCache.set(key, trimmed);
        return trimmed;
      }
    }
    // cloudflared normally sits beside tunnel-client in the release archive.
    const sibling = path.join(path.dirname(trimmed), fileName);
    if (existsSync(sibling)) {
      locateCache.set(key, sibling);
      return sibling;
    }
  }

  const bundled = bundledDir();
  if (bundled) {
    const candidate = path.join(bundled, fileName);
    if (existsSync(candidate)) {
      locateCache.set(key, candidate);
      return candidate;
    }
  }

  const onPath = searchPath(fileName);
  if (onPath) {
    locateCache.set(key, onPath);
    return onPath;
  }

  for (const dir of commonDirs()) {
    const candidate = path.join(dir, fileName);
    if (existsSync(candidate)) {
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
  // Source: src/main/tunnel -> repo root is three levels up.
  // Packaged/compiled dev output keeps the same main/tunnel nesting under dist.
  const dev = path.resolve(__dirname, '..', '..', '..', 'resources', 'tunnel');
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
