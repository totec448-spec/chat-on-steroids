# Build a signed and notarized Mac candidate

The normal release remains ad-hoc sealed and unnotarized. This opt-in path requires
the publisher's Developer ID Application certificate and notarization access; it
does not change or provision repository secrets, Keychain access or release policy.

1. Make the certificate available to electron-builder through the signing Keychain
   or its documented `CSC_LINK` / `CSC_KEY_PASSWORD` mechanism. Set `CSC_NAME` to
   the certificate's owner name or fingerprint. A `Developer ID Application:`
   prefix is accepted and removed for electron-builder.
2. Supply one complete notarization credential set supported by electron-builder:
   `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER`, or
   `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`, or
   `APPLE_KEYCHAIN` / `APPLE_KEYCHAIN_PROFILE`. Keep credentials outside source and logs.
3. On the matching native Mac runner, run `npm run dist:mac:arm64 -- --signed-mac`
   (or `dist:mac:x64`). The command fails before packaging if required settings
   are absent. It requires real signing, hardened runtime, notarization, a stapled
   ticket, Gatekeeper acceptance and the existing packaged-runtime/bundle checks.
4. Before enabling a signed public release, prove two successive signed builds
   update under the same identity on both Mac architectures. Check launch, saved
   keys, Desktop permissions and rollback/recovery as well as package validity.

For GitHub-native builds, configure the publisher-owned `CSC_LINK` (base64 P12),
`CSC_KEY_PASSWORD`, `CSC_NAME`, `APPLE_API_KEY_BASE64` (base64 P8),
`APPLE_API_KEY_ID` and `APPLE_API_ISSUER` repository secrets. Dispatch the reviewed tag
through Publish release with `signed_macos: true`. The reusable candidate workflow
imports the signing certificate through electron-builder and materializes the P8
under runner temp with mode 0600, deleting it even on failure. Only explicitly
signed Mac jobs receive the credentials. Default releases and canaries stay unsigned.
Both the unpacked app and the apps extracted from DMG/ZIP must pass the signed audit;
unsigned candidates retain the existing unsigned-DMG assertion.

Do not upload a manually signed artifact into an existing release candidate. The
workflow builds and verifies its own artifacts from the reviewed tag before publication.
Update the release notes and public signing policy when first enabling this option.

An existing ad-hoc installation needs one user-approved installation of the first
signed release. Stable publisher signing enables later native updates and gives
macOS a durable signing identity; permission continuity still requires live proof.
