import path from 'node:path';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REQUIRED = [
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'COS_WINDOWS_SIGNER_SUBJECT',
  'COS_WINDOWS_CERTIFICATE_SHA1'
];

const value = (env, key) => typeof env[key] === 'string' ? env[key].trim() : '';

export function resolveWindowsSigningMode(env = process.env, { requireOfficial = false } = {}) {
  const missing = REQUIRED.filter((key) => value(env, key) === '');
  if (missing.length === REQUIRED.length) {
    if (requireOfficial) {
      throw new Error(`Official Windows signing is required; missing: ${REQUIRED.join(', ')}`);
    }
    return { mode: 'unsigned-capable' };
  }
  if (missing.length) throw new Error(
    `Windows signing credentials must be all present or all absent; missing: ${missing.join(', ')}`
  );

  const expectedSubject = value(env, 'COS_WINDOWS_SIGNER_SUBJECT');
  if (/[\r\n\0]/.test(expectedSubject) || expectedSubject.length > 512) {
    throw new Error('COS_WINDOWS_SIGNER_SUBJECT must be one bounded certificate subject line');
  }
  const configuredThumbprint = value(env, 'COS_WINDOWS_CERTIFICATE_SHA1');
  if (!/^[0-9a-f \t:-]+$/i.test(configuredThumbprint)) {
    throw new Error('COS_WINDOWS_CERTIFICATE_SHA1 may contain only hex digits separated by whitespace, colon, or hyphen');
  }
  const expectedThumbprint = configuredThumbprint.replace(/[ \t:-]/g, '').toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(expectedThumbprint)) {
    throw new Error('COS_WINDOWS_CERTIFICATE_SHA1 must be exactly one SHA-1 certificate fingerprint (40 hex digits)');
  }

  return { mode: 'official', expectedSubject, expectedThumbprint };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const mode = resolveWindowsSigningMode(process.env, {
      requireOfficial: process.argv.includes('--require-official')
    });
    process.stdout.write(`windows-signing-mode=${mode.mode}\n`);
    if (mode.mode === 'official') process.stdout.write(`certificate-sha1=${mode.expectedThumbprint}\n`);
    if (process.argv.includes('--github-output')) {
      const output = value(process.env, 'GITHUB_OUTPUT');
      if (!output) throw new Error('GITHUB_OUTPUT is required with --github-output');
      appendFileSync(output, `mode=${mode.mode}\n`, 'utf8');
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
