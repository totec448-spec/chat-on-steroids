//! The Settings form's save: `{ base, patch }` snapshots and a field-wise three-way merge.
//!
//! Port of `settingsSave` and `mergeSettings` in `src/main/ipc.ts`. A second writer (the
//! browser extension) can change Goal or Auto Compact while the form is open. A field equal in
//! `base` and `patch` was not edited by this save and keeps the live value; a field that differs
//! was edited here and wins.

use std::sync::LazyLock;

use cos_types::config::{
    AppearanceFont, AppearancePalette, AppearanceSettings, BackgroundPlacement, BrowserBridgePort,
    Capabilities, ChatBrowser, CommandAllowlistSettings, CommandPolicyMode, CompactionSettings,
    Config, ControlApiSettings, DefaultReasoning, FinishAction, GoalBackend, GoalMode,
    GoalProviderKind, GoalProviderSettings, GoalReasoning, GoalSettings, HandoffLength,
    LoopBackend, McpSettings, MultiAgentSettings, PlanBackend, SessionSettings, Theme, TunnelKind,
    TunnelSettings, UiLanguage, UiPrefs,
};
use cos_types::session::ReasoningEffort;
use regex::Regex;
use serde_json::{Map, Value};

use super::ConfigError;
use super::schema::{
    MAX_COMMAND_RULES, MAX_MCP_INSTRUCTIONS_CHARS, MAX_PROMPT_CHARS, connector_suffix_allowed,
    default_handoff_length, parse_appearance, parse_bridge_port, parse_browser_preferences,
    parse_command_rule,
};
use crate::check::{Check, Invalid, Obj, array, boolean, int, text, trimmed, word};
use crate::js;

pub(crate) struct SettingsSave {
    base: Snapshot,
    patch: Snapshot,
}

/// One form snapshot (`settingsPatch`): the fields the form owns, validated.
struct Snapshot {
    connector_suffix: Option<String>,
    capabilities: Capabilities,
    read_only: bool,
    command_allowlist: CommandAllowlistSettings,
    tunnel: TunnelSnapshot,
    ui: UiSnapshot,
    sessions: SessionSettings,
    compaction: CompactionSettings,
    multi_agent: MultiAgentSettings,
    mcp: Option<String>,
    control_api: Option<(bool, Option<bool>)>,
    goal: GoalSettings,
}

struct TunnelSnapshot {
    profile_id: Option<String>,
    profile_epoch: Option<u64>,
    plugins_tunnel_id: Option<String>,
    kind: TunnelKind,
    tunnel_id: String,
    desktop_tunnel_id: String,
    binary_path: String,
}

struct UiSnapshot {
    appearance: Option<AppearanceSettings>,
    auto_continue: Option<bool>,
    default_chat_model: Option<String>,
    default_chat_reasoning: Option<ReasoningEffort>,
    chat_browser: Option<ChatBrowser>,
    developer_mode: Option<bool>,
    playful_status: Option<bool>,
    follow_output: Option<bool>,
    mention_core: Option<bool>,
    finish_tool: Option<bool>,
    plan_backend: Option<PlanBackend>,
    finish_action: Option<FinishAction>,
    finish_lead_minutes: Option<u8>,
    background_chats: Option<bool>,
    background_placement: Option<BackgroundPlacement>,
    browser_bridge_port: Option<BrowserBridgePort>,
    browser_only: Option<bool>,
    auto_refresh_plugins: Option<bool>,
    auto_select_skills: Option<bool>,
    tabs_to_keep_open: Option<u8>,
    minimize_to_tray: bool,
    auto_connect: bool,
    start_at_login: Option<bool>,
    privacy_screenshots: bool,
    theme: Theme,
}

fn tunnel_id(value: &Value, path: &str) -> Check<String> {
    let id = text(value, path, 0, 128)?;
    let valid = id.is_empty()
        || id.strip_prefix("tunnel_").is_some_and(|hex| {
            hex.len() == 32
                && hex
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        });
    if valid {
        Ok(id)
    } else {
        Err(Invalid(path.to_owned()))
    }
}

static OPENROUTER_MODEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^~?[a-z0-9._-]+/[a-z0-9._-]+(:[a-z0-9._-]+)?$").expect("model id pattern")
});

impl SettingsSave {
    pub(crate) fn parse(request: &Value) -> Check<Self> {
        let o = Obj::new(request, "")?;
        o.strict(&["base", "patch"])?;
        Ok(Self {
            base: o.req("base", Snapshot::parse)?,
            patch: o.req("patch", Snapshot::parse)?,
        })
    }

