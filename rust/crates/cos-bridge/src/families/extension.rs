//! E2.1: `POST /extension/update`. The extension is idle and about to reload into the build
//! this app ships, so the folder Chrome loads from is brought up to date first.

use std::sync::Arc;

use cos_store::Logger;
use serde_json::json;

use crate::extension::ExtensionFolder;
use crate::router::{BoxFuture, Exchange, Family, Reply, Route};

pub(crate) struct ExtensionUpdate {
    folder: ExtensionFolder,
    logger: Logger,
}

impl ExtensionUpdate {
    pub(crate) fn new(folder: ExtensionFolder, logger: Logger) -> Self {
        Self { folder, logger }
    }
}

impl Family for ExtensionUpdate {
    fn routes(&self) -> &'static [Route] {
        const ROUTES: &[Route] = &[Route::post("/extension/update")];
        ROUTES
    }

    fn serve(self: Arc<Self>, exchange: Exchange) -> BoxFuture<Reply> {
        Box::pin(async move {
            let running = exchange.peer().build.clone();
            let folder = self.folder.clone();
            let prepared =
                tokio::task::spawn_blocking(move || folder.prepare_update(running.as_deref()))
                    .await
                    .unwrap_or(None);
            match prepared {
                Some(prepared) => {
                    if prepared.ready {
                        self.logger.info(&format!(
                            "bridge: extension folder updated to build {}; the extension reloads itself now",
                            prepared.build
                        ));
                    } else {
                        self.logger.warn(&format!(
                            "bridge: could not update the extension folder to build {}",
                            prepared.build
                        ));
                    }
                    Reply::ok(&prepared)
                }
                None => Reply::ok(&json!({ "ready": false })),
            }
        })
    }
}
