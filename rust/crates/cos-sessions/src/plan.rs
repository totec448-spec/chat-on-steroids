//! `update_plan` (`src/main/mcp/plan-tool.ts`) and the plans accepted before their chat was
//! known (`src/main/session/request-plans.ts`, `state/request-plans.json`).

use cos_store::{Durable, DurableStore, Logger};
use cos_tools::{ArgIssue, CallContext, EpochMs, ToolError, ToolOutput, ToolResult};
use cos_types::ids::SessionId;
use cos_types::json::Extra;
use cos_types::session::{AgentPlanUpdate, PlanStep, PlanStepStatus};
use cos_types::state::{PendingRequestPlan, RequestCorrelation, RequestPlans, V1};

use crate::js;

const MAX_PENDING_PLANS: usize = 256;
const PLAN_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;

pub(crate) const IDENTITY_REQUIRED: &str = "Exact chat identity or an allowed request-scoped caller is required to update a plan. No plan was changed.";
pub(crate) const STALE_SESSION_PLAN: &str =
    "This plan update is stale or its chat was replaced. The current plan was preserved.";
const STALE_REQUEST_PLAN: &str =
    "This request plan update is stale. The current plan was preserved.";
const UPDATED_FOR_REQUEST: &str =
    "Plan updated for this request and will attach when its chat identity arrives.";

/// `agentPlanUpdateSchema.parse`: strings trimmed, then every bound checked.
pub(crate) fn normalize(update: AgentPlanUpdate) -> Result<AgentPlanUpdate, String> {
    let explanation = update.explanation.map(|text| js::trim(&text).to_owned());
    if explanation
        .as_ref()
        .is_some_and(|text| js::len(text) > 1000)
    {
        return Err("explanation: Too big: expected string to have <=1000 characters".into());
    }
    if update.plan.len() > 12 {
        return Err("plan: Too big: expected array to have <=12 items".into());
    }
    let mut plan = Vec::with_capacity(update.plan.len());
    for step in update.plan {
        let headline = js::trim(&step.step).to_owned();
        let details = step.details.map(|text| js::trim(&text).to_owned());
        if headline.is_empty() || js::len(&headline) > 160 {
            return Err("plan: a step headline must have 1 to 160 characters".into());
        }
        if details.as_ref().is_some_and(|text| js::len(text) > 2000) {
            return Err("plan: step details must have at most 2000 characters".into());
        }
        plan.push(PlanStep {
            step: headline,
            status: step.status,
            details,
        });
    }
    let update = AgentPlanUpdate { explanation, plan };
    match refine(&update) {
        Ok(()) => Ok(update),
        Err(issues) => Err(issues
            .first()
            .map(|issue| format!("plan: {}", issue.message))
            .unwrap_or_default()),
    }
}