    pub(crate) fn merge_into(&self, current: &Config) -> Result<Config, ConfigError> {
        merge(current, &self.base, &self.patch)
    }

    /// The form edited the bridge port.
    pub(crate) fn edits_bridge_port(&self) -> bool {
        let base = self.base.ui.browser_bridge_port;
        self.patch
            .ui
            .browser_bridge_port
            .is_some_and(|port| port != base.unwrap_or(BrowserBridgePort::Auto))
    }
}

impl Snapshot {
    fn parse(value: &Value, path: &str) -> Check<Self> {
        let o = Obj::new(value, path)?;
        Ok(Self {
            connector_suffix: o.opt("connectorSuffix", |value, path| {
                let raw = text(value, path, 0, 64)?;
                let collapsed = js::trim(&raw)
                    .split(js::is_space)
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ");
                if connector_suffix_allowed(&collapsed) {
                    Ok(collapsed)
                } else {
                    Err(Invalid(path.to_owned()))
                }
            })?,
            capabilities: o.req("capabilities", |value, path| {
                let c = Obj::new(value, path)?;
                Ok(Capabilities {
                    browse: c.req("browse", boolean)?,
                    search: c.req("search", boolean)?,
                    read: c.req("read", boolean)?,
                    metadata: c.req("metadata", boolean)?,
                    create: c.req("create", boolean)?,
                    edit: c.req("edit", boolean)?,
                    move_: c.req("move", boolean)?,
                    delete_file: c.req("deleteFile", boolean)?,
                    command: c.req("command", boolean)?,
                    screen: c.req("screen", boolean)?,
                    control: c.req("control", boolean)?,
                    clipboard_read: c.req("clipboardRead", boolean)?,
                    clipboard_write: c.req("clipboardWrite", boolean)?,
                    extra: Map::new(),
                })
            })?,
            read_only: o.req("readOnly", boolean)?,
            command_allowlist: o.req("commandAllowlist", |value, path| {
                let c = Obj::new(value, path)?;
                Ok(CommandAllowlistSettings {
                    enabled: c.req("enabled", boolean)?,
                    mode: c.opt("mode", word)?.unwrap_or(CommandPolicyMode::Allow),
                    rules: c.req("rules", |v, p| {
                        array(v, p, MAX_COMMAND_RULES, parse_command_rule)
                    })?,
                    extra: Map::new(),
                })
            })?,
            tunnel: o.req("tunnel", |value, path| {
                let t = Obj::new(value, path)?;
                Ok(TunnelSnapshot {
                    profile_id: t.opt("profileId", |v, p| text(v, p, 0, 64))?,
                    profile_epoch: t
                        .opt("profileEpoch", |v, p| int(v, p, 0, i64::MAX))?
                        .map(|n| n as u64),
                    plugins_tunnel_id: t.opt("pluginsTunnelId", tunnel_id)?,
                    kind: t.req("kind", word)?,
                    tunnel_id: t.req("tunnelId", tunnel_id)?,
                    desktop_tunnel_id: t.req("desktopTunnelId", tunnel_id)?,
                    binary_path: t.req("binaryPath", |v, p| text(v, p, 0, 4096))?,
                })
            })?,
            ui: o.req("ui", UiSnapshot::parse)?,
            sessions: o.req("sessions", |value, path| {
                let s = Obj::new(value, path)?;
                let tokens = |key: &str| {
                    s.req(key, |v, p| int(v, p, 10_000, 4_000_000))
                        .map(|n| n as u64)
                };
                Ok(SessionSettings {
                    record: s.req("record", boolean)?,
                    retain_days: s.req("retainDays", |v, p| int(v, p, 0, 3650))? as u32,
                    advisory_tokens: tokens("advisoryTokens")?,
                    limit_tokens: tokens("limitTokens")?,
                    extra: Map::new(),
                })
            })?,
            compaction: o.req("compaction", |value, path| {
                let c = Obj::new(value, path)?;
                Ok(CompactionSettings {
                    auto: c.req("auto", boolean)?,
                    auto_tokens: c.req("autoTokens", |v, p| int(v, p, 10_000, 4_000_000))? as u64,
                    handoff_prompt: c
                        .req("handoffPrompt", |v, p| trimmed(v, p, 1, MAX_PROMPT_CHARS))?,
                    handoff_length: c.opt("handoffLength", word::<HandoffLength>)?,
                    extra: Map::new(),
                })
            })?,
            multi_agent: o.req("multiAgent", |value, path| {
                let m = Obj::new(value, path)?;
                Ok(MultiAgentSettings {
                    enabled: m.req("enabled", boolean)?,
                    default_model: m.opt("defaultModel", |v, p| text(v, p, 0, 80))?,
                    default_reasoning: m.opt("defaultReasoning", word::<DefaultReasoning>)?,
                    max_workers: m.req("maxWorkers", |v, p| int(v, p, 1, 8))? as u8,
                    global_max_workers: m
                        .opt("globalMaxWorkers", |v, p| int(v, p, 0, 64))?
                        .map(|n| n as u8),
                    allow_unattributed_calls: m.req("allowUnattributedCalls", boolean)?,
                    strict_chat_allowlist: m.opt("strictChatAllowlist", boolean)?,
                    recover_agent_tabs: m.req("recoverAgentTabs", boolean)?,
                    wait_for_sub_agents: m.opt("waitForSubAgents", boolean)?,
                    auto_worktrees: m.opt("autoWorktrees", boolean)?,
                    end_sleeping_worker_processes: m.opt("endSleepingWorkerProcesses", boolean)?,
                    extra: Map::new(),
                })
            })?,
            mcp: o.opt("mcp", |value, path| {
                let m = Obj::new(value, path)?;
                m.strict(&["instructions"])?;
                m.req("instructions", |v, p| {
                    trimmed(v, p, 0, MAX_MCP_INSTRUCTIONS_CHARS)
                })
            })?,
            control_api: o.opt("controlApi", |value, path| {
                let c = Obj::new(value, path)?;
                c.strict(&["enabled", "allowActions"])?;
                Ok((c.req("enabled", boolean)?, c.opt("allowActions", boolean)?))
            })?,
            goal: o.req("goal", parse_goal_snapshot)?,
        })
    }
}

