import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathEntries } from './env.js';

export function ripgrepExecutableName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'rg.exe' : 'rg';
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;
    if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Looks for rg on the inherited path.
 *
 * Through the shared reader, because environment names are case-insensitive on Windows and
 * `process.env.PATH` is undefined on a machine whose parent process spelled it `Path` —
 * which is the ordinary spelling. Reading only the uppercase name silently found nothing.
 */
function pathCandidate(): string | null {
  const fileName = ripgrepExecutableName();
  for (const raw of pathEntries()) {
    const dir = raw.trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    const candidate = path.join(dir, fileName);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** Locate the bundled ripgrep first, then an existing user installation as a dev fallback. */
export function locateRipgrep(): string | null {
  const fileName = ripgrepExecutableName();
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'rg', fileName) : null;
  if (packaged && isExecutableFile(packaged)) return packaged;

  const dev = path.resolve(__dirname, '..', '..', 'resources', 'rg', fileName);
  if (isExecutableFile(dev)) return dev;
  return pathCandidate();
}

export function ripgrepVersionFile(): string | null {
  const executable = locateRipgrep();
  return executable ? path.join(path.dirname(executable), 'VERSION') : null;
}
