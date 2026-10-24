# cos-secrets

The Chat On Steroids credential store in Rust. It reads and writes `<userData>/secrets.bin` the
way `src/main/secrets.ts` does through Electron 44 async `safeStorage`. A user who moves from the
Electron app to the Rust app keeps the tunnel key, the OpenRouter and custom-provider keys, the
plugin credentials and the extension pairing. Electron can still read every file this crate
writes.

Windows is the only platform implemented. On macOS and Linux, every operation reports secure
storage as unavailable, with the reason `Unavailable::Unsupported`.

## API

`SecretStore` ports the API of `secrets.ts` for one profile:

| `secrets.ts` | `SecretStore` |
| --- | --- |
| `initSecretsPath(userData)` | `SecretStore::new(user_data)` |
| `getSecret`, `hasSecret` | `get`, `has` |
| `setSecret`, `clearSecret` | `set`, `clear` |
| `deleteAllSecrets` | `delete_all` |
| `secureStorageStatus` | `status`, which returns `cos_types::app_state::SecureStorageInfo` |
| `storedSecretsUnreadable` | `unreadable` |
| `setAsideUnreadableSecrets(now)` | `set_aside_unreadable(now)` |
| `cleanApiKey` | `clean_api_key` |
| `SecretKey` | `SecretKey`, an enum with `Plugin(rest)` and `Setup(rest)` for the two prefixed forms |

The methods take `&mut self`, so one owner serializes every read-modify-write. The TypeScript
mutation queue, single-flight load and load generations exist because its async calls interleave,
so this crate does not need them. To share a store across threads, put it behind a `Mutex`.

The store behaves the same way in these cases:

- An API key (`openaiApiKey`, `openRouterApiKey`, `customProviderApiKey` and `setup:*`) loses
  whitespace and invisible characters when it is written and when it is read. Other values are
  trimmed with JavaScript's `trim` set when they are written. An empty result removes the key.
- If `secrets.bin` is missing, the store is empty.
- If `secrets.bin` exists and the profile key cannot open it, the store is unreadable. This
  happens when the file is damaged or truncated, comes from another profile, has a foreign prefix
  such as `v20`, or decrypts to something other than a JSON object of strings. Reads return no
  credential. `set` and `clear` fail with `Error::Unreadable` and change nothing. The file stays
  where it is until the user asks for `set_aside_unreadable`. That call reads the file once more.
  If the file is still unreadable, it renames it to `secrets.unreadable-YYYYMMDD-HHMMSS-mmm.bin`
  (UTC) and starts an empty store. `delete_all` removes the file whether it is readable or not.
- Keys that this build does not know are kept, in their original order. A map that Electron wrote
  is written back with the same JSON bytes.

Electron sets `shouldReEncrypt` only when a different key provider sealed the file. On Windows,
Electron 44 registers one provider for the async API, so this crate has no rotation step.

## Format

`secrets.bin` contains these bytes:

| Bytes | Content |
| --- | --- |
| 3 | ASCII `v10` |
| 12 | Random AES-GCM nonce |
| n | AES-256-GCM ciphertext of the UTF-8 JSON, with no associated data |
| 16 | GCM tag |

The plaintext is `JSON.stringify` of a map from string to string. The sync `encryptString` that
CoS 2.0.0 and 2.0.1 used writes the same format.

## Key source

The AES key is in `<userData>/Local State`, a JSON file that Chromium owns:

- `os_crypt.encrypted_key` is the base64 of the ASCII bytes `DPAPI`, followed by a DPAPI blob
  that holds the 32-byte key. DPAPI seals the blob to the Windows user account, with no entropy.
  Any process that runs as that user can unwrap the key. Other users cannot, and the same user
  name on another computer cannot either.
- `os_crypt.audit_enabled` is `true`. Without this flag, Electron wraps the key again with
  `CRYPTPROTECT_AUDIT` on its next launch. The AES key stays the same.

Each profile has its own key, so a file copied between profiles cannot be read. Chromium's
App-Bound key provider (`v20`) is not in use.

A `Local State` whose key is usable is never written. In every other case, this crate does what
Electron 44 does:

