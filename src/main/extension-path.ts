/**
 * Where the Chrome extension lives on this machine.
 *
 * Chrome loads an unpacked extension from a real folder, so the extension cannot live
 * inside the asar — it ships as an extraResource and is copied out verbatim by the
 * package. Development can point Chrome at the repo's own `extension/`, but a packaged
 * build first mirrors `resources/extension` into the app's stable per-user data directory.
 * That extra hop matters on Linux AppImage: `process.resourcesPath` lives in a temporary
 * mount which disappears when the app exits, while Chrome remembers the exact folder used
 * for Load unpacked. The per-user copy keeps that path stable on every desktop OS and is
 * refreshed from the package on every launch/update.
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const MATERIALIZED_FINGERPRINT = '.chat-on-steroids-source';
const PUBLISH_LAST = new Set(['manifest.json', MATERIALIZED_FINGERPRINT]);

function extensionFingerprint(root: string): string {
  const hash = createHash('sha256');
  const visit = (dir: string, relativeDir = ''): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        visit(absolute, relative);
      } else if (entry.isFile()) {
        hash.update(`f\0${relative}\0`);
        hash.update(readFileSync(absolute));
        hash.update('\0');
      } else {
        // The shipped extension is plain files/directories. Refuse an unexpected special entry
        // instead of materializing host-dependent links/devices into Chrome's trusted folder.
        throw new Error(`Unsupported extension entry: ${relative}`);
      }
    }
  };
  visit(root);
  return hash.digest('hex');
}

function validExtension(dir: string): boolean {
  try {
    return statSync(path.join(dir, 'manifest.json')).isFile();
  } catch {
    return false;
  }
}

function materializedFingerprint(dir: string): string | null {
  try {
    return readFileSync(path.join(dir, MATERIALIZED_FINGERPRINT), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

type EntryKind = 'directory' | 'file' | 'other' | 'missing';

function entryKind(target: string): EntryKind {
  try {
    const stat = lstatSync(target);
    if (stat.isDirectory()) return 'directory';
    if (stat.isFile()) return 'file';
    return 'other';
  } catch {
    return 'missing';
  }
}

function ensureDirectory(target: string): void {
  const kind = entryKind(target);
  if (kind === 'directory') return;
  if (kind !== 'missing') rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
}

/**
 * Replaces one extension file without ever replacing the published extension root itself.
 *
 * A temporary sibling means readers see either the previous complete file or the next complete
 * file. Windows rename cannot replace an existing destination, so remove the old leaf only after
 * the temporary copy is complete. `manifest.json` is published last by syncTreeInPlace(), which
 * keeps Chrome from observing a new manifest before the matching scripts/resources exist.
 */
