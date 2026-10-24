//! The short-lived browser RPCs (`BrowserControlBroker` in `browser-control.ts`). A tool call
//! queues one command for one browser and waits. The extension polls, claims it once, runs it
//! and reports the result. A claim is never handed out twice, including after the result was
//! lost, so an input action can never be replayed.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use cos_tools::{BoxFuture, EpochMs};
use cos_types::mcp::{BrowserCommand, BrowserResult, BrowserTool};
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use tokio::time::Instant;

/// `BROWSER_LIMITS.clients`: browser incarnations polling at once.
pub const MAX_BROWSERS: usize = 8;
/// `BROWSER_LIMITS.pending`: commands waiting for a browser.
pub const MAX_PENDING: usize = 32;
/// `BROWSER_LIMITS.timeoutMs`: how long a call waits for its browser.
pub const COMMAND_TIMEOUT: Duration = Duration::from_millis(25_000);
/// `BROWSER_LIMITS.presenceMs`: a browser that has not polled for this long is gone.
pub const PRESENCE: Duration = Duration::from_millis(75_000);
/// `BROWSER_LIMITS.resultBytes`: the largest result a browser may report.
pub const RESULT_BYTES: usize = 1_800_000;

/// The live permission check a command carries. It runs when the browser claims the command
/// and again before page input (`check`), so a permission revoked while the command waited
/// stops it.
pub type Check = Arc<dyn Fn() -> BoxFuture<'static, bool> + Send + Sync>;

/// Tells the extension to read its browser work now (`wakeBrowserWork('browser-control')`).
pub type Wake = Arc<dyn Fn() + Send + Sync>;

/// One connected browser incarnation, as `browser_tabs` lists it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Browser {
    pub id: String,
    pub name: String,
    pub enabled: bool,
}

/// What a poll hands the browser: the broker's epoch and the commands waiting for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Poll {
    pub epoch: String,
    pub requests: Vec<String>,
}

/// `poll` refused a new browser because [`MAX_BROWSERS`] are already polling.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TooManyBrowsers;

/// A request id a page proved, and the session that page belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnerProof {
    /// `request:<id>`, as the browser holds it.
    pub owner: String,
    pub session: String,
}

/// Where a queued command is. A command moves forward only, and the broker hands it to a
/// browser at most once.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Custody {
    Queued,
    /// The browser asked for it and its permission is being checked.
    Claiming,
    /// Handed to the browser. A lost result is reported as unconfirmed, never retried.
    Claimed,
}

struct Pending {
    browser: String,
    command: BrowserCommand,
    custody: Custody,
    check: Check,
    deadline: Instant,
    reply: oneshot::Sender<BrowserResult>,
}

struct Client {
    id: String,
    name: String,
    seen: Instant,
    enabled: bool,
}

struct State {
    epoch: String,
    /// In first-poll order, as the TypeScript `Map` keeps them.
    clients: Vec<Client>,
    /// In queue order, which is the order a poll lists them.
    pending: Vec<Pending>,
}

impl State {
    fn position(&self, id: &str) -> Option<usize> {
        self.pending.iter().position(|p| p.command.id == id)
    }

    /// The command `id` when `browser` holds `epoch` and the command is in `custody`.
    fn held(
        &mut self,
        browser: &str,
        id: &str,
        epoch: &str,
        custody: Custody,
    ) -> Option<&mut Pending> {
        if epoch != self.epoch {
            return None;
        }
        self.pending
            .iter_mut()
            .find(|p| p.command.id == id && p.browser == browser && p.custody == custody)
    }

    /// Ends a command with `result`. A command already ended is left alone.
    fn finish(&mut self, id: &str, result: BrowserResult) {
        if let Some(at) = self.position(id) {
            let pending = self.pending.remove(at);
            let _ = pending.reply.send(result);
        }
    }

    fn present(&self, now: Instant) -> Vec<Browser> {
        self.clients
            .iter()
            .filter(|client| now.duration_since(client.seen) < PRESENCE)
            .map(|client| Browser {
                id: client.id.clone(),
                name: client.name.clone(),
                enabled: client.enabled,
            })
            .collect()
    }
}

