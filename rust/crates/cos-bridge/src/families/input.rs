//! E2.3: the message outbox and the durable browser commands. `/input/{claim,bind,ack,fail,
//! answer,progress,attachment}`, `/conversation-deleted`, `/image-export` and
//! `/commands/{revivals/pending,redeem,step,ack}`, as thin adapters over
//! [`cos_input::Outbox`] and [`cos_input::Commands`].

use std::sync::Arc;

use cos_input::{Answer, Commands, IMAGE_EXPORT_BODY_BYTES, Outbox, image_export_answer};

use crate::MAX_BODY_BYTES;
use crate::limits::BodyRefusal;
use crate::router::{BoxFuture, Exchange, Family, Reply, Route};

pub struct Input {
    outbox: Outbox,
    commands: Commands,
}

impl Input {
    pub fn new(outbox: Outbox, commands: Commands) -> Self {
        Self { outbox, commands }
    }
}

fn reply(answer: Answer) -> Reply {
    Reply::json(answer.status, &answer.body)
}

/// The routes that read their body inside `try`: too large is `413`, anything else `400`.
fn unreadable(refusal: BodyRefusal) -> Reply {
    match refusal {
        BodyRefusal::TooLarge => Reply::error(413, "body_too_large"),
        BodyRefusal::Invalid | BodyRefusal::Broken => Reply::error(400, "bad_request"),
    }
}

impl Family for Input {
    fn routes(&self) -> &'static [Route] {
        const ROUTES: &[Route] = &[
            Route::post("/input/claim"),
            Route::post("/input/bind"),
            Route::post("/input/ack"),
            Route::post("/input/fail"),
            Route::post("/input/answer"),
            Route::post("/input/progress"),
            Route::post("/input/attachment"),
            Route::post("/conversation-deleted"),
            Route::post("/image-export"),
            Route::post("/commands/revivals/pending"),
            Route::post("/commands/redeem"),
            Route::post("/commands/step"),
            Route::post("/commands/ack"),
        ];
        ROUTES
    }

    fn serve(self: Arc<Self>, mut exchange: Exchange) -> BoxFuture<Reply> {
        Box::pin(async move {
            let path = exchange.path().to_owned();
            if path.starts_with("/commands/") {
                return match exchange.json(MAX_BODY_BYTES).await {
                    Ok(body) => reply(self.commands.answer(&path, &body).await),
                    Err(refusal) => unreadable(refusal),
                };
            }
            if path == "/image-export" {
                return match exchange.json(IMAGE_EXPORT_BODY_BYTES).await {
                    Ok(body) => reply(image_export_answer(&body)),
                    Err(refusal) => unreadable(refusal),
                };
            }
            // These read their body outside `try`: a body that cannot be read throws, and
            // `handle()` answers `500 internal`.
            let Ok(body) = exchange.json(MAX_BODY_BYTES).await else {
                return Reply::internal();
            };
            if path == "/conversation-deleted" {
                return reply(self.outbox.deleted_answer(&body).await);
            }
            reply(self.outbox.answer(&path, &body).await)
        })
    }
}
