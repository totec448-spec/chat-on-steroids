//! `userData/control-api/`: the per-launch token and `endpoint.json`.
//!
//! The token is written before `endpoint.json`, and `endpoint.json` is removed first, so a
//! caller that finds an endpoint always finds its token.

use std::io;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use cos_types::control_api::ControlApiEndpoint;

const DIRECTORY: &str = "control-api";
const TOKEN_FILE: &str = "token";
const ENDPOINT_FILE: &str = "endpoint.json";

/// The bearer token of one listener: 32 random bytes, base64url without padding.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Token(String);

impl Token {
    pub(crate) fn generate() -> io::Result<Self> {
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
        Ok(Self(URL_SAFE_NO_PAD.encode(bytes)))
    }

    /// Whether an `Authorization` value is `Bearer <this token>`, compared in constant time.
    pub(crate) fn accepts(&self, authorization: &[u8]) -> bool {
        let Some(given) = authorization.strip_prefix(b"Bearer ") else {
            return false;
        };
        let expected = self.0.as_bytes();
        given.len() == expected.len()
            && given
                .iter()
                .zip(expected)
                .fold(0u8, |difference, (a, b)| difference | (a ^ b))
                == 0
    }
}

impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Token(..)")
    }
}

/// The folder that holds both files.
#[derive(Clone, Debug)]
pub(crate) struct EndpointFiles {
    directory: PathBuf,
}

impl EndpointFiles {
    pub(crate) fn under(user_data: &Path) -> Self {
        Self {
            directory: user_data.join(DIRECTORY),
        }
    }

    /// Token first, then the endpoint. Either write replaces the file whole.
    pub(crate) async fn publish(
        &self,
        token: &Token,
        endpoint: &ControlApiEndpoint,
    ) -> io::Result<()> {
        self.write_private(TOKEN_FILE, &format!("{}\n", token.0))
            .await?;
        let text = serde_json::to_string_pretty(endpoint).map_err(io::Error::other)?;
        self.write_private(ENDPOINT_FILE, &format!("{text}\n"))
            .await
    }

    /// Endpoint first: a caller that can no longer discover the port stops trying.
    pub(crate) async fn remove(&self) -> io::Result<()> {
        remove_if_present(&self.directory.join(ENDPOINT_FILE)).await?;
        remove_if_present(&self.directory.join(TOKEN_FILE)).await
    }

    async fn write_private(&self, name: &str, content: &str) -> io::Result<()> {
        let target = self.directory.join(name);
        let temp = self
            .directory
            .join(format!("{name}.{}.tmp", std::process::id()));
        tokio::fs::create_dir_all(&self.directory).await?;
        // userData is already private to the user; Windows has no mode bits to set.
        tokio::fs::write(&temp, content).await?;
        tokio::fs::rename(&temp, &target).await
    }
}

async fn remove_if_present(file: &Path) -> io::Result<()> {
    match tokio::fs::remove_file(file).await {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_is_43_base64url_characters_and_differs_each_time() {
        let first = Token::generate().expect("random bytes");
        let second = Token::generate().expect("random bytes");
        assert_eq!(first.0.len(), 43);
        assert!(
            first
                .0
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        );
        assert_ne!(first, second);
    }

    #[test]
    fn only_the_exact_bearer_value_is_accepted() {
        let token = Token::generate().expect("random bytes");
        let exact = format!("Bearer {}", token.0);
        assert!(token.accepts(exact.as_bytes()));
        assert!(!token.accepts(token.0.as_bytes()));
        assert!(!token.accepts(format!("bearer {}", token.0).as_bytes()));
        assert!(!token.accepts(format!("{exact}x").as_bytes()));
        assert!(!token.accepts(b""));
    }
}
