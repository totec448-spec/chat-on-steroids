//! E2.5: Compact & Resume and repair claims. `POST /compact` and `POST /repairs/claim`, as thin
//! adapters over [`cos_continuation::compact::Compact`] and
//! [`cos_continuation::repairs::Repairs`].

use std::sync::Arc;

use cos_continuation::Answer;
use cos_continuation::compact::Compact;
use cos_continuation::repairs::Repairs;

use crate::MAX_BODY_BYTES;
use crate::limits::BodyRefusal;
use crate::router::{BoxFuture, Exchange, Family, Reply, Route};

pub struct ContinuationRoutes {
    compact: Compact,
    repairs: Repairs,
}

impl ContinuationRoutes {
    pub fn new(compact: Compact, repairs: Repairs) -> Self {
        Self { compact, repairs }
    }
}

fn reply(answer: Answer) -> Reply {
    Reply::json(answer.status, &answer.body)
}

impl Family for ContinuationRoutes {
    fn routes(&self) -> &'static [Route] {
        const ROUTES: &[Route] = &[Route::post("/compact"), Route::post("/repairs/claim")];
        ROUTES
    }

    fn serve(self: Arc<Self>, mut exchange: Exchange) -> BoxFuture<Reply> {
        Box::pin(async move {
            if exchange.path() == "/repairs/claim" {
                // `staleCompanion(req)` needs the shipped build's last sighting, which the
                // transport does not hand a family yet; every companion counts as current.
                let body = exchange.json(MAX_BODY_BYTES).await.ok();
                return reply(self.repairs.claim(false, body.as_ref()).await);
            }
            match exchange.json(MAX_BODY_BYTES).await {
                Ok(body) => reply(self.compact.answer(&body).await),
                Err(BodyRefusal::TooLarge) => Reply::error(413, "body_too_large"),
                Err(BodyRefusal::Invalid | BodyRefusal::Broken) => Reply::error(400, "bad_request"),
            }
        })
    }
}
