//! One explicit, process-local ChatGPT login handoff into the CoS browser
//! (`sign-in-transfer.ts`). The CoS browser host offers a transfer; the person, signed in to
//! ChatGPT in their own browser, presses the extension's transfer button; the extension posts
//! that browser's session cookies to `/cos-browser/sign-in`; the host writes them into the CoS
//! browser's own profile. Cookie values never enter durable state, logs or error text.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use cos_tools::{BoxFuture, EpochMs};
use serde::Serialize;
use serde_json::Value;

use crate::broker::random_uuid;

/// How long an offer stays open.
const OFFER_MS: u64 = 15 * 60_000;

/// The request method, as the route tells them apart.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignInMethod {
    Get,
    Post,
    Other,
}

/// The person's own browser the session comes from (`ExternalChatBrowser`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExternalBrowser {
    Chrome,
    Edge,
    Brave,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInOffer {
    pub id: String,
    pub browser: ExternalBrowser,
    pub expires_at: u64,
}

/// Why a transfer did not happen. Only these fixed words cross HTTP.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignInError {
    InvalidSession,
    TransferExpired,
    TransferBusy,
    TransferFailed,
    BadRequest,
}

impl SignInError {
    pub fn reason(self) -> &'static str {
        match self {
            Self::InvalidSession => "invalid_session",
            Self::TransferExpired => "transfer_expired",
            Self::TransferBusy => "transfer_busy",
            Self::TransferFailed => "transfer_failed",
            Self::BadRequest => "bad_request",
        }
    }
}

/// One ChatGPT session cookie, as `chrome.cookies` described it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub host_only: bool,
    pub same_site: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expiration_date: Option<f64>,
}

/// Whether the offer a write belongs to is still the one in force.
pub type Current = Arc<dyn Fn() -> bool + Send + Sync>;

/// Writes cookies into the CoS browser's own profile. The CoS browser host implements it.
pub trait CookieWriter: Send + Sync + 'static {
    /// Must stop, without writing, once `current` answers `false`. Its error is never shown,
    /// because a cookie API's error can contain the cookie.
    fn write(
        &self,
        cookies: Vec<SignInCookie>,
        current: Current,
    ) -> BoxFuture<'static, Result<(), ()>>;
}

const SESSION_COOKIE: &str = "__Secure-next-auth.session-token";

/// `^__Secure-next-auth\.session-token(?:\.\d+)?$`; the chunk number, if any.
fn session_cookie(name: &str) -> Option<Option<&str>> {
    let rest = name.strip_prefix(SESSION_COOKIE)?;
    if rest.is_empty() {
        return Some(None);
    }
    let digits = rest.strip_prefix('.')?;
    (!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())).then_some(Some(digits))
}

/// One element of the strict cookie schema, or `None`.
fn cookie(raw: &Value) -> Option<SignInCookie> {
    const KEYS: [&str; 9] = [
        "name",
        "value",
        "domain",
        "path",
        "secure",
        "httpOnly",
        "hostOnly",
        "sameSite",
        "expirationDate",
    ];
    let fields = raw.as_object()?;
    if fields.keys().any(|key| !KEYS.contains(&key.as_str())) {
        return None;
    }
    let text = |key: &str| fields.get(key).and_then(Value::as_str);
    let name = text("name").filter(|name| session_cookie(name).is_some())?;
    let value = text("value").filter(|value| (1..=4096).contains(&value.encode_utf16().count()))?;
    let domain =
        text("domain").filter(|domain| matches!(*domain, "chatgpt.com" | ".chatgpt.com"))?;
    let path = text("path").filter(|path| *path == "/")?;
    let flag = |key: &str| fields.get(key).and_then(Value::as_bool);
    let (Some(true), Some(true), Some(host_only)) =
        (flag("secure"), flag("httpOnly"), flag("hostOnly"))
    else {
        return None;
    };
    let same_site = text("sameSite").filter(|same_site| {
        matches!(
            *same_site,
            "no_restriction" | "lax" | "strict" | "unspecified"
        )
    })?;
    let expiration_date = match fields.get("expirationDate") {
        None => None,
        Some(value) => Some(
            value
                .as_f64()
                .filter(|date| date.is_finite() && *date > 0.0)?,
        ),
    };
    Some(SignInCookie {
        name: name.to_owned(),
        value: value.to_owned(),
        domain: domain.to_owned(),
        path: path.to_owned(),
        secure: true,
        http_only: true,
        host_only,
        same_site: same_site.to_owned(),
        expiration_date,
    })
}