fn error(text: &str) -> BrowserResult {
    BrowserResult {
        value: None,
        image: None,
        error: Some(text.to_owned()),
    }
}

const NOT_CLAIMED_IN_TIME: &str =
    "BROWSER_NOT_DISPATCHED: the extension did not claim this request before its deadline.";
const RESULT_LOST: &str = "BROWSER_RESULT_UNCONFIRMED: the operation was dispatched but its result was not received. Inspect the tab before repeating any action.";

/// The broker. Cloned freely; every clone is the same broker.
#[derive(Clone)]
pub struct Broker {
    state: Arc<Mutex<State>>,
    wake: Wake,
}

impl Broker {
    pub fn new(wake: Wake) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                epoch: random_uuid(),
                clients: Vec::new(),
                pending: Vec::new(),
            })),
            wake,
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The browsers that polled within [`PRESENCE`], in first-poll order.
    pub fn browsers(&self) -> Vec<Browser> {
        self.lock().present(Instant::now())
    }

    /// A browser says it is here and asks for its work. `browser` is already a well-formed id.
    pub fn poll(&self, browser: &str, name: &str, enabled: bool) -> Result<Poll, TooManyBrowsers> {
        let now = Instant::now();
        let mut state = self.lock();
        state
            .clients
            .retain(|client| now.duration_since(client.seen) < PRESENCE);
        let name = utf16_prefix(name, 80);
        let known = state.clients.iter().position(|client| client.id == browser);
        match known {
            Some(at) => {
                let client = &mut state.clients[at];
                client.name = name;
                client.seen = now;
                client.enabled = enabled;
            }
            None if state.clients.len() >= MAX_BROWSERS => return Err(TooManyBrowsers),
            None => state.clients.push(Client {
                id: browser.to_owned(),
                name,
                seen: now,
                enabled,
            }),
        }
        let requests = if enabled {
            state
                .pending
                .iter()
                .filter(|p| p.browser == browser && p.custody == Custody::Queued)
                .map(|p| p.command.id.clone())
                .collect()
        } else {
            Vec::new()
        };
        Ok(Poll {
            epoch: state.epoch.clone(),
            requests,
        })
    }

    /// Hands command `id` to `browser`, once. `proofs` are the request owners the bridge proved
    /// from its own correlation index; the ones that belong to the command's session become its
    /// `ownerAliases`, so the browser may reuse a tab that request attached.
    pub async fn claim(
        &self,
        browser: &str,
        id: &str,
        epoch: &str,
        proofs: &[OwnerProof],
    ) -> Option<BrowserCommand> {
        let check = {
            let mut state = self.lock();
            let pending = state.held(browser, id, epoch, Custody::Queued)?;
            pending.custody = Custody::Claiming;
            pending.check.clone()
        };
        let allowed = check().await;
        let mut state = self.lock();
        let at = state.position(id)?;
        // A permission read cannot revive a command that expired or was reset meanwhile.
        if state.pending[at].deadline <= Instant::now() {
            return None;
        }
        if !allowed {
            state.finish(
                id,
                error("BROWSER_PERMISSION_REVOKED: request was not dispatched."),
            );
            return None;
        }
        let pending = &mut state.pending[at];
        let mut aliases: Vec<String> = Vec::new();
        for proof in proofs.iter().take(32) {
            let belongs = proof.owner.starts_with("request:")
                && pending.command.owner == format!("session:{}", proof.session);
            if belongs && !aliases.contains(&proof.owner) {
                aliases.push(proof.owner.clone());
            }
        }
        if !aliases.is_empty() {
            pending.command.owner_aliases = Some(aliases);
        }
        pending.custody = Custody::Claimed;
        Some(pending.command.clone())
    }

    /// Whether a claimed command may still act on the page: its permission is live and it has
    /// not expired.
    pub async fn check(&self, browser: &str, id: &str, epoch: &str) -> bool {
        let check = {
            let mut state = self.lock();
            match state.held(browser, id, epoch, Custody::Claimed) {
                Some(pending) => pending.check.clone(),
                None => return false,
            }
        };
        let allowed = check().await;
        let state = self.lock();
        allowed
            && state
                .position(id)
                .is_some_and(|at| state.pending[at].deadline > Instant::now())
    }

    /// The browser's result for a claimed command. `false` when the command is not this
    /// browser's to answer, or was already answered.
    pub fn result(&self, browser: &str, id: &str, epoch: &str, result: BrowserResult) -> bool {
        let mut state = self.lock();
        if state.held(browser, id, epoch, Custody::Claimed).is_none() {
            return false;
        }
        let bytes = serde_json::to_vec(&result).map_or(usize::MAX, |json| json.len());
        let result = if bytes > RESULT_BYTES {
            error(
                "BROWSER_RESULT_TOO_LARGE: operation may have completed; inspect before repeating it.",
            )
        } else {
            result
        };
        state.finish(id, result);
        true
    }

    /// Runs one browser tool: picks the browser, queues the command, wakes the extension and
    /// waits at most [`COMMAND_TIMEOUT`] for the result. `args` are the tool's parsed arguments.
    pub async fn execute(
        &self,
        tool: BrowserTool,
        mut args: Map<String, Value>,
        owner: String,
        conversation: Option<String>,
        check: Check,
    ) -> BrowserResult {
        let mut browser = match args.get("browserId") {
            Some(Value::String(id)) => Some(id.clone()),
            _ => None,
        };
        if let Some(Value::String(handle)) = args.get("tabId") {
            let Some((id, tab)) = tab_handle(handle) else {
                return error("BROWSER_TAB_INVALID: use a tabId returned by browser_tabs.");
            };
            browser = Some(id);
            args.insert("tabId".to_owned(), json!(tab));
        }
        let (id, reply, deadline) = {
            let now = Instant::now();
            let mut state = self.lock();
            let browsers = state.present(now);
            let browser = match browser {
                Some(browser) => browser,
                None if browsers.len() == 1 => browsers[0].id.clone(),
                None if tool == BrowserTool::Tabs && args.get("action") == Some(&json!("list")) => {
                    let message = if browsers.is_empty() {
                        "Open Chrome with the companion extension connected."
                    } else {
                        "Choose browserId to list its tabs."
                    };
                    return BrowserResult {
                        value: Some(
                            json!({ "browsers": browsers, "tabs": [], "message": message }),
                        ),
                        image: None,
                        error: None,
                    };
                }
                None => {
                    return error(
                        "BROWSER_REQUIRED: list browsers, then specify the returned browserId.",
                    );
                }
            };
            let Some(client) = browsers.iter().find(|b| b.id == browser) else {
                return error(
                    "BROWSER_OFFLINE: this browser incarnation is no longer connected. List browsers again.",
                );
            };
            if !client.enabled {
                return error(
                    "BROWSER_EXTENSION_PERMISSION: Chrome must grant the companion its debugger and tabs permissions. Reload/update the extension.",
                );
            }
            if state.pending.len() >= MAX_PENDING {
                return error(
                    "BROWSER_BUSY: too many pending requests; no operation was dispatched.",
                );
            }
            args.shift_remove("browserId");
            let id = random_uuid();
            let deadline = now + COMMAND_TIMEOUT;
            let expires_at =
                EpochMs::now().0 + u64::try_from(COMMAND_TIMEOUT.as_millis()).unwrap_or(0);
            let (reply, waiting) = oneshot::channel();
            let epoch = state.epoch.clone();
            state.pending.push(Pending {
                browser,
                command: BrowserCommand {
                    id: id.clone(),
                    epoch,
                    owner,
                    owner_aliases: None,
                    conversation_id: conversation,
                    tool,
                    args,
                    expires_at,
                },
                custody: Custody::Queued,
                check,
                deadline,
                reply,
            });
            (id, waiting, deadline)
        };
        (self.wake)();
        let mut waiting = Waiting {
            broker: self,
            id,
            reply,
        };
        match tokio::time::timeout_at(deadline, &mut waiting.reply).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => error(NOT_CLAIMED_IN_TIME),
            Err(_) => waiting.expire(),
        }
    }

    /// The bridge stopped, moved or was disconnected: every waiting call ends, no browser is
    /// known, and a new epoch makes every old claim and receipt stale.
    pub fn reset(&self) {
        let mut state = self.lock();
        for pending in state.pending.drain(..) {
            let text = if pending.custody == Custody::Claimed {
                "BROWSER_RESULT_UNCONFIRMED: bridge stopped after dispatch. Inspect before repeating the operation."
            } else {
                "BROWSER_NOT_DISPATCHED: bridge stopped."
            };
            let _ = pending.reply.send(error(text));
        }
        state.clients.clear();
        state.epoch = random_uuid();
    }
}

