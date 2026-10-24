//! `state/swarm.json` (version 7) and `state/retired-workers.json`: what survives a restart.
//! Restore reads the file as plain JSON and repairs what TypeScript repairs, so one bad row
//! never costs the rest of the history.

use cos_types::json::Extra;
use cos_types::session::{AgentInfo, AgentMessage, AgentRole, AgentState};
use cos_types::state::V1;
use cos_types::state::{
    ActiveRunSnapshot, CleanupReason, DormantRunSnapshot, ManagedWorktreeCleanupOffer, RetiredChat,
    RetiredWorkers, SerializedAgent, SwarmSnapshot,
};
use indexmap::IndexMap;
use serde_json::Value;

use crate::broker::{
    Agent, Broker, Dormant, Family, PRIME_ID, RETIRED_WORKER_TTL_MS, bounded, cleanup_identity,
    cleanup_label, is_allocation_uuid, is_model_slug, is_v4_uuid, occupies_slot, random_uuid,
    reasoning_effort,
};

fn serialize_agents(family: &Family) -> Vec<SerializedAgent> {
    family
        .agents
        .values()
        .map(|agent| SerializedAgent {
            info: agent.info.clone(),
            queue: agent
                .queue
                .iter()
                .filter(|message| message.acked_at.is_none())
                .cloned()
                .collect(),
            extra: Extra::default(),
        })
        .collect()
}

fn non_empty(ids: &[String]) -> Option<Vec<String>> {
    (!ids.is_empty()).then(|| ids.to_vec())
}

/// Cleanup authority: the retained history plus every accepted terminal managed worker.
fn cleanup_offers(
    broker: &Broker,
    groups: &[&[SerializedAgent]],
    now: u64,
) -> Vec<ManagedWorktreeCleanupOffer> {
    let mut offers = broker.cleanup_history.clone();
    let mut candidates: IndexMap<String, Vec<ManagedWorktreeCleanupOffer>> = IndexMap::new();
    for group in groups {
        for SerializedAgent { info, .. } in group.iter() {
            let Some((run_id, agent_id)) = cleanup_identity(info) else {
                continue;
            };
            if info.managed_worktree_cleaned == Some(true) {
                continue;
            }
            let reason = match info.state {
                AgentState::Finished => CleanupReason::Completed,
                AgentState::Failed if !info.revivable => CleanupReason::Failed,
                _ => continue,
            };
            candidates
                .entry(format!("{run_id}:{agent_id}"))
                .or_default()
                .push(ManagedWorktreeCleanupOffer {
                    run_id,
                    agent_id,
                    reason,
                    created_at: info.finished_at.or(info.slept_at).unwrap_or(now),
                    label: Some(cleanup_label(info)),
                    extra: Extra::default(),
                });
        }
    }
    for (key, mut matches) in candidates {
        if matches.len() != 1 || offers.contains_key(&key) {
            continue;
        }
        if let Some(offer) = matches.pop() {
            offers.insert(key, offer);
        }
    }
    let mut list: Vec<ManagedWorktreeCleanupOffer> = offers.into_values().collect();
    list.sort_by(|a, b| {
        a.created_at.cmp(&b.created_at).then_with(|| {
            format!("{}:{}", a.run_id, a.agent_id).cmp(&format!("{}:{}", b.run_id, b.agent_id))
        })
    });
    list
}

