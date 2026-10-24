//! The AES-256 key that Chromium's OSCrypt keeps for one profile in `<userData>/Local State`.

use std::fmt;
use std::io;

use aes_gcm::aead::KeyInit;
use aes_gcm::{Aes256Gcm, Key};
use zeroize::Zeroizing;

pub(crate) use platform::load_or_create;

const KEY_LEN: usize = 32;

pub(crate) struct MasterKey(Zeroizing<[u8; KEY_LEN]>);

impl MasterKey {
    pub(crate) fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(self.0.as_ref()))
    }

    #[cfg(test)]
    pub(crate) fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(Zeroizing::new(bytes))
    }
}

/// Why secure storage cannot supply the profile key, the case where Electron's
/// `isAsyncEncryptionAvailable()` is false.
#[derive(Debug)]
pub enum Unavailable {
    /// Only the Windows format is implemented. macOS (Keychain) and Linux (Secret Service, with
    /// its insecure `v10` fallback rejected as `secrets.ts` does) come later.
    Unsupported {
        os: &'static str,
    },
    /// `Local State` has a shape that Electron can neither use nor replace: the root or
    /// `os_crypt` is not an object, or the key is not a base64 string of the `DPAPI` prefix and
    /// a 32-byte key. The file is left as it is.
    LocalState(&'static str),
    /// DPAPI could not wrap a new key.
    Dpapi(String),
    Io(io::Error),
}

impl fmt::Display for Unavailable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Unavailable::Unsupported { os } => {
                write!(f, "secure credential storage is not supported on {os} yet")
            }
            Unavailable::LocalState(why) => write!(f, "Local State has no usable key: {why}"),
            Unavailable::Dpapi(why) => write!(f, "Windows DPAPI could not wrap a new key: {why}"),
            Unavailable::Io(error) => {
                write!(f, "Local State could not be read or written: {error}")
            }
        }
    }
}

impl std::error::Error for Unavailable {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Unavailable::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for Unavailable {
    fn from(error: io::Error) -> Self {
        Unavailable::Io(error)
    }
}

#[cfg(windows)]
mod platform {
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};

    use aes_gcm::aead::OsRng;
    use aes_gcm::aead::rand_core::RngCore;
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use serde::Deserialize;
    use serde_json::{Map, Value};
    use zeroize::Zeroizing;

    use super::{KEY_LEN, MasterKey, Unavailable};

    const LOCAL_STATE_FILE: &str = "Local State";
    /// Where Chromium's `JsonPrefStore` moves a `Local State` that it cannot parse.
    const BAD_FILE: &str = "Local State.bad";
    const DPAPI_PREFIX: &[u8] = b"DPAPI";
    const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

