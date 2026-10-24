//! The `agents` tool: one tool, four actions. Caller identity comes from the kernel's
//! attribution, never from model arguments. Every result carries `structuredContent` beside a
//! sentence or two of prose.

use cos_tools::{
    ArgIssue, CallContext, Feature, Listing, Requirement, Tool, ToolError, ToolOutput, ToolResult,
    ToolSpec,
};
use cos_types::session::{AgentInfo, AgentState};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::broker::{AgentError, Caller, MessageItem, PRIME_ID, WorkerRequest};
use crate::{AcceptError, Agents};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Action {
    Spawn,
    Message,
    Status,
    Finish,
}

#[derive(Debug, Deserialize)]
pub(crate) struct WorkerArg {
    label: Option<String>,
    task: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct MessageArg {
    to: String,
    text: String,
    label: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AgentsArgs {
    action: Action,
    run_id: Option<String>,
    context: Option<String>,
    workers: Option<Vec<WorkerArg>>,
    messages: Option<Vec<MessageArg>>,
    to: Option<String>,
    target_run_id: Option<String>,
    text: Option<String>,
    result: Option<String>,
}

pub(crate) struct AgentsTool {
    agents: Agents,
}

impl AgentsTool {
    pub(crate) fn new(agents: Agents) -> Self {
        Self { agents }
    }
}

fn fail(text: impl Into<String>) -> ToolError {
    ToolError::Refused(text.into())
}

fn refusal(error: AgentError) -> ToolError {
    match error {
        AgentError::Identity(text) => ToolError::Identity(text),
        AgentError::Refused(text) => ToolError::Refused(text),
    }
}

fn accepted(error: AcceptError) -> ToolError {
    match error {
        AcceptError::Refused(error) => refusal(error),
        AcceptError::NotDurable(text) => ToolError::Refused(text),
    }
}

fn answer(text: String, structured: Value) -> ToolOutput {
    ToolOutput::from(ToolResult {
        structured_content: Some(structured),
        ..ToolResult::text(text)
    })
}

impl Tool for AgentsTool {
    type Args = AgentsArgs;

    const SPEC: &'static ToolSpec = &ToolSpec {
        name: "agents",
        listing: Listing::Feature(Feature::MultiAgent),
        requires: Requirement::Feature(Feature::MultiAgent),
    };

    /// The schema's `superRefine`: each field belongs to one action.
    fn refine(args: &AgentsArgs) -> Result<(), Vec<ArgIssue>> {
        let mut issues = Vec::new();
        let mut reject = |present: bool, field: &str, message: &str| {
            if present {
                issues.push(ArgIssue::new(field, message));
            }
        };
        if args.action != Action::Spawn {
            reject(
                args.context.is_some(),
                "context",
                "context is only valid with action=spawn",
            );
            reject(
                args.workers.is_some(),
                "workers",
                "workers is only valid with action=spawn",
            );
        }
        if args.action != Action::Message {
            reject(
                args.messages.is_some(),
                "messages",
                "messages is only valid with action=message",
            );
            reject(
                args.to.is_some(),
                "to",
                "to is only valid with action=message",
            );
            reject(
                args.target_run_id.is_some(),
                "target_run_id",
                "target_run_id is only valid with action=message",
            );
            reject(
                args.text.is_some(),
                "text",
                "text is only valid with action=message",
            );
        }
        if args.action != Action::Finish {
            reject(
                args.result.is_some(),
                "result",
                "result is only valid with action=finish",
            );
        }
        if issues.is_empty() {
            Ok(())
        } else {
            Err(issues)
        }
    }

    async fn call(&self, cx: &CallContext, args: AgentsArgs) -> Result<ToolOutput, ToolError> {
        let caller = Caller {
            conversation_id: cx
                .caller
                .chat
                .as_ref()
                .map(|(conversation, _)| conversation.as_str().to_owned()),
            request_id: cx
                .caller
                .request_id
                .as_ref()
                .map(|id| id.as_str().to_owned()),
            setup_profile_id: cx.inbound.setup_profile_id.clone(),
            run_id: args.run_id.clone(),
        };
        match args.action {
            Action::Spawn => self.spawn(caller, args).await,
            Action::Message => self.message(caller, args).await,
            Action::Finish => self.finish(caller, args).await,
            Action::Status => self.status(caller).await,
        }
    }
}

fn describe(info: &AgentInfo) -> String {
    format!(
        "{} ({}, {}{}{})",
        info.id,
        info.label,
        info.state.as_str(),
        info.model
            .as_ref()
            .map(|model| format!(", model {model}"))
            .unwrap_or_default(),
        info.reasoning_effort
            .map(|effort| format!(", reasoning {}", effort.as_str()))
            .unwrap_or_default()
    )
}

/// The word the model reads as the whole answer to "may I use this worker again".
fn shown(info: &AgentInfo) -> &'static str {
    match info.state {
        AgentState::Sleeping if info.revivable => "sleeping (reusable; wake with action=message)",
        AgentState::Waking => "waking (your message is being delivered to its chat)",
        AgentState::Finished => "finished (not reusable)",
        state => state.as_str(),
    }
}