/// `snapshotSwarm()`: `None` when nothing is left to keep, which removes the file.
pub(crate) fn build(broker: &Broker, now: u64) -> Option<SwarmSnapshot> {
    if broker.runs.is_empty()
        && broker.dormant.is_empty()
        && broker.managed_retired.is_empty()
        && broker.cleanup_history.is_empty()
    {
        return None;
    }
    let sole = (broker.runs.len() == 1)
        .then(|| broker.runs.iter().next())
        .flatten();
    let active: Vec<ActiveRunSnapshot> = broker
        .runs
        .iter()
        .map(|(run_id, family)| ActiveRunSnapshot {
            run_id: run_id.clone(),
            former_run_ids: non_empty(&family.former_run_ids),
            setup_profile_id: family.setup_profile_id.clone(),
            prime_conversation_id: family.prime_conversation_id.clone(),
            prime_request_id: family.prime_request_id.clone(),
            started_at: family.started_at,
            agents: serialize_agents(family),
            extra: Extra::default(),
        })
        .collect();
    let dormant: Vec<DormantRunSnapshot> = broker
        .dormant
        .values()
        .map(|dormant| DormantRunSnapshot {
            former_run_ids: non_empty(&dormant.family.former_run_ids),
            setup_profile_id: dormant.family.setup_profile_id.clone(),
            prime_conversation_id: dormant.family.prime_conversation_id.clone(),
            prime_request_id: dormant.family.prime_request_id.clone(),
            started_at: dormant.family.started_at,
            parked_at: dormant.parked_at,
            agents: serialize_agents(&dormant.family),
            extra: Extra::default(),
        })
        .collect();
    let groups: Vec<&[SerializedAgent]> = active
        .iter()
        .map(|run| run.agents.as_slice())
        .chain(dormant.iter().map(|run| run.agents.as_slice()))
        .collect();
    let offers = cleanup_offers(broker, &groups, now);
    Some(SwarmSnapshot {
        version: 7,
        saved_at: now,
        run_id: sole.map(|(run_id, _)| run_id.clone()),
        setup_profile_id: sole.and_then(|(_, family)| family.setup_profile_id.clone()),
        prime_conversation_id: sole.and_then(|(_, family)| family.prime_conversation_id.clone()),
        started_at: sole.map(|(_, family)| family.started_at),
        agents: sole
            .map(|(_, family)| serialize_agents(family))
            .unwrap_or_default(),
        active_runs: Some(active),
        managed_retired_conversations: (!broker.managed_retired.is_empty())
            .then(|| broker.managed_retired.iter().cloned().collect()),
        dormant_runs: Some(dormant),
        managed_worktree_cleanup_offers: (!offers.is_empty()).then_some(offers),
        extra: Extra::default(),
    })
}

pub(crate) fn build_retired(broker: &mut Broker, now: u64) -> RetiredWorkers {
    broker.prune_retired(now);
    RetiredWorkers {
        version: V1,
        saved_at: now,
        workers: broker.retired.values().cloned().collect(),
        extra: Extra::default(),
    }
}

pub(crate) fn restore_retired(broker: &mut Broker, saved: Option<&Value>, now: u64) {
    broker.retired.clear();
    let Some(saved) = saved else { return };
    if saved.get("version").and_then(Value::as_u64) != Some(1) {
        return;
    }
    let Some(workers) = saved.get("workers").and_then(Value::as_array) else {
        return;
    };
    let cutoff = now.saturating_sub(RETIRED_WORKER_TTL_MS);
    for worker in workers {
        let Ok(worker) = serde_json::from_value::<RetiredChat>(worker.clone()) else {
            continue;
        };
        if worker.conversation_id.is_empty() || worker.retired_at < cutoff {
            continue;
        }
        broker
            .retired
            .insert(worker.conversation_id.clone(), worker);
    }
}

fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn valid_request_owner(value: Option<&str>) -> bool {
    value.is_some_and(|id| {
        (1..=100).contains(&id.len())
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    })
}

fn valid_profile(value: Option<&Value>, repaired: &mut bool) -> Option<String> {
    let value = value?;
    match value.as_str() {
        Some(id) if (1..=64).contains(&id.encode_utf16().count()) => Some(id.to_owned()),
        _ => {
            *repaired = true;
            None
        }
    }
}

fn saved_former_run_ids(saved: Option<&Value>, current: &str) -> Vec<String> {
    let Some(ids) = saved.and_then(Value::as_array) else {
        return Vec::new();
    };
    bounded(
        ids.iter()
            .filter_map(Value::as_str)
            .filter(|id| *id != current && is_v4_uuid(id))
            .map(str::to_owned)
            .collect(),
    )
}

