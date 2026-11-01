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
4. Before changing the public release workflow, prove two successive signed builds
   update under the same identity on both Mac architectures. Check launch, saved
   keys, Desktop permissions and rollback/recovery as well as package validity.

Do not upload a manually signed artifact into an existing release candidate.
The release workflow must build and verify its own signed artifacts from the reviewed
tag before publication. Its current unsigned-DMG assertions must remain until that
workflow is explicitly migrated; this opt-in packaging command does not migrate it.

An existing ad-hoc installation needs one user-approved installation of the first
signed release. Stable publisher signing enables later native updates and gives
macOS a durable signing identity; permission continuity still requires live proof.
