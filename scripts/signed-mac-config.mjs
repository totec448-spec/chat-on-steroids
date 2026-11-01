/** Explicit opt-in; the ordinary unsigned release never discovers signing credentials. */
export function signedMacConfig(env = process.env) {
  const identity = env.CSC_NAME?.trim().replace(/^Developer ID Application:\s*/, '');
  if (!identity || identity === '-' || env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
    throw new Error('Signed macOS packaging requires CSC_NAME identifying a Developer ID Application certificate');
  }
  const notarization = [
    ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
    ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
    ['APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE']
  ].some(keys => keys.every(key => env[key]?.trim()));
  if (!notarization) throw new Error('Signed macOS packaging requires complete electron-builder notarization credentials');
  return {
    extends: './electron-builder.yml',
    forceCodeSigning: true,
    mac: { identity, notarize: true, hardenedRuntime: true }
  };
}