impl UiSnapshot {
    fn parse(value: &Value, path: &str) -> Check<Self> {
        let u = Obj::new(value, path)?;
        let flag = |key: &str| u.opt(key, boolean);
        // Validated and then not merged: the window and the extension own these.
        u.opt("language", word::<UiLanguage>)?;
        u.opt("browserPreferences", parse_browser_preferences)?;
        u.opt("cosBrowserTrayHint", boolean)?;
        Ok(Self {
            appearance: u.opt("appearance", parse_appearance)?,
            auto_continue: flag("autoContinue")?,
            default_chat_model: u.opt("defaultChatModel", |v, p| trimmed(v, p, 1, 80))?,
            default_chat_reasoning: u.opt("defaultChatReasoning", word)?,
            chat_browser: u.opt("chatBrowser", word)?,
            developer_mode: flag("developerMode")?,
            playful_status: flag("playfulStatus")?,
            follow_output: flag("followOutput")?,
            mention_core: flag("mentionCore")?,
            finish_tool: flag("finishTool")?,
            plan_backend: u.opt("planBackend", word)?,
            finish_action: u.opt("finishAction", word)?,
            finish_lead_minutes: u
                .opt("finishLeadMinutes", |v, p| int(v, p, 3, 5))?
                .map(|n| n as u8),
            background_chats: flag("backgroundChats")?,
            background_placement: u.opt("backgroundPlacement", word)?,
            browser_bridge_port: u.opt("browserBridgePort", parse_bridge_port)?,
            browser_only: flag("browserOnly")?,
            auto_refresh_plugins: flag("autoRefreshPlugins")?,
            auto_select_skills: flag("autoSelectSkills")?,
            tabs_to_keep_open: u
                .opt("tabsToKeepOpen", |v, p| int(v, p, 1, 50))?
                .map(|n| n as u8),
            minimize_to_tray: u.req("minimizeToTray", boolean)?,
            auto_connect: u.req("autoConnect", boolean)?,
            start_at_login: flag("startAtLogin")?,
            privacy_screenshots: u.req("privacyScreenshots", boolean)?,
            theme: u.req("theme", word)?,
        })
    }
}

