import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-ignore Packaging scripts are plain ESM.
import { signedMacConfig } from '../scripts/signed-mac-config.mjs';

const identity = { CSC_NAME: 'Example Publisher (TEAMID)' };
const api = { APPLE_API_KEY: '/home/you/AuthKey.p8', APPLE_API_KEY_ID: 'KEYID', APPLE_API_ISSUER: 'ISSUER' };

it('opts into real signing, hardened runtime and notarization without embedding credentials', () => {
  const config = signedMacConfig({ ...identity, ...api });
  expect(config).toEqual({ extends: './electron-builder.yml', forceCodeSigning: true,
    mac: { identity: identity.CSC_NAME, notarize: true, hardenedRuntime: true } });
  expect(JSON.stringify(config)).not.toContain('AuthKey');
});
it('normalizes the certificate prefix that electron-builder refuses', () => {
  expect(signedMacConfig({ ...api, CSC_NAME: `Developer ID Application: ${identity.CSC_NAME}` }).mac.identity).toBe(identity.CSC_NAME);
});
it.each(['', '-', '   '])('rejects an absent or ad-hoc identity: %j', name => {
  expect(() => signedMacConfig({ ...api, CSC_NAME: name })).toThrow('requires CSC_NAME');
});
it('rejects disabled identity discovery and missing or incomplete notarization credentials', () => {
  expect(() => signedMacConfig({ ...identity, ...api, CSC_IDENTITY_AUTO_DISCOVERY: 'false' })).toThrow('requires CSC_NAME');
  expect(() => signedMacConfig(identity)).toThrow('complete electron-builder notarization credentials');
  for (const key of Object.keys(api)) {
    expect(() => signedMacConfig({ ...identity, ...api, [key]: '' })).toThrow('complete electron-builder notarization credentials');
  }
});
it.each([
  { APPLE_ID: 'you@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'test-only', APPLE_TEAM_ID: 'TEAMID' },
  { APPLE_KEYCHAIN: '/home/you/signing.keychain-db', APPLE_KEYCHAIN_PROFILE: 'notary' }
])('accepts a complete alternative notarization mechanism', credentials => {
  expect(signedMacConfig({ ...identity, ...credentials }).mac.notarize).toBe(true);
});
it('keeps unsigned packaging as the default and explicitly audits signed candidates', () => {
  const base = readFileSync('electron-builder.yml', 'utf8');
  expect(base).toContain('identity: null');
  expect(base).toContain('notarize: false');
  const packaging = readFileSync('scripts/package.mjs', 'utf8');
  expect(packaging).toContain("args.includes('--signed-mac')");
  expect(packaging).toContain("if (signedMac) builderArgs.push('--config', 'electron-builder.signed-mac.mjs')");
  const audit = readFileSync('scripts/smoke-macos-bundle.mjs', 'utf8');
  expect(audit).toContain("['stapler', 'validate', app]");
  expect(audit).toContain("['--assess', '--type', 'execute', '--verbose=2', app]");
});
