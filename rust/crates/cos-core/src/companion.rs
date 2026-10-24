//! Builds the E2.4 owners once: the bridge family reads and writes them, and the UI watches
//! them through [`crate::Domains`].

use std::sync::{Arc, Mutex};

use cos_bridge::families::models::{Companion, CompanionDeps};
use cos_bridge::{Bridge, ExtensionFolder};
use cos_companion::custody::Custody;
use cos_companion::settings::GoalKeys;
use cos_companion::status::Owners;
use cos_companion::{
    BoxFuture, BrowserWork, ChatModels, ConfigWriter, Diagnostics, NoPluginRefreshes, NoProjects,
    PreferenceRequests, ProjectCreates, StatusCall, UsageLimits, WorkParts, system_clock,
};
use cos_input::{Commands, Outbox};
use cos_recorder::Recorder;
use cos_secrets::SecretStore;
use cos_store::{DurableStore, Logger};
use cos_tools::{EpochMs, Kernel};
use cos_types::bridge::{ClosePlanner, StatusInput, WakeSignal};
use cos_types::config::Config;
use cos_types::json::True;
use cos_types::state::{InputEntry, InputLifetime, InputState};

use crate::settings::Settings;

/// The E2.4 owners a UI reads.
#[derive(Clone)]
pub struct CompanionDomains {
    pub chat_models: ChatModels,
    pub usage: UsageLimits,
    pub browser_preferences: PreferenceRequests,
    pub diagnostics: Diagnostics,
}

impl ConfigWriter for Settings {
    fn update(
        &self,
        change: Box<dyn FnOnce(&Config) -> Config + Send>,
    ) -> BoxFuture<'static, Result<Arc<Config>, String>> {
        let settings = self.clone();
        Box::pin(async move {
            settings
                .update(move |config| Ok(change(config)))
                .await
                .map_err(|error| error.to_string())
        })
    }
}

/// The owners of browser work the companion reads: recorded chats (E2.2), the outbox and the
/// command ledger (E2.3), Compact & Resume (E2.5), and the kernel's running calls. For `/status`,
/// a chat counts as having no tool call in flight and no tunnel takeover settling: the kernel
/// counts calls only in total, and no tunnel owner reports a takeover yet.
pub(crate) struct Work {
    recorder: Recorder,
    outbox: Outbox,
    commands: Commands,
    kernel: Arc<Kernel>,
    custody: Arc<Custody>,
    continuations: cos_continuation::Continuations,
}

impl Work {
    pub(crate) fn new(
        recorder: Recorder,
        outbox: Outbox,
        commands: Commands,
        kernel: Arc<Kernel>,
        continuations: cos_continuation::Continuations,
    ) -> Self {
        Self {
            recorder,
            outbox,
            commands,
            kernel,
            custody: Arc::new(Custody::default()),
            continuations,
        }
    }
}

/// A planner tab whose message is over: the extension closes it (`close`, `retire`).
fn finished_planner(row: &InputEntry) -> Option<StatusInput> {
    let over = matches!(
        row.state,
        InputState::Sent | InputState::Cancelled | InputState::Failed
    );
    (row.lifetime == Some(InputLifetime::TemporaryPlanner) && over).then(|| {
        StatusInput::Close(ClosePlanner {
            id: row.id.clone(),
            owner: row.owner.clone(),
            lifetime: InputLifetime::TemporaryPlanner,
            close: True,
            retire: True,
            conversation_id: row.conversation_id.clone(),
        })
    })
}

impl BrowserWork for Work {
    fn status(&self, call: StatusCall) -> BoxFuture<'static, WorkParts> {
        let recorder = self.recorder.clone();
        let outbox = self.outbox.clone();
        let commands = self.commands.clone();
        let custody = self.custody.clone();
        let continuations = self.continuations.clone();
        Box::pin(async move {
            let mut parts = WorkParts::none(&call);
            parts.conversations = recorder.live_conversations();
            parts.stop_turns = commands
                .pending_stops()
                .await
                .into_iter()
                .filter_map(|stop| serde_json::from_value(stop).ok())
                .collect();
            // An outbox that cannot be read hands out nothing; the next pass asks again.
            let rows = outbox.list().await.unwrap_or_default();
            parts.input_opening_ids = rows
                .iter()
                .filter(|row| {
                    !matches!(
                        row.state,
                        InputState::Sent | InputState::Failed | InputState::Cancelled
                    )
                })
                .map(|row| row.id.clone())
                .collect();
            let mut inputs: Vec<StatusInput> = outbox
                .pending()
                .await
                .unwrap_or_default()
                .into_iter()
                .filter_map(|offer| serde_json::from_value(offer).ok())
                .map(StatusInput::Pending)
                .collect();
            inputs.extend(rows.iter().filter_map(finished_planner));
            parts.inputs = custody.hand_out(&call, inputs, EpochMs::now().0);
            parts.command_ids = commands.ids().await;
            crate::continuation::tab_facts(
                &mut parts.tabs,
                &call.open_conversations,
                &continuations,
            );
            parts
        })
    }

    fn input_project(&self, input_id: String) -> BoxFuture<'static, Option<String>> {
        let outbox = self.outbox.clone();
        Box::pin(async move {
            outbox
                .list()
                .await
                .ok()?
                .into_iter()
                .find(|row| row.id == input_id)?
                .project_id
                .flatten()
        })
    }
}

pub(crate) struct Built {
    pub(crate) family: Companion,
    pub(crate) domains: CompanionDomains,
}

pub(crate) fn build(
    state: &DurableStore,
    settings: &Settings,
    bridge: &Bridge,
    extension: ExtensionFolder,
    secrets: Arc<Mutex<SecretStore>>,
    (work, policy, goal): (Work, Arc<dyn cos_companion::ChatPolicy>, cos_goal::Goal),
    logger: &Logger,
) -> Built {
    let clock = system_clock();
    let kernel = work.kernel.clone();
    let wake = bridge.wake();
    let wake: cos_companion::WakeBrowser = Arc::new(move || wake.signal(WakeSignal::Wake));
    let domains = CompanionDomains {
        chat_models: ChatModels::new(state, clock.clone(), wake.clone(), logger.clone()),
        usage: UsageLimits::new(),
        browser_preferences: PreferenceRequests::new(clock.clone(), wake),
        diagnostics: Diagnostics::new(),
    };
    let family = Companion::new(CompanionDeps {
        owners: Owners {
            models: domains.chat_models.clone(),
            preferences: domains.browser_preferences.clone(),
            projects: ProjectCreates::new(Arc::new(NoProjects), clock),
            plugins: Arc::new(NoPluginRefreshes),
            work: Arc::new(work),
        },
        usage: domains.usage.clone(),
        diagnostics: domains.diagnostics.clone(),
        config: settings.config(),
        config_writer: Arc::new(settings.clone()),
        policy,
        switches: Arc::new(crate::goal::GoalSwitches(goal)),
        keys: GoalKeys::new(secrets),
        extension,
        running_tool_calls: Arc::new(move || kernel.counts().running),
        logger: logger.clone(),
    });
    Built { family, domains }
}