fn parse_goal_snapshot(value: &Value, path: &str) -> Check<GoalSettings> {
    let g = Obj::new(value, path)?;
    let prompt = |key: &str| g.req(key, |v, p| trimmed(v, p, 1, MAX_PROMPT_CHARS));
    let provider = g.req("provider", |value, path| {
        let p = Obj::new(value, path)?;
        Ok(GoalProviderSettings {
            kind: p.req("kind", word::<GoalProviderKind>)?,
            base_url: p.req("baseUrl", |v, p| text(v, p, 0, 2048))?,
            extra: Map::new(),
        })
    })?;
    let model = g.req("model", |v, p| text(v, p, 1, 160))?;
    if provider.kind != GoalProviderKind::Custom && !OPENROUTER_MODEL.is_match(&model) {
        return Err(Invalid(g.path("model")));
    }
    Ok(GoalSettings {
        impulse_minutes: g
            .opt("impulseMinutes", |v, p| int(v, p, 0, 60))?
            .map(|n| n as u8),
        include_tool_calls: g.opt("includeToolCalls", boolean)?,
        enabled: g.req("enabled", boolean)?,
        backend: g.opt("backend", word::<GoalBackend>)?,
        loop_backend: g.opt("loopBackend", word::<LoopBackend>)?,
        helper_model: g.opt("helperModel", |v, p| trimmed(v, p, 1, 80))?,
        helper_reasoning: g.opt("helperReasoning", word)?,
        mode: g.req("mode", word::<GoalMode>)?,
        provider,
        model,
        reasoning: g.req("reasoning", word::<GoalReasoning>)?,
        prompt: prompt("prompt")?,
        objective_prompt: prompt("objectivePrompt")?,
        loop_prompt: prompt("loopPrompt")?,
        extra: Map::new(),
    })
}

/// `Object.is(before, next) ? live : next`.
fn pick<T: PartialEq + Clone>(live: &T, before: &T, next: &T) -> T {
    if before == next {
        live.clone()
    } else {
        next.clone()
    }
}

fn default_appearance() -> AppearanceSettings {
    let palette = |background: &str, sidebar: &str, accent: &str, contrast: u8| AppearancePalette {
        background: background.into(),
        sidebar: sidebar.into(),
        accent: accent.into(),
        contrast,
        extra: Map::new(),
    };
    AppearanceSettings {
        light: palette("#f4f4f5", "#e9edf2", "#486f9d", 45),
        dark: palette("#181818", "#1a2129", "#b0cbed", 60),
        font: AppearanceFont::System,
        font_size: 14,
        translucent_sidebar: true,
        extra: Map::new(),
    }
}

/// `mergeAppearance`: field by field, so one window's colors survive another's save.
fn merge_appearance(
    live: Option<&AppearanceSettings>,
    base: Option<&AppearanceSettings>,
    wanted: Option<&AppearanceSettings>,
) -> Option<AppearanceSettings> {
    let Some(wanted) = wanted else {
        return live.cloned();
    };
    let (current, before) = (
        live.cloned().unwrap_or_else(default_appearance),
        base.cloned().unwrap_or_else(default_appearance),
    );
    let palette =
        |c: &AppearancePalette, b: &AppearancePalette, w: &AppearancePalette| AppearancePalette {
            background: pick(&c.background, &b.background, &w.background),
            sidebar: pick(&c.sidebar, &b.sidebar, &w.sidebar),
            accent: pick(&c.accent, &b.accent, &w.accent),
            contrast: pick(&c.contrast, &b.contrast, &w.contrast),
            extra: Map::new(),
        };
    Some(AppearanceSettings {
        light: palette(&current.light, &before.light, &wanted.light),
        dark: palette(&current.dark, &before.dark, &wanted.dark),
        font: pick(&current.font, &before.font, &wanted.font),
        font_size: pick(&current.font_size, &before.font_size, &wanted.font_size),
        translucent_sidebar: pick(
            &current.translucent_sidebar,
            &before.translucent_sidebar,
            &wanted.translucent_sidebar,
        ),
        extra: Map::new(),
    })
}

