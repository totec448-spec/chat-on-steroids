//! Body caps and the request budget (`MAX_BODY_BYTES`, `readBody`, `RATE_LIMIT` in `bridge.ts`).

use std::time::Duration;

use bytes::{Bytes, BytesMut};
use http_body_util::BodyExt;
use hyper::body::Incoming;
use serde_json::Value;
use tokio::time::Instant;

/// The default cap on a request body.
pub const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
/// Requests allowed per window, across every route.
pub const RATE_LIMIT: u32 = 900;
const RATE_WINDOW: Duration = Duration::from_secs(60);
/// `requestTimeout`: a client that keeps a body open longer than this is cut off.
const BODY_DEADLINE: Duration = Duration::from_secs(30);

/// Why a body produced no JSON value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BodyRefusal {
    /// Longer than the cap. The rest was read and dropped, so the 413 reaches the client
    /// instead of a reset it would take for a crash.
    TooLarge,
    /// Not JSON.
    Invalid,
    /// The client stopped sending, or took longer than 30 s.
    Broken,
}

/// `readBody(req, limit)`: the parsed JSON body, `{}` for an empty one.
pub(crate) async fn read_json(body: Incoming, limit: usize) -> Result<Value, BodyRefusal> {
    let bytes = read_capped(body, limit).await?;
    if bytes.is_empty() {
        return Ok(Value::Object(serde_json::Map::new()));
    }
    serde_json::from_slice(&bytes).map_err(|_| BodyRefusal::Invalid)
}

async fn read_capped(mut body: Incoming, limit: usize) -> Result<Bytes, BodyRefusal> {
    let read = async {
        let mut kept = BytesMut::new();
        let mut overflowed = false;
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|_| BodyRefusal::Broken)?;
            let Ok(data) = frame.into_data() else {
                continue;
            };
            if overflowed {
                continue;
            }
            if kept.len() + data.len() > limit {
                overflowed = true;
                kept = BytesMut::new();
                continue;
            }
            kept.extend_from_slice(&data);
        }
        if overflowed {
            Err(BodyRefusal::TooLarge)
        } else {
            Ok(kept.freeze())
        }
    };
    tokio::time::timeout(BODY_DEADLINE, read)
        .await
        .unwrap_or(Err(BodyRefusal::Broken))
}

/// One fixed window shared by every route: it starts at the first request after the previous
/// window ended, and allows [`RATE_LIMIT`] requests in it.
#[derive(Debug)]
pub(crate) struct RateWindow {
    start: Instant,
    count: u32,
}

impl RateWindow {
    pub(crate) fn new(now: Instant) -> Self {
        Self {
            start: now,
            count: 0,
        }
    }

    /// Counts one request. True when it is over the budget and must be refused.
    pub(crate) fn exceeded(&mut self, now: Instant) -> bool {
        if now.duration_since(self.start) > RATE_WINDOW {
            *self = Self::new(now);
        }
        self.count = self.count.saturating_add(1);
        self.count > RATE_LIMIT
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_allows_900_requests_a_minute_then_starts_over() {
        let start = Instant::now();
        let mut window = RateWindow::new(start);
        for _ in 0..RATE_LIMIT {
            assert!(!window.exceeded(start));
        }
        assert!(window.exceeded(start + Duration::from_secs(59)));
        assert!(window.exceeded(start + RATE_WINDOW));
        assert!(!window.exceeded(start + RATE_WINDOW + Duration::from_millis(1)));
    }
}