impl AgentsTool {
    async fn spawn(&self, caller: Caller, args: AgentsArgs) -> Result<ToolOutput, ToolError> {
        let Some(workers) = args.workers else {
            return Err(fail("agents action=spawn requires workers."));
        };
        let requests: Vec<WorkerRequest> = workers
            .into_iter()
            .map(|worker| WorkerRequest {
                label: worker.label,
                task: worker.task,
                model: worker.model,
                reasoning_effort: worker.reasoning_effort,
            })
            .collect();
        let models = self.agents.observed_models();
        let context = args.context;
        let spawn_caller = caller.clone();
        let staged = self
            .agents
            .accept(
                "The worker run could not cross its durable acceptance barrier. The spawn was rolled back; retry this same request.",
                move |broker, policy, now| {
                    broker.spawn(&spawn_caller, &requests, context.as_deref(), policy, &models, now)
                },
            )
            .await
            .map_err(accepted)?;
        let policy = self.agents.policy();
        let mut isolation = Vec::new();
        if !staged.newly_staged.is_empty() && policy.auto_worktrees {
            isolation.push(
                "No workspace is selected; workers were spawned without isolated Git worktrees.",
            );
        }
        let ids: Vec<String> = staged.created.iter().map(|info| info.id.clone()).collect();
        self.agents.request_bootstraps(&ids, &staged.run_id).await;
        let invited = staged
            .created
            .iter()
            .any(|info| info.state == AgentState::Invited);
        let sleeping: Vec<&str> = staged
            .created
            .iter()
            .filter(|info| info.state == AgentState::Sleeping && info.revivable)
            .map(|info| info.id.as_str())
            .collect();
        let described: Vec<String> = staged.created.iter().map(describe).collect();
        let mut text = String::new();
        if staged.became_prime {
            text.push_str(&format!(
                "This {} is now the prime agent of run {}. ",
                if caller.conversation_id.is_some() {
                    "conversation"
                } else {
                    "request"
                },
                staged.run_id
            ));
        }
        text.push_str(&format!(
            "{} worker(s) matched: {}. ",
            staged.created.len(),
            described.join(", ")
        ));
        if invited {
            text.push_str("New worker chats are opening with their briefs already in them. ");
        }
        if !staged.default_notes.is_empty() {
            text.push_str(&format!("{} ", staged.default_notes.join(" ")));
        }
        if !isolation.is_empty() {
            text.push_str(&format!("{} ", isolation.join(" ")));
        }
        if !sleeping.is_empty() {
            text.push_str(&format!(
                "{} already finished that earlier piece and is sleeping in its existing chat; wake it with action=message instead of spawning a duplicate. ",
                sleeping.join(", ")
            ));
        }
        text.push_str(
            "Carry on with your own work \u{2014} results and messages arrive at the end of later tool results, so there is nothing to wait for and never anything to poll. A short correction with action=message while a worker is still going is far cheaper than the alternative.",
        );
        let workers: Vec<Value> = staged
            .created
            .iter()
            .map(|info| {
                json!({
                    "id": info.id,
                    "label": info.label,
                    "state": info.state.as_str(),
                    "model": info.model,
                    "reasoning_effort": info.reasoning_effort.map(|effort| effort.as_str()),
                })
            })
            .collect();
        Ok(answer(
            text,
            json!({
                "action": "spawn",
                "run_id": staged.run_id,
                "self": PRIME_ID,
                "became_prime": staged.became_prime,
                "workers": workers,
            }),
        ))
    }