/// `signInCookies`: one complete ChatGPT session, its chunks in order, or `InvalidSession`.
/// Mixed, truncated or ambiguous chunks are refused before either cookie jar is touched.
pub fn sign_in_cookies(raw: &Value, now_ms: u64) -> Result<Vec<SignInCookie>, SignInError> {
    let invalid = SignInError::InvalidSession;
    let items = raw
        .as_array()
        .filter(|items| (1..=16).contains(&items.len()))
        .ok_or(invalid)?;
    let cookies: Vec<SignInCookie> = items
        .iter()
        .map(cookie)
        .collect::<Option<_>>()
        .ok_or(invalid)?;
    let first = &cookies[0];
    let mismatched = cookies.iter().any(|cookie| {
        cookie.host_only != (cookie.domain == "chatgpt.com")
            || cookie.domain != first.domain
            || cookie.host_only != first.host_only
            || cookie
                .expiration_date
                .is_some_and(|date| date * 1000.0 <= now_ms as f64)
    });
    if mismatched {
        return Err(invalid);
    }
    if cookies.len() == 1 && cookies[0].name == SESSION_COOKIE {
        return Ok(cookies);
    }
    // `Number(name.split('.').at(-1))`: the whole name for an unchunked cookie is NaN.
    let chunk = |cookie: &SignInCookie| {
        session_cookie(&cookie.name)
            .flatten()
            .and_then(|digits| digits.parse::<f64>().ok())
            .unwrap_or(f64::NAN)
    };
    let mut sorted = cookies;
    sorted.sort_by(|a, b| {
        chunk(a)
            .partial_cmp(&chunk(b))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let in_order = sorted
        .iter()
        .enumerate()
        .all(|(index, cookie)| cookie.name == format!("{SESSION_COOKIE}.{index}"));
    if in_order { Ok(sorted) } else { Err(invalid) }
}

/// The offer in force.
struct Active {
    /// Which `begin` made it, so a write can tell its own offer from a later one.
    serial: u64,
    id: String,
    browser: ExternalBrowser,
    expires_at: u64,
    current: Current,
    writer: Arc<dyn CookieWriter>,
}

#[derive(Default)]
struct TransferState {
    serial: u64,
    active: Option<Active>,
    /// An accepted cookie write still holds this, even after its offer was revoked.
    writing: bool,
    /// The browser whose transfer was imported, so its retry is answered as done.
    receipt: Option<(String, String)>,
}

type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// The transfer owner. Cloned freely.
#[derive(Clone)]
pub struct SignInTransfer {
    state: Arc<Mutex<TransferState>>,
    clock: Clock,
}

impl Default for SignInTransfer {
    fn default() -> Self {
        Self::new()
    }
}

impl SignInTransfer {
    pub fn new() -> Self {
        Self::with_clock(Arc::new(|| EpochMs::now().0))
    }

    /// A transfer on a clock the caller drives, in milliseconds since the epoch.
    pub fn with_clock(clock: Clock) -> Self {
        Self {
            state: Arc::default(),
            clock,
        }
    }

    fn lock(&self) -> MutexGuard<'_, TransferState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Opens a transfer into the CoS browser. `current` says whether the host still wants it.
    pub fn begin(
        &self,
        browser: ExternalBrowser,
        current: Current,
        writer: Arc<dyn CookieWriter>,
    ) -> Result<SignInOffer, SignInError> {
        let mut state = self.lock();
        if state.writing {
            return Err(SignInError::TransferBusy);
        }
        if !current() {
            return Err(SignInError::TransferExpired);
        }
        state.serial += 1;
        let active = Active {
            serial: state.serial,
            id: random_uuid(),
            browser,
            expires_at: (self.clock)() + OFFER_MS,
            current,
            writer,
        };
        let offer = SignInOffer {
            id: active.id.clone(),
            browser,
            expires_at: active.expires_at,
        };
        state.active = Some(active);
        state.receipt = None;
        Ok(offer)
    }

    /// The open offer. It expires by the clock, without a timer.
    pub fn pending(&self) -> Option<SignInOffer> {
        Self::open(&self.lock(), (self.clock)())
    }

    fn open(state: &TransferState, now: u64) -> Option<SignInOffer> {
        let active = state.active.as_ref()?;
        ((active.current)() && now < active.expires_at).then(|| SignInOffer {
            id: active.id.clone(),
            browser: active.browser,
            expires_at: active.expires_at,
        })
    }

    /// Revokes the offer `id`, or any offer. A write already accepted cannot publish after this.
    pub fn cancel(&self, id: Option<&str>) {
        let mut state = self.lock();
        if state
            .active
            .as_ref()
            .is_some_and(|active| id.is_none_or(|id| active.id == id))
        {
            state.active = None;
        }
        if id.is_none()
            || state
                .receipt
                .as_ref()
                .is_some_and(|(receipt, _)| Some(receipt.as_str()) == id)
        {
            state.receipt = None;
        }
    }

    /// Imports `raw` cookies for offer `id` from browser `browser`. A repeat from the browser
    /// that already imported it succeeds without writing again.
    pub async fn accept(
        &self,
        id: &str,
        browser: &str,
        raw: &Value,
        ingress: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Result<(), SignInError> {
        if !ingress() {
            return Err(SignInError::TransferExpired);
        }
        let (serial, writer, offer_current, expires_at, cookies) = {
            let mut state = self.lock();
            if state
                .receipt
                .as_ref()
                .is_some_and(|(receipt, from)| receipt == id && from == browser)
            {
                return Ok(());
            }
            let now = (self.clock)();
            let open = Self::open(&state, now).is_some_and(|offer| offer.id == id);
            let Some(active) = state.active.as_ref().filter(|_| open) else {
                return Err(SignInError::TransferExpired);
            };
            if state.writing {
                return Err(SignInError::TransferBusy);
            }
            let cookies = sign_in_cookies(raw, now)?;
            let taken = (
                active.serial,
                active.writer.clone(),
                active.current.clone(),
                active.expires_at,
            );
            state.writing = true;
            (taken.0, taken.1, taken.2, taken.3, cookies)
        };
        let clock = self.clock.clone();
        let holds = Arc::new(move |state: &TransferState| {
            state
                .active
                .as_ref()
                .is_some_and(|active| active.serial == serial)
                && offer_current()
                && ingress()
                && clock() < expires_at
        });
        let current: Current = {
            let transfer = self.clone();
            let holds = holds.clone();
            Arc::new(move || holds(&transfer.lock()))
        };
        let written = writer.write(cookies, current).await;
        let mut state = self.lock();
        state.writing = false;
        if written.is_err() {
            return Err(SignInError::TransferFailed);
        }
        if !holds(&state) {
            return Err(SignInError::TransferExpired);
        }
        state.receipt = Some((id.to_owned(), browser.to_owned()));
        state.active = None;
        Ok(())
    }
}
