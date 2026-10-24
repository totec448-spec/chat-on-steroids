//! E2.2: what a ChatGPT page reports. `/events` (observations), `/correlations` (the request-id
//! ownership handshake), `/closed` and `/browser/presence`, as thin
//! adapters over [`cos_recorder::Recorder`].
//!
//! Still unclaimed here: `/activity`, `/activity/detail` and `/core-plugin`. `/repairs/claim`
//! belongs to browser recovery (repair handouts), not to correlation.

use std::sync::Arc;

use cos_recorder::{Recorder, Refusal};
use cos_tools::EpochMs;
use serde_json::json;

use crate::MAX_BODY_BYTES;
use crate::limits::BodyRefusal;
use crate::router::{BoxFuture, Exchange, Family, Reply, Route};

/// `readBody(req, 1024)` for `/browser/presence`.
const PRESENCE_BODY_BYTES: usize = 1024;

pub struct Observations {
    recorder: Recorder,
}

impl Observations {
    pub fn new(recorder: Recorder) -> Self {
        Self { recorder }
    }
}

/// The answer `bridge.ts` gives a body it cannot read on these routes.
fn unreadable(refusal: BodyRefusal) -> Reply {
    match refusal {
        BodyRefusal::TooLarge => Reply::error(413, "body_too_large"),
        BodyRefusal::Invalid | BodyRefusal::Broken => Reply::error(400, "bad_request"),
    }
}

fn refused(Refusal(word): Refusal) -> Reply {
    Reply::error(400, word)
}

impl Family for Observations {
    fn routes(&self) -> &'static [Route] {
        const ROUTES: &[Route] = &[
            Route::post("/events"),
            Route::post("/correlations"),
            Route::post("/closed"),
            Route::post("/browser/presence"),
        ];
        ROUTES
    }

    fn serve(self: Arc<Self>, mut exchange: Exchange) -> BoxFuture<Reply> {
        Box::pin(async move {
            let path = exchange.path().to_owned();
            let limit = if path == "/browser/presence" {
                PRESENCE_BODY_BYTES
            } else {
                MAX_BODY_BYTES
            };
            let body = match exchange.json(limit).await {
                Ok(body) => body,
                Err(refusal) => return unreadable(refusal),
            };
            let now = EpochMs::now();
            match path.as_str() {
                "/events" => match self.recorder.events(&body, now).await {
                    Ok(stored) => Reply::ok(&stored),
                    Err(refusal) => refused(refusal),
                },
                "/correlations" => match self.recorder.correlate(&body, now).await {
                    Ok(reply) => Reply::ok(&reply),
                    Err(refusal) => refused(refusal),
                },
                "/closed" => {
                    self.recorder.closed(&body).await;
                    Reply::ok(&json!({ "ok": true }))
                }
                // Setup's sign-in sighting for the person's own browser. No external extension
                // is known to this app yet, so, as in `bridge.ts` with none known, it is noted
                // nowhere.
                _ => Reply::ok(&json!({ "ok": true })),
            }
        })
    }
}