    async fn message(&self, caller: Caller, args: AgentsArgs) -> Result<ToolOutput, ToolError> {
        if let Some(target) = args.target_run_id {
            if args
                .messages
                .as_ref()
                .is_some_and(|messages| !messages.is_empty())
            {
                return Err(fail(
                    "agents action=message with target_run_id takes one text message, not messages[].",
                ));
            }
            if args.to.as_deref().is_some_and(|to| to != PRIME_ID) {
                return Err(fail(
                    "agents action=message with target_run_id can address only the destination prime.",
                ));
            }
            let Some(text) = args.text else {
                return Err(fail(
                    "agents action=message with target_run_id requires text.",
                ));
            };
            let staged = self
                .agents
                .accept(
                    "The prime message could not cross its durable acceptance barrier. Nothing was queued; retry the same message request.",
                    move |broker, policy, now| broker.prime_message(&caller, &target, &text, policy, now),
                )
                .await
                .map_err(accepted)?;
            return Ok(answer(
                format!(
                    "Queued for prime family {}. The recipient can reply with target_run_id={}.",
                    staged.target_run_id, staged.source_run_id
                ),
                json!({
                    "action": "message",
                    "run_id": staged.source_run_id,
                    "target_run_id": staged.target_run_id,
                    "queued": [{ "to": PRIME_ID }],
                }),
            ));
        }
        let batch = args.messages.unwrap_or_default();
        let single = match (args.to, args.text) {
            (Some(to), Some(text)) => Some(MessageItem {
                to,
                text,
                label: None,
            }),
            _ => None,
        };
        if !batch.is_empty() && single.is_some() {
            return Err(fail(
                "agents action=message takes either to+text or messages, not both.",
            ));
        }
        let items: Vec<MessageItem> = if batch.is_empty() {
            single.into_iter().collect()
        } else {
            batch
                .into_iter()
                .map(|item| MessageItem {
                    to: item.to,
                    text: item.text,
                    label: item.label,
                })
                .collect()
        };
        if items.is_empty() {
            return Err(fail(
                "agents action=message requires to and text, or a messages array.",
            ));
        }
        // `measureSleepingWorkers` reads the caller's family first, so an unplaceable call is
        // refused with the identity text before any message is considered.
        self.agents
            .read(|broker, policy| broker.swarm_state_for_caller(&caller, policy).map(|_| ()))
            .await
            .map_err(refusal)?;
        let staged = self
            .agents
            .accept(
                "The agent message could not cross its durable acceptance barrier. Nothing was queued; retry the same message request.",
                move |broker, policy, now| broker.stage_messages(&caller, &items, policy, now),
            )
            .await
            .map_err(accepted)?;
        if !staged.waking.is_empty() {
            self.agents
                .request_revivals(&staged.waking, &staged.run_id)
                .await;
        }
        let mut recipients: Vec<&str> = Vec::new();
        for message in &staged.messages {
            if !recipients.contains(&message.to.as_str()) {
                recipients.push(&message.to);
            }
        }
        let mut text = format!("Queued for {}.", recipients.join(", "));
        if !staged.waking.is_empty() {
            text.push_str(&format!(
                " Waking {} in {}.",
                staged.waking.join(", "),
                if staged.waking.len() == 1 {
                    "the same chat"
                } else {
                    "their existing chats"
                }
            ));
        }
        let queued: Vec<Value> = staged
            .messages
            .iter()
            .map(|message| json!({ "to": message.to }))
            .collect();
        Ok(answer(
            text,
            json!({
                "action": "message",
                "run_id": staged.run_id,
                "queued": queued,
                "waking": staged.waking,
            }),
        ))
    }

    async fn finish(&self, caller: Caller, args: AgentsArgs) -> Result<ToolOutput, ToolError> {
        let Some(result) = args.result else {
            return Err(fail(
                "agents action=finish requires result: the report the prime reads in your place \u{2014} what you changed, what you verified and what is left. Send it as result and call finish again.",
            ));
        };
        let finished = self
            .agents
            .accept(
                "The worker finish could not cross its durable acceptance barrier. Nothing was published; retry the same finish result.",
                move |broker, policy, now| broker.finish(&caller, &result, policy, now),
            )
            .await
            .map_err(accepted)?;
        let info = &finished.info;
        let text = if finished.repeat {
            format!(
                "{} was already {}; the previous result was already recorded for the prime, so nothing was queued again. This acknowledgment does not confirm delivery to the prime. Stop working and stop calling tools.",
                info.id,
                info.state.as_str()
            )
        } else if info.state == AgentState::Finished {
            format!(
                "{} is finished. Your result was recorded for the prime. This acknowledgment does not confirm delivery to the prime. This chat has also reached its context limit, so there will be no more work in it: stop working and stop calling tools.",
                info.id
            )
        } else {
            format!(
                "{} reported and is now asleep but remains reusable. Your result was recorded for the prime. This acknowledgment does not confirm delivery to the prime. Your worker slot is free. Stop working and stop calling tools; for related follow-up work the prime should wake this same chat with agents action=message before spawning a replacement.",
                info.id
            )
        };
        Ok(answer(
            text,
            json!({
                "action": "finish",
                "self": info.id,
                "state": info.state.as_str(),
                "repeat": finished.repeat,
            }),
        ))
    }

