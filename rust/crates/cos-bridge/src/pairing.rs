//! The bearer token `/pair` issues, kept as `bridgeToken` in `secrets.bin`, and the explicit
//! Disconnect latch stored in the same slot (`bridge.ts`: `/pair`, `authorised`, `unpair`).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use cos_secrets::{SecretKey, SecretStore};
use cos_types::app_state::SecureStorageInfo;
use subtle::ConstantTimeEq;

/// Generated tokens are base64url, so `!` can never collide with one. Keeping the latch in the
/// credential slot makes revocation and pairing one source of truth across restarts.
const BROWSER_DISCONNECTED: &str = "!browser-disconnected";

/// What the `bridgeToken` slot holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Stored {
    Absent,
    /// The user pressed Disconnect. Only an explicit reconnect clears it.
    Disconnected,
    Token(String),
}

impl Stored {
    fn from_slot(value: Option<String>) -> Self {
        match value {
            None => Self::Absent,
            Some(value) if value == BROWSER_DISCONNECTED => Self::Disconnected,
            Some(token) => Self::Token(token),
        }
    }
}

/// A request's bearer, judged against the stored token.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Authorization {
    Granted,
    /// `401 browser_disconnected`, so the extension latches instead of silently re-pairing.
    Disconnected,
    /// `401 unauthorised`.
    Refused,
}

/// What `POST /pair` asks for, from its body.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct PairIntent {
    /// The popup's Connect: clears a Disconnect and always mints a new token.
    pub(crate) reconnect: bool,
    /// Automatic provisioning: join the current token so browser profiles do not revoke one
    /// another.
    pub(crate) reuse: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Paired {
    Token {
        token: String,
        reused: bool,
    },
    /// `409 browser_disconnected`.
    Disconnected,
    /// `503 secure_storage_unavailable` with this message.
    StorageUnavailable(String),
    /// Writing `secrets.bin` failed: `500 internal`, as an exception in `handle()` is.
    Failed(String),
}

/// The pairing state over the Core's one secret store.
pub(crate) struct Pairing {
    secrets: Arc<Mutex<SecretStore>>,
    /// Bumped by Disconnect. A pairing that started before it may not report success.
    epoch: AtomicU64,
    /// `withBrowserCredentials`: pair and disconnect read-modify-write the slot one at a time.
    queue: tokio::sync::Mutex<()>,
    /// The last value read or written, for status. False until the first read.
    paired: AtomicBool,
}

impl Pairing {
    pub(crate) fn new(secrets: Arc<Mutex<SecretStore>>) -> Self {
        Self {
            secrets,
            epoch: AtomicU64::new(0),
            queue: tokio::sync::Mutex::new(()),
            paired: AtomicBool::new(false),
        }
    }

    /// Whether a usable token is stored, as of the last read or write.
    pub(crate) fn paired(&self) -> bool {
        self.paired.load(Ordering::Relaxed)
    }

    pub(crate) async fn stored(&self) -> Stored {
        let stored = self
            .with_store(|store| Stored::from_slot(store.get(&SecretKey::BridgeToken)))
            .await;
        self.note(&stored);
        stored
    }

    pub(crate) async fn authorize(&self, header: Option<&str>) -> Authorization {
        match self.stored().await {
            Stored::Disconnected => Authorization::Disconnected,
            Stored::Token(token)
                if header
                    .and_then(|header| header.strip_prefix("Bearer "))
                    .is_some_and(|presented| same(presented, &token)) =>
            {
                Authorization::Granted
            }
            Stored::Absent | Stored::Token(_) => Authorization::Refused,
        }
    }

    /// The first wake frame: the bearer token itself.
    pub(crate) async fn wake_token_matches(&self, candidate: &str) -> bool {
        matches!(self.stored().await, Stored::Token(token) if same(candidate, &token))
    }

    /// `POST /pair` after its protocol, rate and body checks.
    pub(crate) async fn pair(&self, intent: PairIntent) -> Paired {
        let epoch = self.epoch.load(Ordering::SeqCst);
        if self.stored().await == Stored::Disconnected && !intent.reconnect {
            return Paired::Disconnected;
        }
        let storage: SecureStorageInfo = self.with_store(SecretStore::status).await;
        if !storage.available {
            return Paired::StorageUnavailable(
                storage
                    .detail
                    .unwrap_or_else(|| "Secure credential storage is unavailable.".into()),
            );
        }
        let reuse = !intent.reconnect && intent.reuse;
        let _turn = self.queue.lock().await;
        let stored = self.stored().await;
        if self.epoch.load(Ordering::SeqCst) != epoch
            || (stored == Stored::Disconnected && !intent.reconnect)
        {
            return Paired::Disconnected;
        }
        let (token, reused) = match stored {
            Stored::Token(token) if reuse => (token, true),
            _ => (new_token(), false),
        };
        if !reused {
            let value = token.clone();
            let written = self
                .with_store(move |store| store.set(&SecretKey::BridgeToken, &value))
                .await;
            if let Err(error) = written {
                return Paired::Failed(error.to_string());
            }
            self.note(&Stored::Token(token.clone()));
        }
        if self.epoch.load(Ordering::SeqCst) != epoch {
            return Paired::Disconnected;
        }
        Paired::Token { token, reused }
    }

    /// `unpair`: latches Disconnect, so the next browser to ask gets nothing until it
    /// reconnects explicitly. A pairing already in flight reports `browser_disconnected`.
    pub(crate) async fn disconnect(&self) -> Result<(), cos_secrets::Error> {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        let _turn = self.queue.lock().await;
        let written = self
            .with_store(|store| store.set(&SecretKey::BridgeToken, BROWSER_DISCONNECTED))
            .await;
        if written.is_ok() {
            self.note(&Stored::Disconnected);
        }
        written
    }

    fn note(&self, stored: &Stored) {
        self.paired
            .store(matches!(stored, Stored::Token(_)), Ordering::Relaxed);
    }

    /// Runs `operation` on the blocking pool: the first load and every write do DPAPI and
    /// file IO. The Core's other owners share this store, so it is never held across an await.
    async fn with_store<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut SecretStore) -> T + Send + 'static,
    ) -> T {
        let secrets = self.secrets.clone();
        let run = move || operation(&mut secrets.lock().unwrap_or_else(PoisonError::into_inner));
        match tokio::task::spawn_blocking(run).await {
            Ok(value) => value,
            Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
            // Only a runtime that is shutting down cancels a blocking task.
            Err(error) => panic!("the secret store task did not run: {error}"),
        }
    }
}

/// `safeEqual`: lengths may differ in the open, the bytes are compared in constant time.
fn same(presented: &str, stored: &str) -> bool {
    presented.as_bytes().ct_eq(stored.as_bytes()).into()
}

/// `randomBytes(32).toString('base64url')`.
fn new_token() -> String {
    let mut bytes = [0u8; 32];
    // The OS generator failing is not a state the bridge can recover from; a fixed token
    // would be far worse than a refused pairing.
    if getrandom::getrandom(&mut bytes).is_err() {
        panic!("the OS random number generator is unavailable");
    }
    URL_SAFE_NO_PAD.encode(bytes)
}