function replaceFile(source: string, target: string): void {
  ensureDirectory(path.dirname(target));
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.cos-next-${process.pid}`);
  rmSync(temporary, { recursive: true, force: true });
  copyFileSync(source, temporary);
  chmodSync(temporary, statSync(source).mode);
  const kind = entryKind(target);
  if (kind !== 'missing') rmSync(target, { recursive: true, force: true });
  renameSync(temporary, target);
}

/**
 * Synchronizes a fully staged tree while preserving `target`'s directory inode.
 *
 * Snap Chromium exposes a user-picked unpacked extension through xdg-document-portal. That
 * portal grant is attached to the directory the user selected, not merely its pathname. Renaming
 * `userData/extension` out of the way during an app update therefore leaves Chrome remembering a
 * `/run/user/.../doc/.../extension` alias whose backing directory has been deleted. Keep the root
 * directory in place and replace only its children. A complete backup remains beside it until the
 * synchronization succeeds, so an interrupted update is restored on the next launch.
 */
function syncTreeInPlace(source: string, target: string, root = true): void {
  ensureDirectory(target);
  const sourceEntries = readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const sourceNames = new Set(sourceEntries.map((entry) => entry.name));
  const ordinary = sourceEntries.filter((entry) => !root || !PUBLISH_LAST.has(entry.name));
  const final = root ? sourceEntries.filter((entry) => PUBLISH_LAST.has(entry.name)) : [];

  const publish = (entry: (typeof sourceEntries)[number]): void => {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      syncTreeInPlace(from, to, false);
      return;
    }
    if (!entry.isFile()) throw new Error(`Unsupported staged extension entry: ${entry.name}`);
    replaceFile(from, to);
  };

  for (const entry of ordinary) publish(entry);
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (sourceNames.has(entry.name)) continue;
    rmSync(path.join(target, entry.name), { recursive: true, force: true });
  }
  for (const entry of final) publish(entry);
}

function recoverInterruptedMaterialization(stable: string, stage: string, backup: string): void {
  // The backup is authoritative over staging: it is the previously published Chrome tree.
  // Restore its *contents* into the extant root so a document-portal grant to that directory
  // survives recovery too. Older releases may have moved the directory itself to `.old`; if no
  // stable directory remains there is no inode left to preserve, so recreating it is unavoidable.
  if (validExtension(backup)) {
    if (entryKind(stable) === 'directory') syncTreeInPlace(backup, stable);
    else {
      rmSync(stable, { recursive: true, force: true });
      cpSync(backup, stable, { recursive: true, force: true });
    }
    if (validExtension(stable)) {
      rmSync(backup, { recursive: true, force: true });
      rmSync(stage, { recursive: true, force: true });
    }
    return;
  }

  // A staged tree is recoverable only after its fingerprint marker was written, which happens
  // after the recursive copy and manifest validation complete. If a root already exists, keep
  // its inode and finish publishing into it; a first install has no root/portal grant yet and can
  // promote the staged directory directly.
  if (validExtension(stage) && materializedFingerprint(stage) !== null) {
    if (entryKind(stable) === 'directory') {
      syncTreeInPlace(stage, stable);
      if (validExtension(stable)) rmSync(stage, { recursive: true, force: true });
    } else {
      rmSync(stable, { recursive: true, force: true });
      renameSync(stage, stable);
    }
    return;
  }

  if (validExtension(stable)) {
    rmSync(stage, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
  }
}

/**
 * Refreshes the Chrome-visible copy transactionally while keeping its pathname stable.
 *
 * Copying package files directly into a folder Chrome already remembers makes an update
 * destructive before it is known-good: a stale destination shape, disk error, or interrupted
 * copy can leave a mixture of two extension versions. Stage and fingerprint the complete source
 * first, and keep a complete rollback copy while synchronizing the published folder in place.
 * Preserving that directory inode is load-bearing for sandboxed Chromium: its document-portal
 * grant can otherwise keep pointing at the renamed/deleted old directory even though the visible
 * pathname is unchanged.
 */
function materializePackagedExtension(bundled: string, stable: string): string | null {
  const stage = `${stable}.new`;
  const backup = `${stable}.old`;
  mkdirSync(path.dirname(stable), { recursive: true });
  recoverInterruptedMaterialization(stable, stage, backup);

  // The package is the update source, not the only usable copy. If an installed resource is
  // damaged after a successful earlier materialization, keep exposing the last-known-good stable
  // folder so Chrome and Finder do not lose a working extension merely because refresh is broken.
  if (!validExtension(bundled)) return validExtension(stable) ? stable : null;
  const fingerprint = extensionFingerprint(bundled);
  if (validExtension(stable) && materializedFingerprint(stable) === fingerprint) return stable;
  rmSync(stage, { recursive: true, force: true });

  try {
    cpSync(bundled, stage, { recursive: true, force: true });
    if (!validExtension(stage)) throw new Error('Staged extension is missing manifest.json');
    writeFileSync(path.join(stage, MATERIALIZED_FINGERPRINT), fingerprint, { encoding: 'utf8', mode: 0o600 });

    // Only now is the replacement complete. A valid published copy becomes the rollback
    // authority before any of its children change. Copying rather than renaming is deliberate:
    // Chrome's document-portal grant must keep referring to the published root inode.
    rmSync(backup, { recursive: true, force: true });
    const hadPublishedDirectory = entryKind(stable) === 'directory';
    const hadValidPublishedCopy = validExtension(stable);
    if (hadValidPublishedCopy) cpSync(stable, backup, { recursive: true, force: true });

    if (hadPublishedDirectory) {
      syncTreeInPlace(stage, stable);
      if (!validExtension(stable) || materializedFingerprint(stable) !== fingerprint)
        throw new Error('Published extension did not match staged source');
      rmSync(stage, { recursive: true, force: true });
    } else {
      rmSync(stable, { recursive: true, force: true });
      renameSync(stage, stable);
    }
    rmSync(backup, { recursive: true, force: true });
    return stable;
  } catch {
    // Restore a known-good old copy in place when possible. If rollback itself cannot complete,
    // keep both backup and staged trees for recoverInterruptedMaterialization() on the next start.
    if (validExtension(backup)) {
      try {
        if (entryKind(stable) === 'directory') syncTreeInPlace(backup, stable);
        else {
          rmSync(stable, { recursive: true, force: true });
          cpSync(backup, stable, { recursive: true, force: true });
        }
      } catch {
        return validExtension(stable) ? stable : null;
      }
    }
    if (validExtension(stable)) {
      rmSync(stage, { recursive: true, force: true });
      rmSync(backup, { recursive: true, force: true });
    }
    return validExtension(stable) ? stable : null;
  }
}

/**
 * The folder to open for chrome://extensions → Load unpacked, or null if it is missing.
 *
 * Packaged first: in an installed build the source tree is not present at all, and in a
 * dev run process.resourcesPath points into Electron's own resources, where there is no
 * extension folder — so the checkout path is what answers there.
 */
export function extensionDir(): string | null {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'extension');
    const stable = path.join(app.getPath('userData'), 'extension');
    try {
      return materializePackagedExtension(bundled, stable);
    } catch {
      // Fingerprinting itself can fail if the packaged resource is damaged. A previously
      // materialized extension remains useful and must not be hidden merely because the update
      // source is unreadable.
      return validExtension(stable) ? stable : null;
    }
  }

  const candidates = [
    path.join(app.getAppPath(), 'extension'),
    path.join(process.cwd(), 'extension'),
    path.join(process.resourcesPath, 'extension')
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'manifest.json'))) return candidate;
  }
  return null;
}

/**
 * The folder this app shipped the extension in, without materializing anything.
 *
 * `extensionDir()` cannot answer this: in a packaged app it materializes the folder as a side
 * effect, which is right for "where should Chrome load it from" and wrong for "what did I ship".
 * Each root is read where it is used, because `process.resourcesPath` is undefined outside
 * Electron and must not stop the other candidates from answering.
 */
function shippedExtensionDir(): string | null {
  const candidates = app.isPackaged
    ? [() => path.join(process.resourcesPath, 'extension'), () => path.join(app.getPath('userData'), 'extension')]
    : [() => path.join(app.getAppPath(), 'extension'), () => path.join(process.cwd(), 'extension')];
  for (const candidate of candidates) {
    try {
      const dir = candidate();
      if (validExtension(dir)) return dir;
    } catch {
      // A root this host does not have is not an error; the next one may still answer.
    }
  }
  return null;
}

/**
 * The build stamp this app ships, as written by scripts/write-extension-stamp.mjs at packaging
 * time — the same file the extension's worker reports in `x-extension-build`, so the two are
 * comparable without either end hashing anything at runtime.
 *
 * Null in a development checkout that was never packaged: there is no stamp to compare, and the
 * comparisons that use this stay silent, exactly as they were before there was one. Read once
 * and remembered, because the file cannot change under a running app and this sits on the path
 * that greets every extension request.
 */
let shippedStamp: string | null | undefined;
export function shippedExtensionBuild(): string | null {
  if (shippedStamp !== undefined) return shippedStamp;
  shippedStamp = null;
  try {
    const dir = shippedExtensionDir();
    if (dir) shippedStamp = readFileSync(path.join(dir, 'build-stamp.txt'), 'utf8').trim().slice(0, 12) || null;
  } catch {
    // No stamp, a damaged resource, or no Electron at all: the comparison simply says nothing.
  }
  return shippedStamp;
}

/** Test seam: pretend this app shipped `stamp`, or forget the remembered one with no argument. */
export function setShippedExtensionBuildForTest(stamp?: string | null): void {
  shippedStamp = stamp;
}

/** The build stamp of the folder Chrome loads the packaged extension from, or null. */
export function materializedExtensionBuild(): string | null {
  try {
    if (app?.isPackaged !== true) return null;
    return readFileSync(path.join(app.getPath('userData'), 'extension', 'build-stamp.txt'), 'utf8').trim().slice(0, 12) || null;
  } catch {
    return null;
  }
}

/**
 * The newer build a running extension could reload into, or null when there is none.
 *
 * Only a packaged app with a stamped extension of its own offers one, and only to an extension
 * that reported a different stamp. Offering does not touch the folder Chrome loads from: a
 * folder replaced under a live service worker hands newly opened tabs the new content scripts
 * while the old worker still runs, so the copy waits for `prepareExtensionUpdate`, which the
 * extension asks for only when it is idle and about to reload.
 */
export function extensionUpdateOffer(running: string | null): { build: string } | null {
  // Part of every `/status` answer, so it must never throw: a missing stamp or a partly
  // available Electron simply means there is nothing to offer.
  try {
    if (!running) return null;
    const shipped = shippedExtensionBuild();
    if (!shipped || running === shipped || app?.isPackaged !== true) return null;
    return { build: shipped };
  } catch {
    return null;
  }
}

/** Brings the loaded folder up to the shipped build for an idle extension that will reload now. */
export function prepareExtensionUpdate(running: string | null): { build: string; ready: boolean } | null {
  const offer = extensionUpdateOffer(running);
  if (!offer) return null;
  try { extensionDir(); } catch { /* reported as not ready below */ }
  return { build: offer.build, ready: materializedExtensionBuild() === offer.build };
}
