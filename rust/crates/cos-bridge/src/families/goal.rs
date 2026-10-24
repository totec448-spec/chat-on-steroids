//! E2.7: Goal and Loop. `POST /goal/{draft,ack,objective,open}`, as thin adapters over
//! [`cos_goal::Goal`]. These routes read their body inside `try`: too large is `413`, anything
//! else `400 bad_request` with the Goal explanation.

use std::sync::Arc;

use cos_goal::{Answer, Goal};

use crate::MAX_BODY_BYTES;
use crate::limits::BodyRefusal;
use crate::router::{BoxFuture, Exchange, Family, Reply, Route};

pub struct GoalRoutes {
    goal: Goal,
}

impl GoalRoutes {
    pub fn new(goal: Goal) -> Self {
        Self { goal }
    }
}

fn reply(answer: Answer) -> Reply {
    Reply::json(answer.status, &answer.body)
}

impl Family for GoalRoutes {
    fn routes(&self) -> &'static [Route] {
        const ROUTES: &[Route] = &[
            Route::post("/goal/draft"),
            Route::post("/goal/ack"),
            Route::post("/goal/objective"),
            Route::post("/goal/open"),
        ];
        ROUTES
    }

    fn serve(self: Arc<Self>, mut exchange: Exchange) -> BoxFuture<Reply> {
        Box::pin(async move {
            let body = match exchange.json(MAX_BODY_BYTES).await {
                Ok(body) => body,
                Err(BodyRefusal::TooLarge) => return Reply::error(413, "body_too_large"),
                Err(BodyRefusal::Invalid | BodyRefusal::Broken) => {
                    return reply(cos_goal::bad_request());
                }
            };
            let answer = match exchange.path() {
                "/goal/draft" => self.goal.draft_answer(&body).await,
                "/goal/ack" => self.goal.ack_answer(&body).await,
                "/goal/objective" => self.goal.objective_answer(&body).await,
                _ => self.goal.open_answer(&body).await,
            };
            reply(answer)
        })
    }
}