/// One saved agent row, repaired the way `deserializeAgents` repairs it.
fn agent_from(
    entry: &Value,
    saved_at: u64,
    repaired: &mut bool,
    warnings: &mut Vec<String>,
) -> Option<Agent> {
    let mut entry = entry.clone();
    let info = entry.get_mut("info")?.as_object_mut()?;
    let allocation = match info.get("workerAllocationRunId") {
        None => None,
        Some(Value::String(id)) if is_allocation_uuid(id) => Some(id.to_ascii_lowercase()),
        Some(_) => {
            *repaired = true;
            None
        }
    };
    match allocation {
        Some(id) => info.insert("workerAllocationRunId".into(), id.into()),
        None => info.remove("workerAllocationRunId"),
    };
    let managed = info.get("managedWorktree") == Some(&Value::Bool(true));
    let cleaned = managed && info.get("managedWorktreeCleaned") == Some(&Value::Bool(true));
    info.insert("managedWorktree".into(), managed.into());
    info.insert("managedWorktreeCleaned".into(), cleaned.into());
    let title = text(info.get("jobTitle"))
        .filter(|title| !title.is_empty())
        .map(|title| crate::text::js_slice(title, 160));
    match title {
        Some(title) => info.insert("jobTitle".into(), title.into()),
        None => info.remove("jobTitle"),
    };
    if !text(info.get("model")).is_some_and(is_model_slug) {
        info.insert("model".into(), Value::Null);
    }
    if text(info.get("reasoningEffort"))
        .and_then(reasoning_effort)
        .is_none()
    {
        info.insert("reasoningEffort".into(), Value::Null);
    }
    if !info.get("sleptAt").is_some_and(Value::is_u64) {
        info.insert("sleptAt".into(), Value::Null);
    }
    if !info.get("contextTokens").is_some_and(Value::is_u64) {
        info.insert("contextTokens".into(), 0.into());
    }
    for key in ["lastRevivalCommandId", "silenceRecoveryTurnId"] {
        if !text(info.get(key)).is_some_and(|value| !value.is_empty()) {
            info.insert(key.into(), Value::Null);
        }
    }
    if !info
        .get("silenceRecoveryRequestOriginMax")
        .is_some_and(Value::is_number)
    {
        info.insert("silenceRecoveryRequestOriginMax".into(), Value::Null);
    }
    let parked = info.get("silenceParked") == Some(&Value::Bool(true));
    info.insert("silenceParked".into(), parked.into());
    let mut info: AgentInfo = serde_json::from_value(Value::Object(info.clone())).ok()?;
    let queue: Vec<AgentMessage> = entry
        .get("queue")
        .and_then(Value::as_array)
        .map(|queue| {
            queue
                .iter()
                .filter_map(|message| serde_json::from_value::<AgentMessage>(message.clone()).ok())
                .map(|mut message| {
                    if !message.offered_via_revival {
                        message.offered_at = None;
                    }
                    message
                })
                .collect()
        })
        .unwrap_or_default();
    if info.role == AgentRole::Worker {
        if info.state == AgentState::Invited && info.conversation_id.is_some() {
            info.state = AgentState::Active;
            info.activated_at = info.activated_at.or(Some(saved_at));
            info.revivable = false;
            *repaired = true;
            warnings.push(format!(
                "multi-agent: repaired restored {} from bound/invited to active",
                info.id
            ));
        }
        if info.state == AgentState::Finished && info.revivable {
            info.revivable = false;
            *repaired = true;
        }
        if info.state == AgentState::Waking && info.conversation_id.is_none() {
            info.state = AgentState::Sleeping;
            info.slept_at = info.slept_at.or(Some(saved_at));
            info.revivable = false;
            *repaired = true;
            warnings.push(format!(
                "multi-agent: restored {} out of waking; it has no chat to be woken in",
                info.id
            ));
        }
        if info.state == AgentState::Sleeping
            && ((!info.revivable && info.silence_parked != Some(true))
                || info.conversation_id.is_none())
        {
            info.state = AgentState::Finished;
            info.finished_at = info.finished_at.or(info.slept_at).or(Some(saved_at));
            info.revivable = false;
            *repaired = true;
        }
    }
    let mut agent = Agent { info, queue };
    let live: Vec<&AgentMessage> = agent
        .queue
        .iter()
        .filter(|message| message.acked_at.is_none())
        .collect();
    let (pending, awaiting) = (
        live.len() as u64,
        live.iter()
            .filter(|message| message.offered_at.is_some())
            .count() as u64,
    );
    agent.info.pending = pending;
    agent.info.awaiting_ack = awaiting;
    Some(agent)
}