    async fn status(&self, caller: Caller) -> Result<ToolOutput, ToolError> {
        let (status, families) = self
            .agents
            .read(|broker, policy| {
                broker
                    .status_for_caller(&caller, policy)
                    .map(|status| (status, broker.agent_families_for_caller(&caller, policy)))
            })
            .await
            .map_err(refusal)?;
        let available: Vec<Value> = families
            .iter()
            .map(|family| json!({ "run_id": family.run_id, "running": family.running }))
            .collect();
        let family_notice = if families.len() > 1 {
            let listed: Vec<String> = families
                .iter()
                .map(|family| {
                    format!(
                        "{} ({})",
                        family.run_id,
                        if family.running { "active" } else { "retained" }
                    )
                })
                .collect();
            format!(
                "\n\nYour worker families: {}. Use run_id to select a family; worker names are local to that family.",
                listed.join(", ")
            )
        } else {
            String::new()
        };
        let slots = status.free_worker_slots;
        let Some(me) = status.self_info else {
            let text = if families.is_empty() {
                "No workers or retained worker history belong to this caller. Use agents action=spawn if the task needs workers.".to_owned()
            } else {
                format!("Select one of your worker families with run_id.{family_notice}")
            };
            let mut structured = json!({
                "action": "status", "run_id": null, "self": null, "agents": [], "free_worker_slots": slots,
            });
            if families.len() > 1 {
                structured["available_runs"] = Value::Array(available);
            }
            return Ok(answer(text, structured));
        };
        let agents = &status.state.agents;
        let rows: Vec<String> = agents
            .iter()
            .map(|info| {
                let mut row = format!(
                    "{}  {}  {}  waiting {}  {}",
                    info.id,
                    info.role.as_str(),
                    shown(info),
                    info.pending,
                    info.label
                );
                if let Some(model) = &info.model {
                    row.push_str(&format!("  model {model}"));
                }
                if let Some(effort) = info.reasoning_effort {
                    row.push_str(&format!("  reasoning {}", effort.as_str()));
                }
                if let Some(result) = info.result.as_deref() {
                    let word = match info.state {
                        AgentState::Failed => "failure",
                        AgentState::Finished => "result",
                        _ => "latest result",
                    };
                    row.push_str(&format!(
                        "\n    {word}: {}",
                        crate::text::js_slice(result, 300)
                    ));
                }
                row
            })
            .collect();
        let mut text = format!("You are {}.\n{}", me.id, rows.join("\n"));
        if me.id == PRIME_ID {
            text.push_str(&format!(
                "\n\n{slots} of your worker slots {} free.",
                if slots == 1 { "is" } else { "are" }
            ));
            let asleep: Vec<&str> = agents
                .iter()
                .filter(|info| info.state == AgentState::Sleeping && info.revivable)
                .map(|info| info.id.as_str())
                .collect();
            if !asleep.is_empty() {
                text.push_str(&format!(
                    " REUSE FIRST: {} {} asleep and can be woken with agents action=message, in the chat they already have and with everything they learned there still in it. For related follow-up work, do this before action=spawn{}",
                    asleep.join(", "),
                    if asleep.len() == 1 { "is" } else { "are" },
                    if slots == 0 { ", once a slot frees up." } else { "." }
                ));
            }
        }
        let failed: Vec<&str> = agents
            .iter()
            .filter(|info| info.state == AgentState::Failed)
            .map(|info| info.id.as_str())
            .collect();
        if !failed.is_empty() {
            text.push_str(&format!(
                "\n\n{} will not report. Do that work yourself or wake another worker; do not wait for them.",
                failed.join(", ")
            ));
        }
        text.push_str(&family_notice);
        text.push_str("\n\nThis is the current stats, keep working.");
        let listed: Vec<Value> = agents
            .iter()
            .map(|info| {
                json!({
                    "id": info.id,
                    "role": info.role.as_str(),
                    "label": info.label,
                    "model": info.model,
                    "reasoning_effort": info.reasoning_effort.map(|effort| effort.as_str()),
                    "state": info.state.as_str(),
                    "revivable": info.revivable,
                    "waiting": info.pending,
                    "result": info.result,
                })
            })
            .collect();
        let mut structured = json!({
            "action": "status",
            "run_id": status.run_id,
            "self": me.id,
            "free_worker_slots": slots,
        });
        if families.len() > 1 {
            structured["available_runs"] = Value::Array(available);
        }
        structured["agents"] = Value::Array(listed);
        Ok(answer(text, structured))
    }
}