/// The schema's two refinements of `plan`, which run on the trimmed steps.
pub(crate) fn refine(update: &AgentPlanUpdate) -> Result<(), Vec<ArgIssue>> {
    let mut issues = Vec::new();
    let in_progress = update
        .plan
        .iter()
        .filter(|step| step.status == PlanStepStatus::InProgress)
        .count();
    if in_progress > 1 {
        issues.push(ArgIssue::new(
            "plan",
            "At most one step may be in_progress.",
        ));
    }
    let size: usize = update
        .plan
        .iter()
        .map(|step| {
            js::len(js::trim(&step.step))
                + step.details.as_deref().map_or(0, |d| js::len(js::trim(d)))
        })
        .sum();
    if size > 12_000 {
        issues.push(ArgIssue::new(
            "plan",
            "Keep the complete plan below 12,000 characters.",
        ));
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

/// The pending request plans, loaded from their ledger on first use.
pub(crate) struct RequestPlansLedger {
    ledger: Option<Durable<RequestPlans>>,
    pending: Vec<PendingRequestPlan>,
    loaded: bool,
}

impl RequestPlansLedger {
    pub(crate) fn new(state: &std::path::Path, logger: &Logger) -> Self {
        let ledger = DurableStore::new(state, logger.clone())
            .ledger("request-plans")
            .ok();
        Self {
            ledger,
            pending: Vec::new(),
            loaded: false,
        }
    }

    fn load(&mut self, now: u64) {
        if self.loaded {
            return;
        }
        let saved = self
            .ledger
            .as_ref()
            .and_then(Durable::read)
            .and_then(|value| serde_json::from_value::<serde_json::Value>(value).ok());
        if let Some(saved) = saved
            && saved.get("version").and_then(serde_json::Value::as_u64) == Some(1)
            && let Some(entries) = saved.get("entries").and_then(serde_json::Value::as_array)
        {
            let start = entries.len().saturating_sub(MAX_PENDING_PLANS);
            for raw in &entries[start..] {
                if let Some(entry) = valid_entry(raw) {
                    self.pending
                        .retain(|held| held.request_id != entry.request_id);
                    self.pending.push(entry);
                }
            }
        }
        self.prune(now);
        self.loaded = true;
    }

    fn prune(&mut self, now: u64) {
        self.pending
            .retain(|entry| entry.stored_at >= now.saturating_sub(PLAN_TTL_MS));
        while self.pending.len() > MAX_PENDING_PLANS {
            self.pending.remove(0);
        }
    }

    fn persist(&self) -> Result<(), String> {
        let Some(ledger) = &self.ledger else {
            return Err("request plan ledger is unavailable".into());
        };
        let result = if self.pending.is_empty() {
            ledger.remove_now()
        } else {
            ledger.write_now(&RequestPlans {
                version: V1,
                entries: self.pending.clone(),
                extra: Extra::new(),
            })
        };
        result.map_err(|error| error.to_string())
    }

    /// `updateRequestPlan`: keeps the newest complete plan of one request.
    pub(crate) fn update(
        &mut self,
        request_id: &str,
        update: AgentPlanUpdate,
        started_at: u64,
        now: u64,
    ) -> Result<bool, String> {
        self.load(now);
        if self
            .pending
            .iter()
            .any(|entry| entry.request_id == request_id && entry.started_at > started_at)
        {
            return Ok(false);
        }
        let before = self.pending.clone();
        self.pending.retain(|entry| entry.request_id != request_id);
        self.pending.push(PendingRequestPlan {
            request_id: request_id.to_owned(),
            update,
            started_at,
            stored_at: now,
            extra: Extra::new(),
        });
        self.prune(now);
        if let Err(error) = self.persist() {
            self.pending = before;
            return Err(error);
        }
        Ok(true)
    }

    fn held(&mut self, request_id: &str, now: u64) -> Option<PendingRequestPlan> {
        self.load(now);
        self.pending
            .iter()
            .find(|entry| entry.request_id == request_id)
            .cloned()
    }

    fn release(&mut self, request_id: &str) -> Result<(), String> {
        let before = self.pending.clone();
        self.pending.retain(|entry| entry.request_id != request_id);
        if let Err(error) = self.persist() {
            self.pending = before;
            return Err(error);
        }
        Ok(())
    }
}

/// What became of a request's held plan once a page proved its chat.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanAttach {
    /// No plan was held for this request.
    Missing,
    /// The plan is now the chat's plan.
    Attached,
    /// The chat already has a newer plan, or was replaced before the plan was accepted; the
    /// held plan was dropped.
    Stale,
}

impl crate::SessionStore {
    /// `attachRequestPlan`: applies and removes the plan held for this request once its owner
    /// is proven. A failure keeps the plan held.
    pub async fn attach_request_plan(
        &self,
        owner: &RequestCorrelation,
    ) -> Result<PlanAttach, String> {
        let mut ledger = self.inner.request_plans.lock().await;
        let Some(entry) = ledger.held(&owner.request_id, EpochMs::now().0) else {
            return Ok(PlanAttach::Missing);
        };
        let session = SessionId::parse(&owner.session_id).map_err(|error| error.to_string())?;
        let accepted = self
            .update_session_plan(
                &session,
                &owner.conversation_id,
                entry.update,
                entry.started_at,
                Some(entry.stored_at),
            )
            .await?;
        ledger.release(&owner.request_id)?;
        Ok(if accepted {
            PlanAttach::Attached
        } else {
            PlanAttach::Stale
        })
    }

    /// The request ids that still hold a plan, for `reconcileRequestPlans` after restore.
    pub async fn held_request_plans(&self) -> Vec<String> {
        let mut ledger = self.inner.request_plans.lock().await;
        ledger.load(EpochMs::now().0);
        ledger
            .pending
            .iter()
            .map(|entry| entry.request_id.clone())
            .collect()
    }
}

fn valid_entry(value: &serde_json::Value) -> Option<PendingRequestPlan> {
    let request_id = value.get("requestId")?.as_str()?;
    if !(1..=200).contains(&js::len(request_id)) {
        return None;
    }
    let time = |key: &str| {
        value
            .get(key)?
            .as_f64()
            .filter(|at| at.is_finite() && *at >= 0.0)
            .map(|at| at as u64)
    };
    let started_at = time("startedAt")?;
    let stored_at = time("storedAt")?;
    let update: AgentPlanUpdate = serde_json::from_value(value.get("update")?.clone()).ok()?;
    Some(PendingRequestPlan {
        request_id: request_id.to_owned(),
        update: normalize(update).ok()?,
        started_at,
        stored_at,
        extra: Extra::new(),
    })
}

/// The tool body: the chat's own plan, or a request-scoped one when unattributed calls are on.
pub(crate) async fn call(
    store: &crate::SessionStore,
    cx: &CallContext,
    args: AgentPlanUpdate,
) -> Result<ToolOutput, ToolError> {
    let update = normalize(args).map_err(ToolError::Internal)?;
    let started_at = cx.started_at.0;
    if let Some((conversation, session)) = &cx.caller.chat {
        let accepted = store
            .update_session_plan(session, conversation.as_str(), update, started_at, None)
            .await
            .map_err(ToolError::Internal)?;
        return if accepted {
            Ok(ToolResult::text("Plan updated").into())
        } else {
            Err(ToolError::Refused(STALE_SESSION_PLAN.into()))
        };
    }
    let Some(request_id) = cx
        .caller
        .request_id
        .as_ref()
        .filter(|_| cx.grants.allow_unattributed)
    else {
        return Err(ToolError::Identity(IDENTITY_REQUIRED.into()));
    };
    let accepted = store
        .update_request_plan(request_id.as_str(), update, started_at)
        .await
        .map_err(ToolError::Internal)?;
    if !accepted {
        return Err(ToolError::Refused(STALE_REQUEST_PLAN.into()));
    }
    Ok(ToolResult::text(UPDATED_FOR_REQUEST).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update(step: &str) -> AgentPlanUpdate {
        AgentPlanUpdate {
            explanation: Some("  golden  ".into()),
            plan: vec![PlanStep {
                step: step.into(),
                status: PlanStepStatus::InProgress,
                details: None,
            }],
        }
    }

    #[test]
    fn a_request_plan_survives_a_reload_and_an_older_call_cannot_replace_it() {
        let root =
            std::env::temp_dir().join(format!("cos-sessions-request-plans-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let logger = Logger::new();
        let mut ledger = RequestPlansLedger::new(&root, &logger);
        assert_eq!(
            ledger.update(
                "golden-request-1",
                normalize(update(" First ")).expect("valid"),
                2_000,
                5_000
            ),
            Ok(true)
        );
        let written: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.join("request-plans.json")).expect("ledger"),
        )
        .expect("json");
        assert_eq!(
            written,
            serde_json::json!({ "version": 1, "entries": [{
                "requestId": "golden-request-1",
                "update": { "explanation": "golden", "plan": [{ "step": "First", "status": "in_progress" }] },
                "startedAt": 2_000, "storedAt": 5_000
            }] })
        );
        let mut reloaded = RequestPlansLedger::new(&root, &logger);
        assert_eq!(
            reloaded.update("golden-request-1", update("Older"), 1_000, 6_000),
            Ok(false)
        );
        assert_eq!(
            reloaded.update("golden-request-1", update("Newer"), 3_000, 6_000),
            Ok(true)
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn normalizing_trims_then_checks_every_bound() {
        assert_eq!(normalize(update("  a  ")).expect("valid").plan[0].step, "a");
        assert!(normalize(update("   ")).is_err());
        let two = AgentPlanUpdate {
            explanation: None,
            plan: vec![update("a").plan.remove(0), update("b").plan.remove(0)],
        };
        assert!(normalize(two).is_err(), "two steps in progress");
    }
}