| `Local State` | Result |
| --- | --- |
| Missing | A new file that holds only `os_crypt`, as Chromium writes on first launch. It is published with a hard link, so it never replaces a `Local State` that Electron created in the meantime. Electron adopts the key unchanged. |
| Rejected by Chromium's JSON parser | The file moves to `Local State.bad`, replacing an older one, and a new file that holds only `os_crypt` takes its place. |
| A JSON object with no `os_crypt.encrypted_key` | A new key goes into `os_crypt`, with `audit_enabled` set to `true`. Every other entry stays. |
| A key that DPAPI cannot unwrap | The same: the new key replaces the old one, and every other entry stays. |

After a new key, the old `secrets.bin` is unreadable, which leads to the set-aside flow.

Chromium reads `Local State` with `JSON_PARSE_CHROMIUM_EXTENSIONS`. It accepts a UTF-8 BOM,
comments, CR and LF inside strings, and `\x` escapes. It rejects trailing commas, other control
characters, `\v`, lone surrogates and numbers out of range. This crate parses with
`serde_json_lenient` set to the same options. The unit tests pin each case to what Electron 44
did with it.

### Deliberate difference from Electron

Electron can neither use nor replace a key in these cases: the JSON root or `os_crypt` is not an
object, or `encrypted_key` is not a string, is empty, is not base64, or lacks the `DPAPI` prefix.
Electron leaves `Local State` as it is, but still reports secure storage as available. It calls
`secrets.bin` unreadable and sets it aside on request. Then every write fails, or, for a root
that is not an object, succeeds under a key that the next launch cannot see. In the same cases,
this crate reports secure storage as unavailable (`Unavailable::LocalState`) and changes no file,
so `secrets.bin` stays in place. The differential test pins both behaviors.

A key that DPAPI unwraps to something other than 32 bytes is also reported as unavailable. The
differential test does not cover it, because a test cannot make Electron write such a key.

### Key material in memory

The AES key, the DPAPI output buffer, the decrypted JSON and the AES round keys are wiped when
they are dropped (`zeroize`, and the `zeroize` features of `aes` and `aes-gcm`). The decrypted
values in the store's map are ordinary `String`s, as they are in the TypeScript process.

## macOS and Linux (research only, not verified)

- **macOS:** Electron keeps a password in the login Keychain, in an item named after the app
  ("<name> Safe Storage"). The sync format derives an AES-128-CBC key from that password with
  PBKDF2-HMAC-SHA1 (salt `saltysalt`, 1003 iterations, an IV of 16 spaces) and adds the prefix
  `v10`. The async `KeychainKeyProvider` might use a different key and format. The access list
  of the Keychain item trusts the code signature of the Electron app. The first read from a Rust
  binary will probably show a Keychain prompt.
- **Linux:** the async API tries the Secret Portal first, then Secret Service or KWallet. The
  last fallback is a `v10` provider with a hard-coded key, and `secrets.ts` rejects it
  (`secureStorageCiphertextIsProtected`). The port must reject that prefix on Linux too. Linux
  support started in CoS 2.0.2. The sync libsecret format used the prefix `v11`, with PBKDF2 (one
  iteration) and AES-128-CBC. The async provider format still needs a check on a Linux host.

## Tests

- `cargo test -p cos-secrets`: the format, the JavaScript string rules (checked over every code
  point against sets that the TypeScript regex and `trim` produced), the set-aside file name, and
  the store against real files and DPAPI in throwaway profiles.
- `differential/roundtrip.mjs` runs the real `src/main/secrets.ts` in a headless Electron with no
  window, bundled with esbuild, next to `examples/secrets_ops.rs`. Each scenario runs the same
  operations on two copies of one profile. The test requires the same results, the same
  `secrets*` files, the same plaintext as Electron decrypts it, and the same `Local State` and
  `Local State.bad`. In `Local State`, the key is compared as "the seed's key" or "a new DPAPI
  key", because each side wraps its own random key. Electron's
  `uninstall_metrics.installation_date2` is ignored, because Electron adds it on every launch,
  also to a file whose key is usable. Scenarios cover reading files that Electron's async and
  sync APIs wrote, a fresh profile on each side, Electron adopting a key that Rust created,
  damaged, foreign, truncated and non-map files, set-aside, delete-all, and every `Local State`
  case above.

To run the differential test from the repository root, after `npm ci`:

```sh
cargo build -p cos-secrets --example secrets_ops --manifest-path rust/Cargo.toml
node rust/crates/cos-secrets/differential/roundtrip.mjs
```

It uses only dummy values and throwaway profiles under `.tmp/cos-secrets-differential`. It never
opens the real Chat On Steroids profile.
