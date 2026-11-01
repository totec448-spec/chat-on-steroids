import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-ignore Packaging scripts are plain ESM.
import { signedMacConfig } from '../scripts/signed-mac-config.mjs';
// @ts-ignore Packaging scripts are plain ESM.
import { prepareMacSigning } from '../scripts/prepare-mac-signing.mjs';

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
it('isolates the CI notarization file and exports only its path, never its bytes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cos-signing-'));
  try {
    const pem = '-----BEGIN PRIVATE KEY-----\ntest-only-not-a-real-key\n-----END PRIVATE KEY-----';
    const env = { ...identity, ...api, CSC_LINK: 'test-certificate', CSC_KEY_PASSWORD: 'test-only',
      APPLE_API_KEY_BASE64: Buffer.from(pem).toString('base64'), RUNNER_TEMP: root, GITHUB_ENV: path.join(root, 'env') };
    const dir = prepareMacSigning(env);
    expect(readFileSync(path.join(dir, 'AuthKey.p8'), 'utf8')).toBe(pem);
    if (process.platform !== 'win32') expect(statSync(path.join(dir, 'AuthKey.p8')).mode & 0o777).toBe(0o600);
    const published = readFileSync(env.GITHUB_ENV, 'utf8');
    expect(published).toContain(`APPLE_API_KEY=${path.join(dir, 'AuthKey.p8')}`);
    expect(published).not.toContain(pem);
    expect(() => prepareMacSigning({ ...env, APPLE_API_KEY_BASE64: 'not base64!' })).toThrow('base64');
    expect(readdirSync(root).filter(name => name.startsWith('cos-notary-'))).toEqual([path.basename(dir)]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('keeps unsigned workflow defaults and passes signing secrets only to an explicit native Mac build', () => {
  for (const name of ['release', 'publish']) {
    const workflow = readFileSync(`.github/workflows/${name}.yml`, 'utf8');
    expect(workflow).toMatch(/signed_macos:[\s\S]*?default: false/);
  }
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
  expect(workflow).toContain("if: matrix.platform == 'darwin' && inputs.signed_macos");
  expect(workflow).toContain("matrix.platform == 'darwin' && inputs.signed_macos && secrets.CSC_LINK || ''");
  expect(workflow).toContain("if: always() && matrix.platform == 'darwin' && inputs.signed_macos");
  expect(workflow).toContain('"${signed_args[@]}"');
});