fn merge(current: &Config, base: &Snapshot, wanted: &Snapshot) -> Result<Config, ConfigError> {
    let (bt, wt, ct) = (&base.tunnel, &wanted.tunnel, &current.tunnel);
    let tunnel_edited = bt.tunnel_id != wt.tunnel_id
        || bt.desktop_tunnel_id != wt.desktop_tunnel_id
        || bt.plugins_tunnel_id.as_deref().unwrap_or("")
            != wt.plugins_tunnel_id.as_deref().unwrap_or("");
    let profile_moved = bt.profile_id.as_deref().unwrap_or("default")
        != ct.profile_id.as_deref().unwrap_or("default")
        || bt.profile_epoch.unwrap_or(0) != ct.profile_epoch.unwrap_or(0);
    if tunnel_edited && profile_moved {
        return Err(ConfigError::ProfileChanged);
    }

    let (cc, bc, wc) = (
        &current.capabilities,
        &base.capabilities,
        &wanted.capabilities,
    );
    let capabilities = Capabilities {
        browse: pick(&cc.browse, &bc.browse, &wc.browse),
        search: pick(&cc.search, &bc.search, &wc.search),
        read: pick(&cc.read, &bc.read, &wc.read),
        metadata: pick(&cc.metadata, &bc.metadata, &wc.metadata),
        create: pick(&cc.create, &bc.create, &wc.create),
        edit: pick(&cc.edit, &bc.edit, &wc.edit),
        move_: pick(&cc.move_, &bc.move_, &wc.move_),
        delete_file: pick(&cc.delete_file, &bc.delete_file, &wc.delete_file),
        command: pick(&cc.command, &bc.command, &wc.command),
        screen: pick(&cc.screen, &bc.screen, &wc.screen),
        control: pick(&cc.control, &bc.control, &wc.control),
        clipboard_read: pick(&cc.clipboard_read, &bc.clipboard_read, &wc.clipboard_read),
        clipboard_write: pick(
            &cc.clipboard_write,
            &bc.clipboard_write,
            &wc.clipboard_write,
        ),
        extra: Map::new(),
    };

    // The two switches merge independently, and actions never outlive the API.
    let control_api = match wanted.control_api {
        None => current.control_api.clone(),
        Some((enabled, allow_actions)) => {
            let live = &current.control_api;
            let before = base.control_api.unwrap_or((false, None));
            let enabled = pick(&live.enabled, &before.0, &enabled);
            let allow_actions = match allow_actions {
                None => live.allow_actions,
                Some(wanted) => pick(&live.allow_actions, &before.1.unwrap_or(false), &wanted),
            };
            ControlApiSettings {
                enabled,
                allow_actions: enabled && allow_actions,
                extra: Map::new(),
            }
        }
    };

    let (cl, bl, wl) = (
        &current.command_allowlist,
        &base.command_allowlist,
        &wanted.command_allowlist,
    );
    let (cu, bu, wu) = (&current.ui, &base.ui, &wanted.ui);
    let (cs, bs, ws) = (&current.sessions, &base.sessions, &wanted.sessions);
    let (cp, bp, wp) = (&current.compaction, &base.compaction, &wanted.compaction);
    let (cm, bm, wm) = (&current.multi_agent, &base.multi_agent, &wanted.multi_agent);
    let (cg, bg, wg) = (&current.goal, &base.goal, &wanted.goal);
    let length = default_handoff_length();
    let or_false = |flag: Option<bool>| Some(flag.unwrap_or(false));

    Ok(Config {
        connector_suffix: match &wanted.connector_suffix {
            None => current.connector_suffix.clone(),
            Some(next) => Some(pick(
                &current.connector_suffix.clone().unwrap_or_default(),
                &base.connector_suffix.clone().unwrap_or_default(),
                next,
            )),
        },
        mcp: match &wanted.mcp {
            None => current.mcp.clone(),
            Some(next) => McpSettings {
                instructions: pick(
                    &current.mcp.instructions,
                    &base.mcp.clone().unwrap_or_default(),
                    next,
                ),
                extra: Map::new(),
            },
        },
        control_api,
        capabilities,
        read_only: pick(&current.read_only, &base.read_only, &wanted.read_only),
        command_allowlist: CommandAllowlistSettings {
            enabled: pick(&cl.enabled, &bl.enabled, &wl.enabled),
            mode: pick(&cl.mode, &bl.mode, &wl.mode),
            rules: pick(&cl.rules, &bl.rules, &wl.rules),
            extra: Map::new(),
        },
        tunnel: TunnelSettings {
            plugins_tunnel_id: Some(match &wt.plugins_tunnel_id {
                None => ct.plugins_tunnel_id.clone().unwrap_or_default(),
                Some(next) => pick(
                    &ct.plugins_tunnel_id.clone().unwrap_or_default(),
                    &bt.plugins_tunnel_id.clone().unwrap_or_default(),
                    next,
                ),
            }),
            kind: pick(&ct.kind, &bt.kind, &wt.kind),
            tunnel_id: pick(&ct.tunnel_id, &bt.tunnel_id, &wt.tunnel_id),
            desktop_tunnel_id: pick(
                &ct.desktop_tunnel_id,
                &bt.desktop_tunnel_id,
                &wt.desktop_tunnel_id,
            ),
            binary_path: pick(&ct.binary_path, &bt.binary_path, &wt.binary_path),
            ..ct.clone()
        },
        ui: UiPrefs {
            appearance: merge_appearance(
                cu.appearance.as_ref(),
                bu.appearance.as_ref(),
                wu.appearance.as_ref(),
            ),
            auto_continue: pick(&cu.auto_continue, &bu.auto_continue, &wu.auto_continue),
            default_chat_model: pick(
                &cu.default_chat_model,
                &bu.default_chat_model,
                &wu.default_chat_model,
            ),
            default_chat_reasoning: pick(
                &cu.default_chat_reasoning,
                &bu.default_chat_reasoning,
                &wu.default_chat_reasoning,
            ),
            chat_browser: pick(&cu.chat_browser, &bu.chat_browser, &wu.chat_browser),
            developer_mode: pick(&cu.developer_mode, &bu.developer_mode, &wu.developer_mode),
            playful_status: pick(&cu.playful_status, &bu.playful_status, &wu.playful_status),
            follow_output: pick(&cu.follow_output, &bu.follow_output, &wu.follow_output),
            mention_core: pick(&cu.mention_core, &bu.mention_core, &wu.mention_core),
            // Not part of the form: reported by the window and the extension, carried through.
            language: cu.language,
            // Deliberately kept. The TypeScript save rebuilds `ui` without it, so What's New
            // shows again after every Settings save.
            last_seen_version: cu.last_seen_version.clone(),
            browser_preferences: cu.browser_preferences,
            cos_browser_tray_hint: cu.cos_browser_tray_hint,
            finish_tool: pick(&cu.finish_tool, &bu.finish_tool, &wu.finish_tool),
            plan_backend: pick(&cu.plan_backend, &bu.plan_backend, &wu.plan_backend),
            finish_action: pick(&cu.finish_action, &bu.finish_action, &wu.finish_action),
            finish_lead_minutes: pick(
                &cu.finish_lead_minutes,
                &bu.finish_lead_minutes,
                &wu.finish_lead_minutes,
            ),
            background_chats: pick(
                &cu.background_chats,
                &bu.background_chats,
                &wu.background_chats,
            ),
            background_placement: pick(
                &cu.background_placement,
                &bu.background_placement,
                &wu.background_placement,
            ),
            browser_bridge_port: match wu.browser_bridge_port {
                None => cu.browser_bridge_port,
                Some(next) => Some(pick(
                    &cu.browser_bridge_port.unwrap_or(BrowserBridgePort::Auto),
                    &bu.browser_bridge_port.unwrap_or(BrowserBridgePort::Auto),
                    &next,
                )),
            },
            browser_only: pick(&cu.browser_only, &bu.browser_only, &wu.browser_only),
            auto_refresh_plugins: pick(
                &cu.auto_refresh_plugins,
                &bu.auto_refresh_plugins,
                &wu.auto_refresh_plugins,
            ),
            auto_select_skills: pick(
                &cu.auto_select_skills,
                &bu.auto_select_skills,
                &wu.auto_select_skills,
            ),
            tabs_to_keep_open: pick(
                &cu.tabs_to_keep_open,
                &bu.tabs_to_keep_open,
                &wu.tabs_to_keep_open,
            ),
            minimize_to_tray: pick(
                &cu.minimize_to_tray,
                &bu.minimize_to_tray,
                &wu.minimize_to_tray,
            ),
            auto_connect: pick(&cu.auto_connect, &bu.auto_connect, &wu.auto_connect),
            start_at_login: pick(&cu.start_at_login, &bu.start_at_login, &wu.start_at_login),
            privacy_screenshots: pick(
                &cu.privacy_screenshots,
                &bu.privacy_screenshots,
                &wu.privacy_screenshots,
            ),
            theme: pick(&cu.theme, &bu.theme, &wu.theme),
            extra: Map::new(),
        },
        sessions: SessionSettings {
            record: pick(&cs.record, &bs.record, &ws.record),
            retain_days: pick(&cs.retain_days, &bs.retain_days, &ws.retain_days),
            advisory_tokens: pick(
                &cs.advisory_tokens,
                &bs.advisory_tokens,
                &ws.advisory_tokens,
            ),
            limit_tokens: pick(&cs.limit_tokens, &bs.limit_tokens, &ws.limit_tokens),
            extra: Map::new(),
        },
        compaction: CompactionSettings {
            auto: pick(&cp.auto, &bp.auto, &wp.auto),
            auto_tokens: pick(&cp.auto_tokens, &bp.auto_tokens, &wp.auto_tokens),
            handoff_prompt: pick(&cp.handoff_prompt, &bp.handoff_prompt, &wp.handoff_prompt),
            handoff_length: Some(pick(
                &cp.handoff_length.unwrap_or(length),
                &bp.handoff_length.unwrap_or(length),
                &wp.handoff_length.unwrap_or(length),
            )),
            extra: Map::new(),
        },
        multi_agent: MultiAgentSettings {
            default_model: pick(&cm.default_model, &bm.default_model, &wm.default_model),
            default_reasoning: pick(
                &cm.default_reasoning,
                &bm.default_reasoning,
                &wm.default_reasoning,
            ),
            enabled: pick(&cm.enabled, &bm.enabled, &wm.enabled),
            max_workers: pick(&cm.max_workers, &bm.max_workers, &wm.max_workers),
            global_max_workers: Some(pick(
                &cm.global_max_workers.unwrap_or(0),
                &bm.global_max_workers.unwrap_or(0),
                &wm.global_max_workers.unwrap_or(0),
            )),
            allow_unattributed_calls: pick(
                &cm.allow_unattributed_calls,
                &bm.allow_unattributed_calls,
                &wm.allow_unattributed_calls,
            ),
            strict_chat_allowlist: pick(
                &or_false(cm.strict_chat_allowlist),
                &or_false(bm.strict_chat_allowlist),
                &or_false(wm.strict_chat_allowlist),
            ),
            recover_agent_tabs: pick(
                &cm.recover_agent_tabs,
                &bm.recover_agent_tabs,
                &wm.recover_agent_tabs,
            ),
            wait_for_sub_agents: pick(
                &cm.wait_for_sub_agents,
                &bm.wait_for_sub_agents,
                &wm.wait_for_sub_agents,
            ),
            auto_worktrees: pick(
                &or_false(cm.auto_worktrees),
                &or_false(bm.auto_worktrees),
                &or_false(wm.auto_worktrees),
            ),
            end_sleeping_worker_processes: pick(
                &or_false(cm.end_sleeping_worker_processes),
                &or_false(bm.end_sleeping_worker_processes),
                &or_false(wm.end_sleeping_worker_processes),
            ),
            extra: Map::new(),
        },
        goal: GoalSettings {
            impulse_minutes: pick(
                &cg.impulse_minutes,
                &bg.impulse_minutes,
                &wg.impulse_minutes,
            ),
            include_tool_calls: pick(
                &cg.include_tool_calls,
                &bg.include_tool_calls,
                &wg.include_tool_calls,
            ),
            backend: pick(&cg.backend, &bg.backend, &wg.backend),
            loop_backend: pick(&cg.loop_backend, &bg.loop_backend, &wg.loop_backend),
            helper_model: pick(&cg.helper_model, &bg.helper_model, &wg.helper_model),
            helper_reasoning: pick(
                &cg.helper_reasoning,
                &bg.helper_reasoning,
                &wg.helper_reasoning,
            ),
            enabled: pick(&cg.enabled, &bg.enabled, &wg.enabled),
            mode: pick(&cg.mode, &bg.mode, &wg.mode),
            provider: GoalProviderSettings {
                kind: pick(&cg.provider.kind, &bg.provider.kind, &wg.provider.kind),
                base_url: pick(
                    &cg.provider.base_url,
                    &bg.provider.base_url,
                    &wg.provider.base_url,
                ),
                extra: Map::new(),
            },
            model: pick(&cg.model, &bg.model, &wg.model),
            reasoning: pick(&cg.reasoning, &bg.reasoning, &wg.reasoning),
            prompt: pick(&cg.prompt, &bg.prompt, &wg.prompt),
            objective_prompt: pick(
                &cg.objective_prompt,
                &bg.objective_prompt,
                &wg.objective_prompt,
            ),
            loop_prompt: pick(&cg.loop_prompt, &bg.loop_prompt, &wg.loop_prompt),
            extra: Map::new(),
        },
        ..current.clone()
    })
}
