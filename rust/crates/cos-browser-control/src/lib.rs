//! Direct browser control (unit E2.8). The Desktop surface's `browser_*` tools act on the
//! person's browser through the companion extension: each call is a short-lived RPC the
//! extension claims over the bridge's `/browser-control` route. It ports
//! `src/main/browser-control.ts`, `src/main/mcp/tools-browser.ts`,
//! `src/shared/browser-control.ts`, the `/browser-control` and `/cos-browser/sign-in` handlers
//! of `bridge.ts`, and `src/main/cos-browser/sign-in-transfer.ts`.
//!
//! `cos-core` builds one [`BrowserControl`]. It registers [`tools`] on the Desktop surface,
//! hands the same owner to the bridge family `cos_bridge::families::browser_control`, and runs
//! [`BrowserControl::follow_bridge`] so a stopped, moved or disconnected bridge ends every
//! waiting call.

mod broker;
mod sign_in;
mod tools;
mod wire;

use std::sync::Arc;

use cos_tools::{BoxFuture, Capability, GrantEnv, Grants};
use cos_types::app_state::BridgeStatus;
use cos_types::config::{ChatBrowser, Config};
use cos_types::ids::{ConversationId, SessionId};
use tokio::sync::watch;

pub use broker::{
    Broker, Browser, COMMAND_TIMEOUT, Check, MAX_BROWSERS, MAX_PENDING, OwnerProof, PRESENCE, Poll,
    RESULT_BYTES, TooManyBrowsers, Wake,
};
pub use sign_in::{
    CookieWriter, ExternalBrowser, SignInCookie, SignInError, SignInMethod, SignInOffer,
    SignInTransfer, sign_in_cookies,
};
pub use tools::{IMAGE_BYTES, tools};
pub use wire::Answer;

/// The chat a call is proven to come from: its conversation and the session that holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chat {
    pub conversation: ConversationId,
    pub session: SessionId,
}

/// What browser control needs to know about chats, from the recorder and the session store.
pub trait ChatProof: Send + Sync + 'static {
    /// `requestCorrelation`: the chat a page proved this exact request id belongs to.
    fn proven(&self, request_id: &str) -> Option<Chat>;

    /// Whether this chat may still drive the browser: its session holds it as the current
    /// conversation (`conversationAttachment(...) === 'current'`), and the chat is not
    /// blocked, compacting, or a retired, dormant or ended worker.
    fn live<'a>(&'a self, chat: &'a Chat) -> BoxFuture<'a, bool>;
}

/// No recorder: no request id is ever proven and no chat is live.
pub struct NoChatProof;

impl ChatProof for NoChatProof {
    fn proven(&self, _request_id: &str) -> Option<Chat> {
        None
    }

    fn live<'a>(&'a self, _chat: &'a Chat) -> BoxFuture<'a, bool> {
        Box::pin(async { false })
    }
}

pub struct BrowserControlDeps {
    pub config: watch::Receiver<Arc<Config>>,
    /// To derive the effective capabilities from a config, as the kernel does.
    pub env: GrantEnv,
    pub proof: Arc<dyn ChatProof>,
    /// `wakeBrowserWork('browser-control')`.
    pub wake: Wake,
}

/// The browser control owner: the RPC broker, the sign-in transfer and the live policy both
/// read. Cloned freely.
#[derive(Clone)]
pub struct BrowserControl {
    pub(crate) broker: Broker,
    pub(crate) transfer: SignInTransfer,
    pub(crate) config: watch::Receiver<Arc<Config>>,
    pub(crate) env: Arc<GrantEnv>,
    pub(crate) proof: Arc<dyn ChatProof>,
}

impl BrowserControl {
    pub fn new(deps: BrowserControlDeps) -> Self {
        Self {
            broker: Broker::new(deps.wake),
            transfer: SignInTransfer::new(),
            config: deps.config,
            env: Arc::new(deps.env),
            proof: deps.proof,
        }
    }

    pub fn broker(&self) -> &Broker {
        &self.broker
    }

    /// The transfer a CoS browser host offers (`cosSignInTransfer`).
    pub fn sign_in(&self) -> &SignInTransfer {
        &self.transfer
    }

    /// The effective capabilities of the current config (`effectiveCapabilities(getConfig())`).
    pub(crate) fn grants(&self) -> Grants {
        Grants::derive(&self.config.borrow(), &self.env)
    }

    pub(crate) fn allows(&self, capability: Capability) -> bool {
        self.grants().capabilities.contains(capability)
    }

    pub(crate) fn cos_browser(&self) -> bool {
        self.config.borrow().ui.chat_browser == Some(ChatBrowser::Cos)
    }

    /// Ends every waiting call when the bridge stops, moves to another port or is
    /// disconnected, as `bridge.ts` does on each (`browserControl.reset()`), and revokes the
    /// sign-in offer on Disconnect (`cosSignInTransfer.cancel()`). Runs until the status
    /// sender is gone.
    pub async fn follow_bridge(self, mut status: watch::Receiver<Arc<BridgeStatus>>) {
        let mut last = {
            let status = status.borrow_and_update();
            (status.port, status.paired)
        };
        while status.changed().await.is_ok() {
            let now = {
                let status = status.borrow_and_update();
                (status.port, status.paired)
            };
            let (port, paired) = now;
            if port != last.0 {
                self.broker.reset();
            }
            if last.1 && !paired {
                self.broker.reset();
                self.transfer.cancel(None);
            }
            last = now;
        }
    }
}
