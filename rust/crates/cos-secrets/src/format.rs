//! The bytes of `secrets.bin`: `v10`, a 12-byte nonce, then AES-256-GCM ciphertext and its
//! 16-byte tag, with no associated data. The plaintext is `JSON.stringify` of a string map.

use aes_gcm::aead::{Aead, AeadCore, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use zeroize::Zeroizing;

use crate::SecretMap;
use crate::key::MasterKey;

const V10: &[u8] = b"v10";
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

#[derive(Debug, PartialEq)]
pub(crate) enum OpenError {
    NotV10,
    Truncated,
    /// AES-GCM authentication failed: another profile's key, or a damaged file.
    Decrypt,
    /// The plaintext is not a JSON object of strings, which `parseSecretStore` also rejects.
    NotStringMap,
}

/// `safeStorage.decryptStringAsync` followed by `parseSecretStore`.
pub(crate) fn open(key: &MasterKey, blob: &[u8]) -> Result<SecretMap, OpenError> {
    let body = blob.strip_prefix(V10).ok_or(OpenError::NotV10)?;
    if body.len() < NONCE_LEN + TAG_LEN {
        return Err(OpenError::Truncated);
    }
    let (nonce, sealed) = body.split_at(NONCE_LEN);
    let plaintext = Zeroizing::new(
        key.cipher()
            .decrypt(Nonce::from_slice(nonce), sealed)
            .map_err(|_| OpenError::Decrypt)?,
    );
    serde_json::from_slice(&plaintext).map_err(|_| OpenError::NotStringMap)
}

/// `safeStorage.encryptStringAsync(JSON.stringify(values))`.
pub(crate) fn seal(key: &MasterKey, values: &SecretMap) -> Vec<u8> {
    let plaintext =
        Zeroizing::new(serde_json::to_vec(values).expect("a string map always serializes"));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let sealed = key
        .cipher()
        .encrypt(&nonce, plaintext.as_slice())
        .expect("AES-GCM encryption of an in-memory buffer cannot fail");
    [V10, nonce.as_slice(), &sealed].concat()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> MasterKey {
        MasterKey::from_bytes([7; 32])
    }

    fn map(entries: &[(&str, &str)]) -> SecretMap {
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn seal_plaintext(plaintext: &[u8]) -> Vec<u8> {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        [
            V10,
            nonce.as_slice(),
            &key().cipher().encrypt(&nonce, plaintext).unwrap(),
        ]
        .concat()
    }

    #[test]
    fn a_sealed_map_opens_to_the_same_map_in_the_same_order() {
        let values = map(&[("b", "2"), ("a", "é\"\n\u{1}😀")]);
        let blob = seal(&key(), &values);
        assert_eq!(&blob[..3], b"v10");
        assert_eq!(
            blob.len(),
            3 + NONCE_LEN + serde_json::to_vec(&values).unwrap().len() + TAG_LEN
        );
        let opened = open(&key(), &blob).unwrap();
        assert_eq!(opened.keys().collect::<Vec<_>>(), ["b", "a"]);
        assert_eq!(opened, values);
    }

    #[test]
    fn two_seals_of_one_map_use_different_nonces() {
        let values = map(&[("k", "v")]);
        assert_ne!(seal(&key(), &values), seal(&key(), &values));
    }

    #[test]
    fn a_flipped_byte_or_another_key_fails_authentication() {
        let blob = seal(&key(), &map(&[("k", "v")]));
        for at in [3, 3 + NONCE_LEN, blob.len() - 1] {
            let mut damaged = blob.clone();
            damaged[at] ^= 1;
            assert_eq!(open(&key(), &damaged), Err(OpenError::Decrypt), "byte {at}");
        }
        assert_eq!(
            open(&MasterKey::from_bytes([8; 32]), &blob),
            Err(OpenError::Decrypt)
        );
    }

    #[test]
    fn short_or_unprefixed_blobs_are_rejected_before_decrypting() {
        assert_eq!(open(&key(), b""), Err(OpenError::NotV10));
        assert_eq!(
            open(&key(), b"v11................................"),
            Err(OpenError::NotV10)
        );
        assert_eq!(
            open(
                &key(),
                &[b"v10".as_slice(), &[0; NONCE_LEN + TAG_LEN - 1]].concat()
            ),
            Err(OpenError::Truncated)
        );
    }

    #[test]
    fn plaintext_that_parse_secret_store_rejects_is_rejected() {
        for plaintext in [
            r#"{"k":1}"#,
            r#"{"k":null}"#,
            "[]",
            "null",
            "\"text\"",
            "{",
            "",
        ] {
            assert_eq!(
                open(&key(), &seal_plaintext(plaintext.as_bytes())),
                Err(OpenError::NotStringMap),
                "{plaintext}"
            );
        }
    }

    #[test]
    fn an_empty_object_and_whitespace_around_it_are_accepted() {
        assert_eq!(open(&key(), &seal_plaintext(b" {} ")), Ok(SecretMap::new()));
    }
}
