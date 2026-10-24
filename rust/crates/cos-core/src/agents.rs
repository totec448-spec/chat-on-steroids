//! Builds the E2.6 broker once. The kernel serves its `agents` tool, the control API reads its
//! snapshot, and restore reads its two ledgers behind the admission fence.

use std::sync::{Arc, OnceLock};

use cos_agents::{Agents, AgentsDeps, NoWorkerBrowser, ObservedModel};
use cos_companion::ChatModels;
use cos_store::{DurableStore, Logger};
use cos_types::config::Config;
use tokio::sync::watch;

/// `models` is filled once the companion exists, which needs the kernel this broker's tool is
/// registered in. Until then a spawn sees no catalog, which TypeScript treats as "not observed
/// yet" and lets the browser confirm at Send.
pub(crate) fn build(
    state: &DurableStore,
    config: watch::Receiver<Arc<Config>>,
    models: Arc<OnceLock<ChatModels>>,
    logger: &Logger,
) -> Agents {
    Agents::new(AgentsDeps {
        state,
        config,
        logger: logger.clone(),
        clock: cos_agents::system_clock(),
        // The bridge's worker bootstrap and revival commands are not ported yet (cos-input
        // retires those rows), so a request is logged the way TypeScript logs it unpaired.
        browser: Arc::new(NoWorkerBrowser(logger.clone())),
        models: Arc::new(move || {
            models
                .get()
                .map(|catalog| {
                    catalog
                        .catalog()
                        .models
                        .into_iter()
                        .map(|choice| ObservedModel {
                            id: choice.id,
                            aliases: choice.aliases.unwrap_or_default(),
                            efforts: choice.efforts,
                        })
                        .collect()
                })
                .unwrap_or_default()
        }),
    })
}
