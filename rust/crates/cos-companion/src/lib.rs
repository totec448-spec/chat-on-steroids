//! What the app and the browser extension exchange outside of chats (unit E2.4). Each module is
//! one owner, testable without HTTP; the `cos-bridge` family `families::models` is the wire
//! layer over them.
//!
//! - [`ChatModels`]: the account's model catalog, the discovery request handed to the page and
//!   the page's answer on `/models` (`chat-models.ts`).
//! - [`UsageLimits`]: the account limits a page reads on `/usage` (`observeUsage`).
//! - [`PreferenceRequests`]: an app request for the extension's own preferences, answered on
//!   `/browser/preferences` (`browser-preferences.ts`).
//! - [`Diagnostics`]: the extension's popup-equivalent snapshot from `/diagnostics`.
//! - [`ProjectCreates`]: the native ChatGPT Project creation handshake over the projects
//!   owner's [`ProjectLinks`] (`projects.ts`).
//! - [`plugin_refresh`]: the `/plugin-refresh` handshake over the plugin owner's
//!   [`PluginRefreshes`].
//! - [`settings`]: the composer's `/settings` view and switches.
//! - [`custody`]: which browser a waiting message belongs to when several poll.
//! - [`status`]: the `/status` maintenance pass, composed from these owners and the
//!   [`BrowserWork`] that later units fill.
//!
//! Owners that are not ported yet sit behind a port with a `No…` implementation that answers
//! as the TypeScript app does when that owner holds nothing.

pub mod custody;
mod diagnostics;
mod models;
pub mod plugin_refresh;
mod ports;
mod preferences;
mod projects;
pub mod settings;
pub mod status;
mod text;
mod usage;

use std::sync::Arc;

use cos_tools::EpochMs;

pub use diagnostics::Diagnostics;
pub use models::{
    CatalogState, ChatModelCatalog, ChatModels, HelperSelection, chat_models_ledger,
    helper_selection, resolve_chat_model,
};
pub use plugin_refresh::{NoPluginRefreshes, PluginRefreshes};
pub use ports::{
    BrowserWork, ChatPolicy, ChatSwitches, ConfigWriter, NoBrowserWork, NoChatPolicy,
    NoChatSwitches, StatusCall, SwitchAnswer, WorkParts,
};
pub use preferences::{PreferenceError, PreferenceRequests};
pub use projects::{LinkChange, LinkSelect, NoProjects, ProjectCreates, ProjectLinks};
pub use usage::{ModelUsage, UsageLimits, UsageSnapshot};

pub use cos_tools::BoxFuture;

/// Reads the wall clock. Owners take one so tests can move time.
pub type Clock = Arc<dyn Fn() -> EpochMs + Send + Sync>;

/// `wakeBrowserWork()`: tells the extension over the wake socket that there is work to read.
pub type WakeBrowser = Arc<dyn Fn() + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(EpochMs::now)
}

/// `randomUUID()`: a version 4 UUID.
pub(crate) fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    // The OS generator failing leaves zeros; the id is still unique enough for one nonce in
    // flight, and a nonce is never a secret.
    let _ = getrandom::getrandom(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}
