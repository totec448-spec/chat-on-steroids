import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  browserProofWritten, externalBrowserProof, initBrowserProofPath, loadBrowserProof,
  noteExternalInstalled, noteExternalSignedIn, resetBrowserProofForTests
} from '../src/main/browser-proof.js';

let dir = '';
const chrome = 'a'.repeat(32);
const edge = 'b'.repeat(32);

beforeEach(async () => {
  resetBrowserProofForTests();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-proof-'));
  initBrowserProofPath(dir);
});
afterEach(async () => { await browserProofWritten(); await fs.rm(dir, { recursive: true, force: true }); });

it('keeps the extension and its login across a restart, and nothing else', async () => {
  expect(noteExternalInstalled(chrome, '2.1.25')).toBe(true);
  expect(noteExternalInstalled(chrome, '2.1.25')).toBe(false);
  expect(noteExternalSignedIn(chrome, true)).toBe(true);
  // Refreshing a login already known is not news.
  expect(noteExternalSignedIn(chrome, true)).toBe(false);
  await browserProofWritten();
  const saved = await fs.readFile(path.join(dir, 'browser-proof.json'), 'utf8');
  expect(Object.keys(JSON.parse(saved).external).sort()).toEqual(['browserId', 'installedAt', 'signedInAt', 'signedOutAt', 'version']);

  resetBrowserProofForTests();
  initBrowserProofPath(dir);
  await loadBrowserProof();
  expect(externalBrowserProof()).toEqual({ browserId: chrome, version: '2.1.25', signedIn: true });
});

it('keeps yes, no and never answered apart, and a logout stays a logout across a restart', async () => {
  noteExternalInstalled(chrome, '2.1.25');
  expect(externalBrowserProof()?.signedIn).toBeNull();
  noteExternalSignedIn(chrome, true);
  expect(noteExternalSignedIn(chrome, false)).toBe(true);
  expect(noteExternalSignedIn(chrome, false)).toBe(false);
  expect(externalBrowserProof()?.signedIn).toBe(false);
  await browserProofWritten();
  resetBrowserProofForTests();
  initBrowserProofPath(dir);
  await loadBrowserProof();
  expect(externalBrowserProof()).toEqual({ browserId: chrome, version: '2.1.25', signedIn: false });
  // Signing in again replaces the logout.
  noteExternalSignedIn(chrome, true);
  expect(externalBrowserProof()?.signedIn).toBe(true);
});

it('starts over for another browser and keeps the answer across versions of the same one', async () => {
  noteExternalInstalled(chrome, '2.1.25');
  noteExternalSignedIn(chrome, true);
  // Another browser or profile proves nothing about the first one's login.
  noteExternalInstalled(edge, '2.1.25');
  expect(externalBrowserProof()).toEqual({ browserId: edge, version: '2.1.25', signedIn: null });
  expect(noteExternalSignedIn(chrome, true)).toBe(false);
  expect(externalBrowserProof()?.signedIn).toBeNull();
  noteExternalSignedIn(edge, true);
  noteExternalInstalled(edge, '2.1.26');
  expect(externalBrowserProof()).toEqual({ browserId: edge, version: '2.1.26', signedIn: true });
});

it('reads a damaged or foreign file as no proof', async () => {
  for (const content of ['{"external":', JSON.stringify({ external: { browserId: 'not valid!', version: '1.0.0', installedAt: 1 } }),
    JSON.stringify({ external: { browserId: chrome, version: 'x'.repeat(40), installedAt: 1 } })]) {
    await fs.writeFile(path.join(dir, 'browser-proof.json'), content, 'utf8');
    await loadBrowserProof();
    expect(externalBrowserProof()).toBeNull();
  }
});
