import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { signedMacConfig } from './signed-mac-config.mjs';

/** GitHub supplies these secrets only for an explicitly signed native Mac job. */
export function prepareMacSigning(env = process.env) {
  if (!env.RUNNER_TEMP || !env.GITHUB_ENV || !env.CSC_LINK?.trim() || !env.CSC_KEY_PASSWORD?.trim()) {
    throw new Error('Signed CI packaging requires runner paths and certificate import credentials');
  }
  const encoded = env.APPLE_API_KEY_BASE64?.replace(/\s+/g, '') ?? '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Notarization key must be base64 encoded');
  const key = Buffer.from(encoded, 'base64');
  if (!key.toString('utf8').includes('-----BEGIN PRIVATE KEY-----')) throw new Error('Notarization key is not a private-key PEM');
  signedMacConfig({ ...env, APPLE_API_KEY: 'configured-by-runner' });
  const dir = mkdtempSync(path.join(env.RUNNER_TEMP, 'cos-notary-'));
  try {
    const file = path.join(dir, 'AuthKey.p8');
    writeFileSync(file, key, { mode: 0o600 });
    appendFileSync(env.GITHUB_ENV, `APPLE_API_KEY=${file}\nCOS_MAC_SIGNING_DIR=${dir}\n`);
    return dir;
  } catch (err) { rmSync(dir, { recursive: true, force: true }); throw err; }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) prepareMacSigning();
