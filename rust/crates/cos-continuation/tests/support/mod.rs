#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use cos_continuation::{Clock, Continuations, ContinuationsDeps, NoPrime, NoProjections};
use cos_sessions::SessionStore;
use cos_store::config::first_launch_config;
use cos_store::{AppPaths, DurableStore, Logger, Platform};
use cos_tools::EpochMs;
use cos_types::ids::SessionId;
use tokio::sync::watch;

pub const CHAT_A: &str = "chat-a";
pub const CHAT_B: &str = "chat-b";
pub const CHAT_C: &str = "chat-c";

/// `SAMPLE_BRIEF` in `test/helpers.ts`.
pub const SAMPLE_BRIEF: &str =
    "TASK — finish the bridge rewrite the user asked for and leave the tests green.

USER SPECIFICATION — the rewrite must keep the existing wire contract, must not change
the extension protocol version, and must land before the release is cut. The user asked
twice for the tests to be run before anything is reported as done.

CURRENT STATE — src/main/bridge.ts compiles; the routes are ported; two suites are red.
The pairing handshake is unchanged and the bearer token still comes from /pair, so nothing
an already-paired extension holds has to be reissued.

DONE — /commands and /commands/ack are ported and covered by test/bridge.test.ts. The rate
limiter and the body cap moved with them unchanged, and the Origin check still refuses any
origin that is not a chrome-extension:// one.

IN PROGRESS — /activity, stopped while re-deriving the cursor semantics. The old route
advanced its cursor on read, which the page relies on not happening for a peek.

FAILED / UNRESOLVED — none outstanding beyond the two red suites named above. The earlier
attempt to share one cursor between /activity and /events was abandoned: they are read by
different callers at different rates and one cursor made both of them wrong.

FILES — src/main/bridge.ts (routes), test/bridge.test.ts (coverage for them),
src/main/session/recorder.ts (only where the activity cursor is read).

VERIFICATION — `npm run typecheck` is clean; `npx vitest run test/bridge.test.ts` is red.

NEXT — finish the cursor rework, then run the full suite.

DO NOT — do not touch the extension protocol version; the user ruled that out.";

/// A profile folder that is removed when the test ends.
pub struct Profile(pub PathBuf);

impl Profile {
    pub fn new(name: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "cos-continuation-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap_or_else(|error| panic!("profile: {error}"));
        Self(dir)
    }

    pub fn wal(&self) -> PathBuf {
        self.0.join("state").join("continuations.json")
    }
}

impl Drop for Profile {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The wall clock plus a hand-driven offset.
#[derive(Clone, Default)]
pub struct Offset(pub Arc<AtomicU64>);

impl Offset {
    pub fn advance(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }

    pub fn clock(&self) -> Clock {
        let offset = self.0.clone();
        Arc::new(move || EpochMs::now().0 + offset.load(Ordering::SeqCst))
    }
}

/// One process on a profile: its session store and its transactions.
pub struct Process {
    pub sessions: SessionStore,
    pub continuations: Continuations,
}

pub async fn start(profile: &Path, offset: &Offset) -> Process {
    let paths = AppPaths::at(profile);
    let logger = Logger::with_clock(|| 0, false);
    let sessions = SessionStore::open(&paths, logger.clone());
    sessions.restore().await;
    let state = DurableStore::new(paths.state(), logger.clone());
    let config = watch::channel(Arc::new(first_launch_config(Platform::current()))).1;
    let continuations = Continuations::new(ContinuationsDeps {
        sessions: sessions.clone(),
        state: &state,
        config,
        logger,
        clock: offset.clock(),
        prime: Arc::new(NoPrime),
        projections: Arc::new(NoProjections),
    });
    continuations.restore().await;
    Process {
        sessions,
        continuations,
    }
}

impl Process {
    /// What a quit leaves on disk.
    pub async fn stop(&self) {
        self.sessions.flush().await;
        self.continuations.flush();
    }

    pub async fn chat_session(&self, conversation: &str) -> SessionId {
        self.sessions
            .create_for_conversation(conversation, Some("work"))
            .await
            .unwrap_or_else(|error| panic!("session: {error}"))
            .id
    }

    pub async fn attached(&self, session: &SessionId) -> Option<String> {
        self.sessions
            .summary(session)
            .await
            .and_then(|summary| summary.conversation_id)
    }

    /// A session in chat A with its brief captured, ready to be claimed.
    pub async fn ready(&self) -> (SessionId, String) {
        let session = self.chat_session(CHAT_A).await;
        let opened = self
            .continuations
            .open(&session, CHAT_A, false, None)
            .await
            .unwrap_or_else(|error| panic!("open: {error}"));
        assert!(
            self.continuations
                .attach_summary(&opened.token, SAMPLE_BRIEF)
                .await
                .is_some(),
            "brief stored"
        );
        (session, opened.token)
    }

    pub fn handoffs(&self, profile: &Profile, session: &SessionId) -> usize {
        std::fs::read_dir(
            profile
                .0
                .join("sessions")
                .join(session.as_str())
                .join("handoffs"),
        )
        .map_or(0, |entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".json"))
                .count()
        })
    }
}

/// Makes `path` unwritable as a file by putting a folder there, so the next atomic rename fails.
pub fn block(path: &Path) {
    let _ = std::fs::remove_file(path);
    std::fs::create_dir_all(path.join("blocked")).unwrap_or_else(|error| panic!("block: {error}"));
}

pub fn unblock(path: &Path) {
    let _ = std::fs::remove_dir_all(path);
}
