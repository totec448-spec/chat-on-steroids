/**
 * Proof, kept across restarts, that the person's own browser has the extension and is signed in.
 *
 * Presence and login are live observations: the extension in Chrome, Edge or Brave only reports
 * while that browser runs, and login only while a ChatGPT tab is open there. Right for status,
 * wrong for Setup: closing Chrome or the last ChatGPT tab would turn a finished first step back to
 * pending after every restart, although the built-in browser no longer needs Chrome once signed in.
 * This keeps the newest evidence for one extension instance (its random browser id): the version
 * it ran, and whether ChatGPT last answered signed in there. A different instance replaces it, and
 * a signed-out answer clears the login, so the proof never outlives what it claims.
 *
 * It holds no cookie, token or account name: only an id, a version and two times.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logWarn } from './logger.js';

/** The last answer ChatGPT gave there, kept as yes (`signedInAt`), no (`signedOutAt`) or neither. */
type Proof = { browserId: string; version: string; installedAt: number; signedInAt: number | null; signedOutAt: number | null };

let filePath = '';
let proof: Proof | null = null;
let writing: Promise<void> = Promise.resolve();
let pending = false;

export function initBrowserProofPath(userDataDir: string): void {
  filePath = path.join(userDataDir, 'browser-proof.json');
}

export async function loadBrowserProof(): Promise<void> {
  proof = null;
  if (!filePath) return;
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as { external?: Partial<Proof> };
    const value = parsed.external;
    const time = (at: unknown) => (typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : null);
    if (value && typeof value.browserId === 'string' && /^[a-z0-9]{16,64}$/.test(value.browserId) &&
        typeof value.version === 'string' && value.version.length <= 32 && time(value.installedAt) !== null) {
      const signedInAt = time(value.signedInAt);
      proof = { browserId: value.browserId, version: value.version, installedAt: time(value.installedAt)!, signedInAt,
        signedOutAt: signedInAt === null ? time(value.signedOutAt) : null };
    }
  } catch (error) {
    // Missing on a first run; anything unreadable is only lost evidence, never a wrong answer.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logWarn(`Browser proof unreadable: ${(error as Error).message}`);
  }
}

function persist(): void {
  if (!filePath || pending) return;
  pending = true;
  writing = writing.then(async () => {
    pending = false;
    const temporary = `${filePath}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, external: proof }), 'utf8');
      await fs.rename(temporary, filePath);
    } catch (error) {
      logWarn(`Browser proof not saved: ${(error as Error).message}`);
    }
  });
}

/** An authenticated request from the extension in the person's own browser. True when the proof changed. */
export function noteExternalInstalled(browserId: string, version: string, at = Date.now()): boolean {
  if (proof && proof.browserId === browserId && proof.version === version) return false;
  // Another instance (another browser or profile) proves nothing about the old one's login.
  const same = proof?.browserId === browserId;
  proof = { browserId, version, installedAt: at, signedInAt: same ? proof!.signedInAt : null, signedOutAt: same ? proof!.signedOutAt : null };
  persist();
  return true;
}

/**
 * ChatGPT's own answer in that browser. A signed-out answer replaces the lasting login and stays,
 * so a logout reads as one after the live answer expires, until a new sign-in is seen.
 */
export function noteExternalSignedIn(browserId: string, signedIn: boolean, at = Date.now()): boolean {
  if (!proof || proof.browserId !== browserId) return false;
  const known = proof.signedInAt !== null ? true : proof.signedOutAt !== null ? false : null;
  if (signedIn) { proof.signedInAt = at; proof.signedOutAt = null; }
  else { proof.signedOutAt = at; proof.signedInAt = null; }
  // Refreshing the time of the same answer is not news; only a change is worth a write.
  if (known === signedIn) return false;
  persist();
  return true;
}

/** The lasting evidence for the person's own browser, or null. `signedIn` null: never answered. */
export function externalBrowserProof(): { browserId: string; version: string; signedIn: boolean | null } | null {
  return proof && { browserId: proof.browserId, version: proof.version,
    signedIn: proof.signedInAt !== null ? true : proof.signedOutAt !== null ? false : null };
}

/** For tests: wait for the file to settle. */
export function browserProofWritten(): Promise<void> {
  return writing;
}

/** For tests. */
export function resetBrowserProofForTests(): void {
  proof = null;
  filePath = '';
}