    /// Reads the profile key, or stores a new one in the cases where Electron does:
    ///
    /// - no `Local State`: a new file that holds only `os_crypt`;
    /// - a `Local State` that Chromium's JSON parser rejects: the file moves to
    ///   `Local State.bad` and a new one takes its place;
    /// - a JSON object without `os_crypt.encrypted_key`, or with a key that DPAPI cannot unwrap:
    ///   the new key goes into the same object, and every other entry stays.
    ///
    /// A `Local State` whose key is usable is never written.
    pub(crate) fn load_or_create(user_data: &Path) -> Result<MasterKey, Unavailable> {
        let path = user_data.join(LOCAL_STATE_FILE);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return create(user_data, &path);
            }
            Err(error) => return Err(error.into()),
        };
        let Some(state) = parse_like_chromium(&bytes) else {
            fs::rename(&path, path.with_file_name(BAD_FILE))?;
            return create(user_data, &path);
        };
        // Electron keeps a JSON root that is not an object read-only and seals secrets.bin with
        // a key it never saves, so its next launch cannot read them. Unavailable loses nothing.
        let Value::Object(mut state) = state else {
            return Err(Unavailable::LocalState("the file is not a JSON object"));
        };
        if let Slot::Usable(key) = slot(&state)? {
            return Ok(key);
        }
        let key = store_new_key(&mut state)?;
        let tmp = write_tmp(&path, &state)?;
        fs::rename(&tmp, &path)?;
        Ok(key)
    }

    /// Chromium's `JSON_PARSE_CHROMIUM_EXTENSIONS`, which `JsonPrefStore` reads with: a UTF-8
    /// BOM, comments, CR and LF inside strings and `\x` escapes are accepted. Trailing commas,
    /// other control characters, `\v` and lone surrogates are not. `None` where Chromium fails.
    fn parse_like_chromium(bytes: &[u8]) -> Option<Value> {
        let bytes = bytes.strip_prefix(UTF8_BOM).unwrap_or(bytes);
        let mut parser = serde_json_lenient::Deserializer::from_slice_with_options(
            bytes, false, true, false, false, true,
        );
        parser.set_ignore_trailing_commas(false);
        parser.set_allow_comments(true);
        let value = Value::deserialize(&mut parser).ok()?;
        parser.end().ok()?;
        Some(value)
    }

    /// What the key in a `Local State` object means to Electron.
    enum Slot {
        Usable(MasterKey),
        /// No `os_crypt.encrypted_key`, or DPAPI cannot unwrap it. Electron stores a new key.
        Replace,
    }

    /// A key that is not a string, not base64 or lacks the `DPAPI` prefix makes Electron's
    /// encryption fail without writing `Local State`, so it reports unavailable here.
    fn slot(state: &Map<String, Value>) -> Result<Slot, Unavailable> {
        let os_crypt = match state.get("os_crypt") {
            None => return Ok(Slot::Replace),
            Some(Value::Object(os_crypt)) => os_crypt,
            Some(_) => return Err(Unavailable::LocalState("os_crypt is not an object")),
        };
        let encoded = match os_crypt.get("encrypted_key") {
            None => return Ok(Slot::Replace),
            Some(Value::String(encoded)) => encoded,
            Some(_) => {
                return Err(Unavailable::LocalState(
                    "os_crypt.encrypted_key is not a string",
                ));
            }
        };
        let wrapped = BASE64
            .decode(encoded)
            .map_err(|_| Unavailable::LocalState("os_crypt.encrypted_key is not base64"))?;
        let sealed = wrapped
            .strip_prefix(DPAPI_PREFIX)
            .ok_or(Unavailable::LocalState(
                "os_crypt.encrypted_key lacks the DPAPI prefix",
            ))?;
        let Ok(plain) = dpapi::unprotect(sealed) else {
            return Ok(Slot::Replace);
        };
        if plain.len() != KEY_LEN {
            return Err(Unavailable::LocalState(
                "os_crypt.encrypted_key does not hold 32 bytes",
            ));
        }
        let mut key = Zeroizing::new([0; KEY_LEN]);
        key.copy_from_slice(&plain);
        Ok(Slot::Usable(MasterKey(key)))
    }

    /// Generates a key and sets `os_crypt.encrypted_key` and `os_crypt.audit_enabled` in
    /// `state`, as `OSCryptImpl::Init` does. `slot` has already refused an `os_crypt` that is
    /// not an object. `audit_enabled` stops Electron from wrapping the key a second time.
    fn store_new_key(state: &mut Map<String, Value>) -> Result<MasterKey, Unavailable> {
        let mut key = Zeroizing::new([0; KEY_LEN]);
        OsRng.fill_bytes(key.as_mut());
        let mut wrapped = DPAPI_PREFIX.to_vec();
        wrapped.extend_from_slice(&dpapi::protect(key.as_ref())?);
        let os_crypt = state
            .entry("os_crypt")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or(Unavailable::LocalState("os_crypt is not an object"))?;
        os_crypt.insert("audit_enabled".into(), Value::Bool(true));
        os_crypt.insert("encrypted_key".into(), BASE64.encode(wrapped).into());
        Ok(MasterKey(key))
    }

    /// A new `Local State` that holds only `os_crypt`, as Chromium writes on first launch.
    fn create(user_data: &Path, path: &Path) -> Result<MasterKey, Unavailable> {
        let mut state = Map::new();
        let key = store_new_key(&mut state)?;
        fs::create_dir_all(user_data)?;
        // A hard link publishes the finished file without replacing one that Electron created
        // meanwhile. In that race this key is discarded and the other file decides.
        let tmp = write_tmp(path, &state)?;
        let published = fs::hard_link(&tmp, path);
        fs::remove_file(&tmp)?;
        match published {
            Ok(()) => Ok(key),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => load_or_create(user_data),
            Err(error) => Err(error.into()),
        }
    }

    fn write_tmp(path: &Path, state: &Map<String, Value>) -> io::Result<PathBuf> {
        let tmp = path.with_file_name(format!("{LOCAL_STATE_FILE}.{}.tmp", std::process::id()));
        fs::write(&tmp, serde_json::to_vec(state)?)?;
        Ok(tmp)
    }

    mod dpapi {
        use windows::Win32::Foundation::{HLOCAL, LocalFree};
        use windows::Win32::Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_AUDIT, CryptProtectData, CryptUnprotectData,
        };
        use windows::core::w;
        use zeroize::{Zeroize, Zeroizing};

        use super::Unavailable;

        fn input(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
            CRYPT_INTEGER_BLOB {
                cbData: bytes.len() as u32,
                pbData: bytes.as_ptr().cast_mut(),
            }
        }

        /// Copies DPAPI's output, wipes its buffer and frees it.
        fn take(output: CRYPT_INTEGER_BLOB) -> Zeroizing<Vec<u8>> {
            // SAFETY: DPAPI returned `cbData` bytes at `pbData`, allocated with LocalAlloc and
            // owned by the caller from here on.
            unsafe {
                let bytes = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
                let copy = Zeroizing::new(bytes.to_vec());
                bytes.zeroize();
                LocalFree(Some(HLOCAL(output.pbData.cast())));
                copy
            }
        }

        /// The call Chromium's `DPAPIKeyProvider` makes: no entropy, no prompt, flags 0.
        pub(super) fn unprotect(sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, Unavailable> {
            let mut output = CRYPT_INTEGER_BLOB::default();
            // SAFETY: `input` borrows `sealed` for the duration of the call; `output` is written
            // by DPAPI and released by `take`.
            unsafe { CryptUnprotectData(&input(sealed), None, None, None, None, 0, &mut output) }
                .map_err(|error| Unavailable::Dpapi(error.to_string()))?;
            Ok(take(output))
        }

        /// The wrap Electron applies once `os_crypt.audit_enabled` is set, so Electron keeps it.
        pub(super) fn protect(plain: &[u8]) -> Result<Zeroizing<Vec<u8>>, Unavailable> {
            let mut output = CRYPT_INTEGER_BLOB::default();
            // SAFETY: as in `unprotect`.
            unsafe {
                CryptProtectData(
                    &input(plain),
                    w!("Chromium"),
                    None,
                    None,
                    None,
                    CRYPTPROTECT_AUDIT,
                    &mut output,
                )
            }
            .map_err(|error| Unavailable::Dpapi(error.to_string()))?;
            Ok(take(output))
        }
    }

    #[cfg(test)]
    mod tests {
        use serde_json::json;

        use super::parse_like_chromium;

        #[test]
        fn local_state_parses_where_electron_44_parses_it() {
            // Each input was written as Local State and run through Electron 44: these parsed,
            // and Electron stored its key beside the value shown.
            for (text, value) in [
                ("{\"a\":1}", json!({"a": 1})),
                ("\u{feff}/* c */{\"a\":1}", json!({"a": 1})),
                ("{\"a\":1 // c\n}", json!({"a": 1})),
                ("  \n{\"a\":1}\n\n", json!({"a": 1})),
                (
                    "{\"a\":\"x\ny\",\"b\":\"x\ry\"}",
                    json!({"a": "x\ny", "b": "x\ry"}),
                ),
                ("{\"a\":\"\\x41\"}", json!({"a": "A"})),
                ("{\"a\":\"\\u2028\\u0001\"}", json!({"a": "\u{2028}\u{1}"})),
                ("{\"a\":1,\"a\":2}", json!({"a": 2})),
                (
                    "{\"a\":[2.5,1e300,true,null]}",
                    json!({"a": [2.5, 1e300, true, null]}),
                ),
                ("[1,2]", json!([1, 2])),
                ("null", json!(null)),
            ] {
                assert_eq!(
                    parse_like_chromium(text.as_bytes()),
                    Some(value),
                    "{text:?}"
                );
            }
        }

        #[test]
        fn local_state_is_rejected_where_electron_44_moves_it_to_local_state_bad() {
            for text in [
                "",
                "   ",
                "/* c */",
                "{not json",
                "{\"a\":1,}",
                "{\"a\":1} x",
                "{'a':1}",
                "{\"a\":NaN}",
                "{\"a\":1e400}",
                "{\"a\":\"x\ty\"}",
                "{\"a\":\"x\u{1}y\"}",
                "{\"a\":\"x\u{0}y\"}",
                "{\"a\":\"\\v\"}",
                "{\"a\":\"\\ud800\"}",
            ] {
                assert_eq!(parse_like_chromium(text.as_bytes()), None, "{text:?}");
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use std::path::Path;

    use super::{MasterKey, Unavailable};

    pub(crate) fn load_or_create(_: &Path) -> Result<MasterKey, Unavailable> {
        Err(Unavailable::Unsupported {
            os: std::env::consts::OS,
        })
    }
}