/// One call waiting for its result. Dropping it (the call was cancelled) withdraws the
/// command, so no browser runs work nobody is waiting for and it stops counting against
/// [`MAX_PENDING`].
struct Waiting<'a> {
    broker: &'a Broker,
    id: String,
    reply: oneshot::Receiver<BrowserResult>,
}

impl Waiting<'_> {
    /// The deadline passed: the answer says whether the browser ever got the command.
    fn expire(&mut self) -> BrowserResult {
        let mut state = self.broker.lock();
        match state.position(&self.id) {
            Some(at) => {
                let pending = state.pending.remove(at);
                error(if pending.custody == Custody::Claimed {
                    RESULT_LOST
                } else {
                    NOT_CLAIMED_IN_TIME
                })
            }
            // The result arrived in the same instant.
            None => self
                .reply
                .try_recv()
                .unwrap_or_else(|_| error(NOT_CLAIMED_IN_TIME)),
        }
    }
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        let mut state = self.broker.lock();
        if let Some(at) = state.position(&self.id) {
            state.pending.remove(at);
        }
    }
}

/// `^([a-f\d-]{36}):(\d+)$` (case-insensitive) with a tab number that is a safe integer.
fn tab_handle(handle: &str) -> Option<(String, u64)> {
    let (browser, tab) = handle.split_once(':')?;
    let browser_ok = browser.len() == 36
        && browser
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-');
    let digits_ok = !tab.is_empty() && tab.bytes().all(|byte| byte.is_ascii_digit());
    if !browser_ok || !digits_ok {
        return None;
    }
    const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
    let tab = tab
        .parse::<u64>()
        .ok()
        .filter(|tab| *tab <= MAX_SAFE_INTEGER)?;
    Some((browser.to_owned(), tab))
}

