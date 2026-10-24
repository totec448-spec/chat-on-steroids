//! The account's usage limits as a ChatGPT page last read them (`observeUsage` in
//! `session/usage.ts`). One snapshot is one account observation: a newer one replaces it whole,
//! and an explicit empty one clears it.

use std::sync::{Arc, Mutex};

use cos_types::bridge::UsageScope;
use cos_types::json::JsNumber;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::watch;

use crate::text::js_len;

/// A snapshot is shown for ten minutes.
const FRESH_MS: f64 = 10.0 * 60_000.0;
const MAX_ROWS: usize = 80;
/// How far ahead of this clock a page's clock may be.
const FUTURE_SLACK_MS: f64 = 5_000.0;

/// `ModelUsage`: one limit and when it was read.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub scope: UsageScope,
    pub remaining: Option<JsNumber>,
    pub remaining_percent: Option<JsNumber>,
    pub reset_at: Option<JsNumber>,
    pub window_seconds: Option<JsNumber>,
    pub observed_at: JsNumber,
}

/// The latest accepted snapshot.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct UsageSnapshot {
    pub rows: Vec<ModelUsage>,
}

impl UsageSnapshot {
    /// The limits still worth showing at `now`: read in the last ten minutes, and not yet reset.
    pub fn fresh(&self, now: f64) -> Vec<ModelUsage> {
        self.rows
            .iter()
            .filter(|row| {
                now - row.observed_at.0 <= FRESH_MS
                    && row.reset_at.is_none_or(|reset| reset.0 > now)
            })
            .cloned()
            .collect()
    }
}

/// The body did not hold a valid batch of limits (`400 invalid_usage`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidUsage;

/// `null` or a finite number that passes `valid`. The key must be present (zod `.nullable()`).
fn nullable(
    value: Option<&Value>,
    valid: impl Fn(f64) -> bool,
) -> Result<Option<JsNumber>, InvalidUsage> {
    match value.ok_or(InvalidUsage)? {
        Value::Null => Ok(None),
        number => number
            .as_f64()
            .filter(|n| valid(*n))
            .map(|n| Some(JsNumber(n)))
            .ok_or(InvalidUsage),
    }
}

fn row(value: &Value, observed_at: f64) -> Result<ModelUsage, InvalidUsage> {
    let object = value.as_object().ok_or(InvalidUsage)?;
    let model = object
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| (1..=100).contains(&js_len(model)))
        .ok_or(InvalidUsage)?;
    let scope = object
        .get("scope")
        .and_then(|scope| serde_json::from_value(scope.clone()).ok())
        .ok_or(InvalidUsage)?;
    Ok(ModelUsage {
        model: model.to_owned(),
        scope,
        remaining: nullable(object.get("remaining"), |n| n >= 0.0)?,
        remaining_percent: nullable(object.get("remainingPercent"), |n| {
            (0.0..=100.0).contains(&n)
        })?,
        reset_at: nullable(object.get("resetAt"), |n| n > 0.0)?,
        window_seconds: nullable(object.get("windowSeconds"), |n| n > 0.0)?,
        observed_at: JsNumber(observed_at),
    })
}

/// The limits owner. Clones share one.
#[derive(Clone)]
pub struct UsageLimits {
    latest_observed_at: Arc<Mutex<f64>>,
    published: Arc<watch::Sender<Arc<UsageSnapshot>>>,
}

impl Default for UsageLimits {
    fn default() -> Self {
        Self::new()
    }
}

impl UsageLimits {
    pub fn new() -> Self {
        Self {
            latest_observed_at: Arc::new(Mutex::new(0.0)),
            published: Arc::new(watch::Sender::new(Arc::default())),
        }
    }

    /// The latest snapshot, for the Usage view. Read it through [`UsageSnapshot::fresh`].
    pub fn watch(&self) -> watch::Receiver<Arc<UsageSnapshot>> {
        self.published.subscribe()
    }

    /// `observeUsage(rows, observedAt)`. A batch that does not parse is refused whole and leaves
    /// the current snapshot alone. A stale, future or older-than-current snapshot is accepted
    /// and ignored. A missing `observedAt` means now.
    pub fn observe(
        &self,
        rows: Option<&Value>,
        observed_at: Option<&Value>,
        now: f64,
    ) -> Result<(), InvalidUsage> {
        let list = rows.and_then(Value::as_array).ok_or(InvalidUsage)?;
        if list.len() > MAX_ROWS {
            return Err(InvalidUsage);
        }
        // Rows are validated before the timestamp is read, as zod parses them first.
        let at = match observed_at {
            None => Some(now),
            Some(value) => value.as_f64(),
        };
        let parsed = list
            .iter()
            .map(|value| row(value, at.unwrap_or(now)))
            .collect::<Result<Vec<_>, _>>()?;
        let mut latest = self
            .latest_observed_at
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let Some(at) =
            at.filter(|at| *at <= now + FUTURE_SLACK_MS && now - *at <= FRESH_MS && *at >= *latest)
        else {
            return Ok(());
        };
        *latest = at;
        self.published
            .send_replace(Arc::new(UsageSnapshot { rows: parsed }));
        Ok(())
    }
}
