//! E2.8: direct browser control. `POST /browser-control` (the extension polls, claims, checks
//! and reports the `browser_*` tool commands) and `/cos-browser/sign-in` (the CoS browser's
//! sign-in transfer), as thin adapters over [`cos_browser_control::BrowserControl`].

use std::sync::Arc;

use cos_browser_control::{Answer, BrowserControl, SignInMethod};
use http::Method;

use crate::MAX_BODY_BYTES;
use crate::router::{BoxFuture, Exchange, Family, Reply, Route};

/// `readBody(req, 96 * 1024)` for `/cos-browser/sign-in`.
const SIGN_IN_BODY_BYTES: usize = 96 * 1024;

pub struct BrowserControlRoutes {
    control: BrowserControl,
}

impl BrowserControlRoutes {
    pub fn new(control: BrowserControl) -> Self {
        Self { control }
    }
}

fn reply(answer: Answer) -> Reply {
    Reply::json(answer.status, &answer.body)
}

impl Family for BrowserControlRoutes {
    fn routes(&self) -> &'static [Route] {
        const ROUTES: &[Route] = &[
            Route::post("/browser-control"),
            Route::any("/cos-browser/sign-in"),
        ];
        ROUTES
    }

    fn serve(self: Arc<Self>, mut exchange: Exchange) -> BoxFuture<Reply> {
        Box::pin(async move {
            if exchange.path() == "/browser-control" {
                // Read outside `try` in `bridge.ts`: a body that cannot be read throws, and
                // `handle()` answers `500 internal`.
                return match exchange.json(MAX_BODY_BYTES).await {
                    Ok(body) => reply(self.control.answer(&body).await),
                    Err(_) => Reply::internal(),
                };
            }
            let method = match *exchange.method() {
                Method::GET => SignInMethod::Get,
                Method::POST => SignInMethod::Post,
                _ => SignInMethod::Other,
            };
            let browser = exchange.peer().browser.clone();
            let body = async { exchange.json(SIGN_IN_BODY_BYTES).await.ok() };
            reply(
                self.control
                    .sign_in_answer(method, browser.as_deref(), body)
                    .await,
            )
        })
    }
}