/// `text.slice(0, units)`, without splitting a character.
fn utf16_prefix(text: &str, units: usize) -> String {
    let mut used = 0;
    text.chars()
        .take_while(|c| {
            used += c.len_utf16();
            used <= units
        })
        .collect()
}

/// A random version 4 UUID (`randomUUID`).
pub(crate) fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        use std::hash::{BuildHasher, RandomState};
        let high = RandomState::new().hash_one(std::time::Instant::now());
        let low = RandomState::new().hash_one(std::process::id());
        bytes[..8].copy_from_slice(&high.to_le_bytes());
        bytes[8..].copy_from_slice(&low.to_le_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

#[cfg(test)]
mod tests {
    use super::{tab_handle, utf16_prefix};

    #[test]
    fn tab_handles_name_one_browser_and_a_safe_tab_number() {
        let browser = "11111111-1111-4111-8111-111111111111";
        assert_eq!(
            tab_handle(&format!("{browser}:12")),
            Some((browser.to_owned(), 12))
        );
        assert_eq!(
            tab_handle(&format!("{}:7", browser.to_uppercase())),
            Some((browser.to_uppercase(), 7))
        );
        assert_eq!(tab_handle(&format!("{browser}:9007199254740992")), None);
        assert_eq!(tab_handle(&format!("{browser}:")), None);
        assert_eq!(tab_handle("123"), None);
        assert_eq!(tab_handle(&format!("{browser}:1:2")), None);
    }

    #[test]
    fn names_are_cut_at_eighty_utf16_units() {
        assert_eq!(utf16_prefix(&"a".repeat(90), 80).len(), 80);
        let emoji = "\u{1F600}".repeat(41);
        assert_eq!(utf16_prefix(&emoji, 80).chars().count(), 40);
    }
}