fn agents_from(
    entries: &Value,
    saved_at: u64,
    broker: &mut Broker,
    repaired: &mut bool,
) -> IndexMap<String, Agent> {
    let mut agents = IndexMap::new();
    let mut warnings = Vec::new();
    for entry in entries.as_array().map(Vec::as_slice).unwrap_or_default() {
        let id = entry
            .get("info")
            .and_then(|info| info.get("id"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        let Some(id) = id.filter(|id| !agents.contains_key(*id)) else {
            *repaired = true;
            continue;
        };
        let Some(agent) = agent_from(entry, saved_at, repaired, &mut warnings) else {
            *repaired = true;
            continue;
        };
        if agent.info.role == AgentRole::Worker && agent.info.managed_worktree == Some(true) {
            broker.managed_history_possible = true;
        }
        agents.insert(id.to_owned(), agent);
    }
    for warning in warnings {
        broker.log.push((crate::broker::Level::Warn, warning));
    }
    agents
}

/// Conversation ownership seen so far in one restore, so two families never share a chat.
#[derive(Default)]
struct Occupied {
    workers: Vec<String>,
    primes: Vec<String>,
    ordinary_primes: Vec<String>,
    requests: Vec<String>,
}

impl Occupied {
    fn accept(
        &mut self,
        version: u64,
        prime_conversation: Option<&str>,
        agents: &IndexMap<String, Agent>,
        prime_request: Option<&str>,
    ) -> bool {
        let Some(prime) = agents.get(PRIME_ID) else {
            return false;
        };
        if prime.info.role != AgentRole::Prime
            || prime.info.conversation_id.as_deref() != prime_conversation
        {
            return false;
        }
        if prime_conversation.is_none() && !valid_request_owner(prime_request) {
            return false;
        }
        if let Some(request) = prime_request
            && (!valid_request_owner(Some(request))
                || self.requests.iter().any(|known| known == request))
        {
            return false;
        }
        if let Some(prime) = prime_conversation
            && (self.workers.iter().any(|known| known == prime)
                || (version < 7 && self.primes.iter().any(|known| known == prime))
                || (prime_request.is_none()
                    && self.ordinary_primes.iter().any(|known| known == prime)))
        {
            return false;
        }
        let mut local: Vec<String> = Vec::new();
        for agent in agents.values() {
            let Some(conversation) = agent.info.conversation_id.as_deref() else {
                continue;
            };
            if agent.info.id == PRIME_ID {
                continue;
            }
            if Some(conversation) == prime_conversation
                || local.iter().any(|known| known == conversation)
                || self.workers.iter().any(|known| known == conversation)
                || self.primes.iter().any(|known| known == conversation)
            {
                return false;
            }
            local.push(conversation.to_owned());
        }
        self.workers.extend(local);
        if let Some(prime) = prime_conversation {
            self.primes.push(prime.to_owned());
            if prime_request.is_none() {
                self.ordinary_primes.push(prime.to_owned());
            }
        }
        if let Some(request) = prime_request {
            self.requests.push(request.to_owned());
        }
        true
    }
}

/// `restoreSwarm`. Returns whether the restored state differs from the file, so the owner
/// writes the repaired projection back.
pub(crate) fn restore(broker: &mut Broker, saved: Option<&Value>, now: u64) -> bool {
    broker.runs.clear();
    broker.dormant.clear();
    broker.managed_retired.clear();
    broker.managed_history_possible = false;
    broker.cleanup_history.clear();
    let Some(saved) = saved.filter(|saved| saved.get("agents").is_some_and(Value::is_array)) else {
        return false;
    };
    let version = saved.get("version").and_then(Value::as_u64).unwrap_or(0);
    if !(4..=7).contains(&version) {
        broker.log.push((
            crate::broker::Level::Info,
            "multi-agent: discarded a run saved by an older build \u{2014} spawn again to start a new one.".to_owned(),
        ));
        return false;
    }
    let saved_at = saved.get("savedAt").and_then(Value::as_u64).unwrap_or(now);
    let saved_at = if saved_at == 0 { now } else { saved_at };
    if let Some(offers) = saved
        .get("managedWorktreeCleanupOffers")
        .and_then(Value::as_array)
    {
        let mut seen: Vec<String> = Vec::new();
        let mut ambiguous: Vec<String> = Vec::new();
        for offer in offers {
            let Ok(offer) = serde_json::from_value::<ManagedWorktreeCleanupOffer>(offer.clone())
            else {
                continue;
            };
            let agent_ok = cleanup_identity(&AgentInfo {
                worker_allocation_run_id: Some(offer.run_id.clone()),
                managed_worktree: Some(true),
                ..placeholder_info(&offer.agent_id)
            })
            .is_some();
            if !agent_ok || offer.created_at == 0 {
                continue;
            }
            let label = offer.label.filter(|label| {
                label.encode_utf16().count() <= 160 && !crate::text::js_trim(label).is_empty()
            });
            let normalized = ManagedWorktreeCleanupOffer {
                run_id: offer.run_id.to_ascii_lowercase(),
                agent_id: offer.agent_id,
                reason: offer.reason,
                created_at: offer.created_at,
                label,
                extra: Extra::default(),
            };
            let key = format!("{}:{}", normalized.run_id, normalized.agent_id);
            if seen.contains(&key) {
                broker.cleanup_history.shift_remove(&key);
                ambiguous.push(key);
                continue;
            }
            seen.push(key.clone());
            if ambiguous.contains(&key) {
                continue;
            }
            broker.cleanup_history.insert(key, normalized);
        }
    }
    if let Some(conversations) = saved
        .get("managedRetiredConversations")
        .and_then(Value::as_array)
    {
        for conversation in conversations.iter().filter_map(Value::as_str) {
            if (1..=512).contains(&conversation.encode_utf16().count()) {
                broker.managed_retired.insert(conversation.to_owned());
            }
        }
    }
    let mut repaired = false;
    let mut occupied = Occupied::default();

    if version >= 5
        && let Some(dormant_runs) = saved.get("dormantRuns").and_then(Value::as_array)
    {
        for run in dormant_runs {
            let prime = text(run.get("primeConversationId")).filter(|id| !id.is_empty());
            let request = text(run.get("primeRequestId"));
            let request_owned = version == 7
                && run.get("primeConversationId") == Some(&Value::Null)
                && valid_request_owner(request);
            if (prime.is_none() && !request_owned)
                || !run.get("agents").is_some_and(Value::is_array)
            {
                repaired = true;
                continue;
            }
            let agents = agents_from(&run["agents"], saved_at, broker, &mut repaired);
            if agents.values().any(|agent| {
                agent.info.role == AgentRole::Worker && occupies_slot(agent.info.state)
            }) {
                repaired = true;
                broker.log.push((
                    crate::broker::Level::Warn,
                    format!(
                        "multi-agent: discarded invalid dormant history for {} with a live worker",
                        prime.unwrap_or("null")
                    ),
                ));
                continue;
            }
            let previous = agents
                .get(PRIME_ID)
                .and_then(|prime| prime.info.run_id.clone());
            let key = previous
                .clone()
                .filter(|id| is_v4_uuid(id))
                .unwrap_or_else(random_uuid);
            let setup = valid_profile(run.get("setupProfileId"), &mut repaired);
            let request = if version == 7 { request } else { None };
            if broker.dormant.contains_key(&key)
                || !occupied.accept(version, prime, &agents, request)
            {
                repaired = true;
                broker.log.push((
                    crate::broker::Level::Warn,
                    format!(
                        "multi-agent: discarded conflicting dormant history for {}",
                        prime.unwrap_or("null")
                    ),
                ));
                continue;
            }
            if previous.as_deref() != Some(key.as_str()) {
                repaired = true;
            }
            let mut agents = agents;
            for agent in agents.values_mut() {
                agent.info.run_id = Some(key.clone());
                agent.info.prime_conversation_id = prime.map(str::to_owned);
            }
            broker.dormant.insert(
                key.clone(),
                Dormant {
                    family: Family {
                        former_run_ids: saved_former_run_ids(run.get("formerRunIds"), &key),
                        setup_profile_id: setup,
                        prime_conversation_id: prime.map(str::to_owned),
                        prime_request_id: request.map(str::to_owned),
                        started_at: run
                            .get("startedAt")
                            .and_then(Value::as_u64)
                            .unwrap_or(saved_at),
                        agents,
                    },
                    parked_at: run
                        .get("parkedAt")
                        .and_then(Value::as_u64)
                        .unwrap_or(saved_at),
                },
            );
        }
        if broker.prune_dormant(now) {
            repaired = true;
        }
    }

    let saved_runs: Vec<&Value> = if version >= 6 {
        saved
            .get("activeRuns")
            .and_then(Value::as_array)
            .map(|runs| runs.iter().collect())
            .unwrap_or_default()
    } else {
        vec![saved]
    };
    for run in saved_runs {
        let prime = text(run.get("primeConversationId")).filter(|id| !id.is_empty());
        let request = text(run.get("primeRequestId"));
        let request_owned = version == 7
            && run.get("primeConversationId") == Some(&Value::Null)
            && valid_request_owner(request);
        let run_id = text(run.get("runId")).filter(|id| !id.is_empty());
        let active = (prime.is_some() || request_owned)
            && run_id.is_some()
            && run.get("agents").is_some_and(Value::is_array);
        if version == 4 && !active {
            broker.log.push((
                crate::broker::Level::Info,
                "multi-agent: discarded a version-4 run with no usable prime binding".to_owned(),
            ));
            return false;
        }
        let Some(run_id) = run_id.filter(|_| active) else {
            continue;
        };
        let request = (version == 7 && valid_request_owner(request))
            .then_some(request)
            .flatten();
        let agents = agents_from(&run["agents"], saved_at, broker, &mut repaired);
        if broker.runs.contains_key(run_id)
            || broker.dormant.contains_key(run_id)
            || !occupied.accept(version, prime, &agents, request)
        {
            broker.log.push((
                crate::broker::Level::Warn,
                format!(
                    "multi-agent: discarded active run for {} because its conversation ownership conflicted",
                    prime.unwrap_or("null")
                ),
            ));
            repaired = true;
            continue;
        }
        let setup = valid_profile(run.get("setupProfileId"), &mut repaired);
        let restored_id = if is_v4_uuid(run_id) {
            run_id.to_owned()
        } else {
            repaired = true;
            broker.log.push((
                crate::broker::Level::Warn,
                "multi-agent: re-keyed a restored run whose legacy incarnation id was not a full UUID".to_owned(),
            ));
            random_uuid()
        };
        if broker.runs.contains_key(&restored_id) {
            repaired = true;
            continue;
        }
        let mut agents = agents;
        for agent in agents.values_mut() {
            agent.info.run_id = Some(restored_id.clone());
            agent.info.prime_conversation_id = prime.map(str::to_owned);
        }
        broker.runs.insert(
            restored_id.clone(),
            Family {
                former_run_ids: saved_former_run_ids(run.get("formerRunIds"), &restored_id),
                setup_profile_id: setup,
                prime_conversation_id: prime.map(str::to_owned),
                prime_request_id: request.map(str::to_owned),
                started_at: run
                    .get("startedAt")
                    .and_then(Value::as_u64)
                    .unwrap_or(saved_at),
                agents,
            },
        );
    }
    broker.liveness_floor = now;
    for run_id in broker.runs.keys().cloned().collect::<Vec<_>>() {
        if broker.release_quiescent_run(
            Some(&run_id),
            "restart recovered an active incarnation with no slot-holding workers",
            now,
        ) {
            repaired = true;
        }
    }
    repaired
}

fn placeholder_info(id: &str) -> AgentInfo {
    AgentInfo {
        run_id: None,
        worker_allocation_run_id: None,
        managed_worktree: None,
        managed_worktree_cleaned: None,
        prime_conversation_id: None,
        id: id.to_owned(),
        role: AgentRole::Worker,
        label: String::new(),
        task: String::new(),
        job_title: None,
        reasoning_effort: None,
        model: None,
        state: AgentState::Finished,
        created_at: 0,
        activated_at: None,
        finished_at: None,
        result: None,
        pending: 0,
        awaiting_ack: 0,
        delivered: 0,
        conversation_id: None,
        detached_at: None,
        last_seen_at: None,
        revivable: false,
        silence_parked: None,
        silence_recovery_turn_id: None,
        silence_recovery_request_origin_max: None,
        last_revival_command_id: None,
        slept_at: None,
        context_tokens: 0,
        extra: Extra::default(),
    }
}
