//! `configSchema` from `src/main/config.ts`: untrusted JSON in, a typed [`Config`] out.
//!
//! Each field keeps its TypeScript policy. Some repair to a default (`.catch`), most fail the
//! whole file, and a failed file loads as the conservative recovery config. Unknown keys are
//! dropped, as zod drops them.

use std::collections::HashSet;
use std::sync::LazyLock;

use cos_types::config::{
    AppearancePalette, AppearanceSettings, BrowserBridgePort, BrowserPreferences, Capabilities,
    CommandAllowlistSettings, CommandPolicyMode, CompactionSettings, Config, ControlApiSettings,
    GoalProviderSettings, GoalSettings, McpSettings, MultiAgentSettings, Root, SessionSettings,
    SetupProfile, TunnelSettings, UiPrefs,
};
use regex::Regex;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::check::{
    Check, Invalid, Obj, array, boolean, default_catch, int, string, text, trimmed, word,
};
use crate::js;

pub(crate) const MAX_COMMAND_RULES: usize = 100;
pub(crate) const MAX_COMMAND_RULE_CHARS: usize = 1000;
pub(crate) const MAX_PROMPT_CHARS: usize = 20_000;
pub(crate) const MAX_MCP_INSTRUCTIONS_CHARS: usize = 4000;
pub(crate) const CONNECTOR_SUFFIX_MAX: usize = 32;
const MAX_TOKENS: i64 = 4_000_000;
const MIN_TOKENS: i64 = 10_000;
const RESERVED_ROOT_NAMES: [&str; 1] = ["skills"];

/// The host whose first-launch defaults apply.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Macos,
    Linux,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Linux
        }
    }
}

/// Defaults and superseded values exported from the TypeScript app (`oracle/config.oracle.ts`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Shipped {
    first_launch: FirstLaunch,
    recovery: Config,
    superseded: Superseded,
}

#[derive(Deserialize)]
struct FirstLaunch {
    windows: Config,
    macos: Config,
    linux: Config,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Superseded {
    goal_prompt: Vec<String>,
    objective_prompt: Vec<String>,
    loop_prompt: Vec<String>,
    helper_model: Vec<String>,
}

static SHIPPED: LazyLock<Shipped> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../shipped.json"))
        .expect("shipped.json is generated from the app")
});

/// `defaultConfig(platform)`: what a first launch starts with.
pub fn first_launch_config(platform: Platform) -> Config {
    let defaults = &SHIPPED.first_launch;
    match platform {
        Platform::Windows => defaults.windows.clone(),
        Platform::Macos => defaults.macos.clone(),
        Platform::Linux => defaults.linux.clone(),
    }
}

/// `conservativeRecoveryConfig()`: a damaged file is not consent to wider access.
pub fn recovery_config() -> Config {
    SHIPPED.recovery.clone()
}

/// Field defaults; the Windows first launch carries the platform-independent sections.
fn defaults() -> &'static Config {
    &SHIPPED.first_launch.windows
}

pub(crate) fn default_handoff_length() -> cos_types::config::HandoffLength {
    defaults()
        .compaction
        .handoff_length
        .expect("the shipped compaction names a handoff length")
}

/// `configSchema.parse(value)`.
pub fn parse_config(value: &Value) -> Check<Config> {
    let root = Obj::new(value, "")?;
    let d = defaults();
    Ok(Config {
        roots: root
            .req("roots", |v, p| array(v, p, 32, parse_root))
            .map(unique_stored_roots)?,
        capabilities: root.req("capabilities", parse_capabilities)?,
        read_only: root.req("readOnly", boolean)?,
        command_allowlist: root
            .opt("commandAllowlist", parse_command_allowlist)?
            .unwrap_or_else(|| CommandAllowlistSettings {
                enabled: false,
                mode: CommandPolicyMode::Allow,
                rules: Vec::new(),
                extra: Map::new(),
            }),
        tunnel: root.req("tunnel", parse_tunnel)?,
        connector_suffix: root
            .opt("connectorSuffix", parse_connector_suffix)
            .unwrap_or(None),
        setup_profiles: root.opt("setupProfiles", parse_setup_profiles)?,
        ui: root.req("ui", parse_ui)?,
        sessions: root
            .opt("sessions", parse_sessions)?
            .unwrap_or_else(|| d.sessions.clone()),
        compaction: root
            .opt("compaction", parse_compaction)?
            .unwrap_or_else(|| d.compaction.clone()),
        multi_agent: root
            .opt("multiAgent", parse_multi_agent)?
            .unwrap_or_else(|| SHIPPED.recovery.multi_agent.clone()),
        goal: root
            .opt("goal", parse_goal)?
            .unwrap_or_else(|| d.goal.clone()),
        mcp: default_catch(root.opt("mcp", parse_mcp), d.mcp.clone(), d.mcp.clone()),
        control_api: default_catch(
            root.opt("controlApi", parse_control_api),
            d.control_api.clone(),
            d.control_api.clone(),
        ),
        extra: Map::new(),
    })
}

fn parse_root(value: &Value, path: &str) -> Check<Root> {
    let o = Obj::new(value, path)?;
    let name = o.req("name", |v, p| text(v, p, 1, 32))?;
    let mut chars = name.chars();
    let lead = chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    if !lead
        || !chars
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
    {
        return Err(Invalid(o.path("name")));
    }
    Ok(Root {
        name,
        path: o.req("path", |v, p| text(v, p, 2, 4096))?,
        extra: Map::new(),
    })
}

/// Reserved names and duplicates are renamed in input order; the first usable spelling wins.
fn unique_stored_roots(roots: Vec<Root>) -> Vec<Root> {
    let mut used = HashSet::new();
    roots
        .into_iter()
        .map(|mut root| {
            let reserved = |name: &str| RESERVED_ROOT_NAMES.contains(&name);
            let base = if reserved(&root.name) {
                format!("{}-folder", root.name)
            } else {
                root.name.clone()
            };
            // Names are ASCII here, so byte and UTF-16 lengths agree.
            let mut candidate = base[..base.len().min(32)].to_owned();
            let mut suffix = 2;
            while reserved(&candidate) || used.contains(&candidate) {
                let tail = format!("-{suffix}");
                let keep = 32usize.saturating_sub(tail.len()).max(1);
                candidate = format!("{}{tail}", &base[..base.len().min(keep)]);
                suffix += 1;
            }
            used.insert(candidate.clone());
            root.name = candidate;
            root
        })
        .collect()
}

/// Older configs granted `powershell` (now `command`) and `deleteFolder` (dropped, never widened).
fn parse_capabilities(value: &Value, path: &str) -> Check<Capabilities> {
    let mut caps = match value {
        Value::Object(map) => map.clone(),
        // `{ ...array }` in the TypeScript migration: index keys, none of them a capability.
        Value::Array(_) => Map::new(),
        _ => return Err(Invalid(path.to_owned())),
    };
    if caps.get("powershell") == Some(&Value::Bool(true)) {
        caps.insert("command".into(), Value::Bool(true));
    }
    let migrated = Value::Object(caps);
    let o = Obj::new(&migrated, path)?;
    let d = &SHIPPED.recovery.capabilities;
    let flag = |key: &str, default: bool| o.opt(key, boolean).map(|v| v.unwrap_or(default));
    Ok(Capabilities {
        browse: flag("browse", d.browse)?,
        search: flag("search", d.search)?,
        read: flag("read", d.read)?,
        metadata: flag("metadata", d.metadata)?,
        create: flag("create", d.create)?,
        edit: flag("edit", d.edit)?,
        move_: flag("move", d.move_)?,
        delete_file: flag("deleteFile", d.delete_file)?,
        command: flag("command", d.command)?,
        screen: flag("screen", d.screen)?,
        control: flag("control", d.control)?,
        clipboard_read: flag("clipboardRead", d.clipboard_read)?,
        clipboard_write: flag("clipboardWrite", d.clipboard_write)?,
        extra: Map::new(),
    })
}

pub(crate) fn parse_command_rule(value: &Value, path: &str) -> Check<String> {
    let rule = text(value, path, 0, MAX_COMMAND_RULE_CHARS)?;
    if valid_command_rule(js::trim(&rule)) {
        Ok(rule)
    } else {
        Err(Invalid(path.to_owned()))
    }
}

pub(crate) fn parse_command_allowlist(
    value: &Value,
    path: &str,
) -> Check<CommandAllowlistSettings> {
    let o = Obj::new(value, path)?;
    Ok(CommandAllowlistSettings {
        enabled: o.req("enabled", boolean)?,
        mode: o.opt("mode", word)?.unwrap_or(CommandPolicyMode::Allow),
        rules: o.req("rules", |v, p| {
            array(v, p, MAX_COMMAND_RULES, parse_command_rule)
        })?,
        extra: Map::new(),
    })
}

/// `parseInvocation(rule, 'neutral', 'rule')` succeeding: literal arguments, wholly quoted or
/// bare, and at most one final standalone `*`.
fn valid_command_rule(source: &str) -> bool {
    let chars: Vec<char> = source.chars().collect();
    let mut index = 0;
    let mut args = 0;
    let skip_space = |index: &mut usize| {
        while matches!(chars.get(*index), Some(' ' | '\t')) {
            *index += 1;
        }
    };
    skip_space(&mut index);
    while index < chars.len() {
        if chars[index] == '*' {
            let rest: String = chars[index + 1..].iter().collect();
            return args > 0 && js::trim(&rest).is_empty();
        }
        let mut has_segment = false;
        while index < chars.len() && !matches!(chars[index], ' ' | '\t') {
            let c = chars[index];
            if c == '"' || c == '\'' {
                if has_segment {
                    return false;
                }
                has_segment = true;
                index += 1;
                let mut closed = false;
                while index < chars.len() {
                    let quoted = chars[index];
                    index += 1;
                    if quoted == c {
                        closed = true;
                        break;
                    }
                    if matches!(quoted, '\r' | '\n') {
                        return false;
                    }
                }
                if !closed || (index < chars.len() && !matches!(chars[index], ' ' | '\t')) {
                    return false;
                }
                continue;
            }
            if "|;&<>(){}\r\n$`*?[]#".contains(c) {
                return false;
            }
            has_segment = true;
            index += 1;
        }
        if !has_segment {
            return false;
        }
        args += 1;
        skip_space(&mut index);
    }
    args > 0
}

fn parse_tunnel(value: &Value, path: &str) -> Check<TunnelSettings> {
    let o = Obj::new(value, path)?;
    let id = |key: &str| {
        o.opt(key, |v, p| text(v, p, 0, 128))
            .map(Option::unwrap_or_default)
    };
    Ok(TunnelSettings {
        profile_id: o.opt("profileId", |v, p| text(v, p, 1, 64))?,
        profile_name: o.opt("profileName", |v, p| trimmed(v, p, 1, 80))?,
        profile_epoch: o
            .opt("profileEpoch", |v, p| int(v, p, 0, i64::MAX))?
            .map(|n| n as u64),
        kind: o.req("kind", word)?,
        tunnel_id: o.req("tunnelId", |v, p| text(v, p, 0, 128))?,
        desktop_tunnel_id: id("desktopTunnelId")?,
        plugins_tunnel_id: Some(id("pluginsTunnelId")?),
        binary_path: o.req("binaryPath", |v, p| text(v, p, 0, 4096))?,
        extra: Map::new(),
    })
}

static CONNECTOR_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[\p{L}\p{N} ._-]*$").expect("connector suffix pattern"));

pub(crate) fn connector_suffix_allowed(suffix: &str) -> bool {
    js::len(suffix) <= CONNECTOR_SUFFIX_MAX && CONNECTOR_SUFFIX.is_match(suffix)
}

fn parse_connector_suffix(value: &Value, path: &str) -> Check<String> {
    let suffix = js::trim(string(value, path)?);
    if connector_suffix_allowed(suffix) {
        Ok(suffix.to_owned())
    } else {
        Err(Invalid(path.to_owned()))
    }
}

fn parse_setup_profiles(value: &Value, path: &str) -> Check<Vec<SetupProfile>> {
    let profiles = array(value, path, 11, |value, path| {
        let o = Obj::new(value, path)?;
        Ok(SetupProfile {
            id: o.req("id", |v, p| text(v, p, 1, 64))?,
            name: o.req("name", |v, p| trimmed(v, p, 1, 80))?,
            tunnel_id: o.req("tunnelId", |v, p| text(v, p, 0, 128))?,
            desktop_tunnel_id: o.req("desktopTunnelId", |v, p| text(v, p, 0, 128))?,
            plugins_tunnel_id: o.req("pluginsTunnelId", |v, p| text(v, p, 0, 128))?,
            extra: Map::new(),
        })
    })?;
    let unique: HashSet<&str> = profiles.iter().map(|profile| profile.id.as_str()).collect();
    if unique.len() == profiles.len() {
        Ok(profiles)
    } else {
        Err(Invalid(path.to_owned()))
    }
}

fn parse_color(value: &Value, path: &str) -> Check<String> {
    let color = string(value, path)?;
    let bytes = color.as_bytes();
    if bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit) {
        Ok(color.to_owned())
    } else {
        Err(Invalid(path.to_owned()))
    }
}

/// `appearanceSchema`.
pub(crate) fn parse_appearance(value: &Value, path: &str) -> Check<AppearanceSettings> {
    let o = Obj::new(value, path)?;
    let palette = |value: &Value, path: &str| -> Check<AppearancePalette> {
        let p = Obj::new(value, path)?;
        Ok(AppearancePalette {
            background: p.req("background", parse_color)?,
            sidebar: p.req("sidebar", parse_color)?,
            accent: p.req("accent", parse_color)?,
            contrast: p.req("contrast", |v, p| int(v, p, 0, 100))? as u8,
            extra: Map::new(),
        })
    };
    Ok(AppearanceSettings {
        light: o.req("light", palette)?,
        dark: o.req("dark", palette)?,
        font: o.req("font", word)?,
        font_size: o.req("fontSize", |v, p| int(v, p, 12, 18))? as u8,
        translucent_sidebar: o.req("translucentSidebar", boolean)?,
        extra: Map::new(),
    })
}

pub(crate) fn parse_bridge_port(value: &Value, path: &str) -> Check<BrowserBridgePort> {
    if value.as_str() == Some("auto") {
        return Ok(BrowserBridgePort::Auto);
    }
    js::safe_integer(value)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| BrowserBridgePort::FIXED.contains(port))
        .map(BrowserBridgePort::Fixed)
        .ok_or_else(|| Invalid(path.to_owned()))
}

pub(crate) fn parse_browser_preferences(value: &Value, path: &str) -> Check<BrowserPreferences> {
    let o = Obj::new(value, path)?;
    o.strict(&["overwrite", "durations"])?;
    Ok(BrowserPreferences {
        overwrite: o.req("overwrite", boolean)?,
        durations: o.req("durations", boolean)?,
    })
}

fn parse_ui(value: &Value, path: &str) -> Check<UiPrefs> {
    let o = Obj::new(value, path)?;
    let flag = |key: &str| o.opt(key, boolean);
    let flag_or =
        |key: &str, default: bool| o.opt(key, boolean).map(|v| Some(v.unwrap_or(default)));
    Ok(UiPrefs {
        appearance: o.opt("appearance", parse_appearance).unwrap_or(None),
        auto_continue: flag_or("autoContinue", true)?,
        default_chat_model: o
            .opt("defaultChatModel", |v, p| trimmed(v, p, 1, 80))
            .unwrap_or(None),
        default_chat_reasoning: o.opt("defaultChatReasoning", word).unwrap_or(None),
        chat_browser: Some(
            o.opt("chatBrowser", word)?
                .unwrap_or(cos_types::config::ChatBrowser::Chrome),
        ),
        developer_mode: flag("developerMode")?,
        playful_status: flag("playfulStatus")?,
        follow_output: flag_or("followOutput", true)?,
        mention_core: flag_or("mentionCore", true)?,
        language: o.opt("language", word)?,
        last_seen_version: o
            .opt("lastSeenVersion", |v, p| trimmed(v, p, 1, 40))
            .unwrap_or(None),
        browser_preferences: o.opt("browserPreferences", parse_browser_preferences)?,
        cos_browser_tray_hint: flag("cosBrowserTrayHint")?,
        finish_tool: flag("finishTool")?,
        plan_backend: o.opt("planBackend", word)?,
        finish_action: o.opt("finishAction", word)?,
        finish_lead_minutes: o
            .opt("finishLeadMinutes", |v, p| int(v, p, 3, 5))?
            .map(|n| n as u8),
        background_chats: flag_or("backgroundChats", true)?,
        background_placement: Some(default_catch(
            o.opt("backgroundPlacement", word),
            cos_types::config::BackgroundPlacement::Window,
            cos_types::config::BackgroundPlacement::Window,
        )),
        browser_bridge_port: Some(
            o.opt("browserBridgePort", parse_bridge_port)?
                .unwrap_or(BrowserBridgePort::Auto),
        ),
        browser_only: flag_or("browserOnly", false)?,
        auto_refresh_plugins: flag_or("autoRefreshPlugins", false)?,
        auto_select_skills: flag_or("autoSelectSkills", false)?,
        tabs_to_keep_open: o
            .opt("tabsToKeepOpen", |v, p| int(v, p, 1, 50))?
            .map(|n| n as u8),
        minimize_to_tray: o.req("minimizeToTray", boolean)?,
        auto_connect: o.req("autoConnect", boolean)?,
        start_at_login: flag_or("startAtLogin", false)?,
        privacy_screenshots: o.opt("privacyScreenshots", boolean)?.unwrap_or(false),
        theme: o
            .opt("theme", word)?
            .unwrap_or(cos_types::config::Theme::Dark),
        extra: Map::new(),
    })
}

fn tokens(o: &Obj<'_>, key: &str, default: u64) -> Check<u64> {
    Ok(o.opt(key, |v, p| int(v, p, MIN_TOKENS, MAX_TOKENS))?
        .map_or(default, |n| n as u64))
}

fn parse_sessions(value: &Value, path: &str) -> Check<SessionSettings> {
    let o = Obj::new(value, path)?;
    let d = &defaults().sessions;
    o.opt("record", boolean)?;
    o.opt("retainDays", |v, p| int(v, p, 0, 3650))?;
    // Recording is no longer a choice: the stored switches are read and then normalized.
    Ok(SessionSettings {
        record: true,
        retain_days: 0,
        advisory_tokens: tokens(&o, "advisoryTokens", d.advisory_tokens)?,
        limit_tokens: tokens(&o, "limitTokens", d.limit_tokens)?,
        extra: Map::new(),
    })
}

/// `.string().max(max).optional().default(d).transform(blank -> d, else trimmed).catch(d)`.
fn prompt(o: &Obj<'_>, key: &str, max: usize, default: &str) -> String {
    let blank_to_default = |prompt: &str| {
        let trimmed = js::trim(prompt);
        if trimmed.is_empty() {
            default.to_owned()
        } else {
            trimmed.to_owned()
        }
    };
    match o.opt(key, |v, p| text(v, p, 0, max)) {
        Ok(Some(prompt)) => blank_to_default(&prompt),
        Ok(None) => blank_to_default(default),
        Err(_) => default.to_owned(),
    }
}

fn parse_compaction(value: &Value, path: &str) -> Check<CompactionSettings> {
    let o = Obj::new(value, path)?;
    let d = &defaults().compaction;
    let length = default_handoff_length();
    Ok(CompactionSettings {
        auto: o.opt("auto", boolean)?.unwrap_or(d.auto),
        auto_tokens: tokens(&o, "autoTokens", d.auto_tokens)?,
        handoff_prompt: prompt(&o, "handoffPrompt", MAX_PROMPT_CHARS, &d.handoff_prompt),
        handoff_length: Some(default_catch(o.opt("handoffLength", word), length, length)),
        extra: Map::new(),
    })
}

fn parse_multi_agent(value: &Value, path: &str) -> Check<MultiAgentSettings> {
    let o = Obj::new(value, path)?;
    let flag = |key: &str| o.opt(key, boolean).map(Option::unwrap_or_default);
    Ok(MultiAgentSettings {
        enabled: flag("enabled")?,
        default_model: o.opt("defaultModel", |v, p| text(v, p, 0, 80))?,
        default_reasoning: o.opt("defaultReasoning", word)?,
        max_workers: o.opt("maxWorkers", |v, p| int(v, p, 1, 8))?.unwrap_or(2) as u8,
        global_max_workers: Some(
            o.opt("globalMaxWorkers", |v, p| int(v, p, 0, 64))?
                .unwrap_or(0) as u8,
        ),
        allow_unattributed_calls: flag("allowUnattributedCalls")?,
        strict_chat_allowlist: Some(flag("strictChatAllowlist")?),
        recover_agent_tabs: flag("recoverAgentTabs")?,
        wait_for_sub_agents: Some(flag("waitForSubAgents")?),
        auto_worktrees: Some(flag("autoWorktrees")?),
        end_sleeping_worker_processes: Some(flag("endSleepingWorkerProcesses")?),
        extra: Map::new(),
    })
}

fn parse_goal(value: &Value, path: &str) -> Check<GoalSettings> {
    let o = Obj::new(value, path)?;
    let d = &defaults().goal;
    let helper_model = d
        .helper_model
        .clone()
        .expect("the shipped goal names a helper model");
    let helper_reasoning = d
        .helper_reasoning
        .expect("the shipped goal names a helper reasoning");
    let provider = match o.opt("provider", |value, path| {
        let p = Obj::new(value, path)?;
        Ok(GoalProviderSettings {
            kind: default_catch(p.opt("kind", word), d.provider.kind, d.provider.kind),
            base_url: p
                .opt("baseUrl", |v, p| text(v, p, 0, 2048))?
                .unwrap_or_default(),
            extra: Map::new(),
        })
    })? {
        Some(provider) => provider,
        None => d.provider.clone(),
    };
    let model = match o.opt("model", |v, p| text(v, p, 0, 160))? {
        Some(model) if !js::trim(&model).is_empty() => js::trim(&model).to_owned(),
        _ => d.model.clone(),
    };
    Ok(GoalSettings {
        impulse_minutes: Some(
            default_catch(o.opt("impulseMinutes", |v, p| int(v, p, 0, 60)), 0, 0) as u8,
        ),
        include_tool_calls: Some(o.opt("includeToolCalls", boolean)?.unwrap_or(false)),
        enabled: o.opt("enabled", boolean)?.unwrap_or(d.enabled),
        backend: Some(
            o.opt("backend", word)?
                .unwrap_or(cos_types::config::GoalBackend::Chatgpt),
        ),
        loop_backend: Some(
            o.opt("loopBackend", word)?
                .unwrap_or(cos_types::config::LoopBackend::Chatgpt),
        ),
        helper_model: Some(default_catch(
            o.opt("helperModel", |v, p| trimmed(v, p, 1, 80)),
            helper_model.clone(),
            helper_model,
        )),
        helper_reasoning: Some(default_catch(
            o.opt("helperReasoning", word),
            helper_reasoning,
            helper_reasoning,
        )),
        mode: default_catch(o.opt("mode", word), d.mode, d.mode),
        provider,
        model,
        reasoning: default_catch(o.opt("reasoning", word), d.reasoning, d.reasoning),
        prompt: prompt(&o, "prompt", MAX_PROMPT_CHARS, &d.prompt),
        objective_prompt: prompt(&o, "objectivePrompt", MAX_PROMPT_CHARS, &d.objective_prompt),
        loop_prompt: prompt(&o, "loopPrompt", MAX_PROMPT_CHARS, &d.loop_prompt),
        extra: Map::new(),
    })
}

fn parse_mcp(value: &Value, path: &str) -> Check<McpSettings> {
    let o = Obj::new(value, path)?;
    let instructions = match o.opt("instructions", string) {
        Ok(Some(text)) => js::trim(js::prefix(text, MAX_MCP_INSTRUCTIONS_CHARS)).to_owned(),
        Ok(None) | Err(_) => String::new(),
    };
    Ok(McpSettings {
        instructions,
        extra: Map::new(),
    })
}

fn parse_control_api(value: &Value, path: &str) -> Check<ControlApiSettings> {
    let o = Obj::new(value, path)?;
    let enabled = default_catch(o.opt("enabled", boolean), false, false);
    let allow_actions = default_catch(o.opt("allowActions", boolean), false, false);
    Ok(ControlApiSettings {
        enabled,
        allow_actions: enabled && allow_actions,
        extra: Map::new(),
    })
}

/// The one-time moves `loadConfig` applies after a successful parse: stored numbers and prompts
/// that were the app's own old defaults (never a person's choice) follow the current defaults.
pub(crate) fn adopt_current_defaults(mut config: Config) -> Config {
    let d = defaults();
    let sessions = &mut config.sessions;
    if matches!(
        (sessions.advisory_tokens, sessions.limit_tokens),
        (180_000, 200_000) | (300_000, 400_000)
    ) {
        sessions.advisory_tokens = d.sessions.advisory_tokens;
        sessions.limit_tokens = d.sessions.limit_tokens;
    }
    let compaction = &mut config.compaction;
    if !compaction.auto && compaction.auto_tokens == 300_000 {
        compaction.auto = d.compaction.auto;
        compaction.auto_tokens = d.compaction.auto_tokens;
    }
    if compaction.auto && compaction.auto_tokens == 300_000 {
        compaction.auto_tokens = d.compaction.auto_tokens;
    }
    let goal = &mut config.goal;
    let superseded = &SHIPPED.superseded;
    if superseded.goal_prompt.contains(&goal.prompt) {
        goal.prompt.clone_from(&d.goal.prompt);
    }
    if superseded.objective_prompt.contains(&goal.objective_prompt) {
        goal.objective_prompt.clone_from(&d.goal.objective_prompt);
    }
    if superseded.loop_prompt.contains(&goal.loop_prompt) {
        goal.loop_prompt.clone_from(&d.goal.loop_prompt);
    }
    if goal
        .helper_model
        .as_ref()
        .is_some_and(|model| superseded.helper_model.contains(model))
    {
        goal.helper_model.clone_from(&d.goal.helper_model);
    }
    // Duplicate names would make a virtual path ambiguous.
    let mut seen = HashSet::new();
    config
        .roots
        .retain(|root| seen.insert(root.name.to_lowercase()));
    config
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_rules_accept_only_literal_invocations() {
        for rule in [
            "git status",
            "npm 'run test' *",
            "  cargo   test  ",
            "git \"log\"",
        ] {
            assert!(valid_command_rule(js::trim(rule)), "{rule}");
        }
        for rule in [
            "",
            "*",
            "git status | grep x",
            "a 'b",
            "a \"b\"c",
            "x * y",
            "rm -rf ~/$HOME",
            "a\"b\"",
        ] {
            assert!(!valid_command_rule(js::trim(rule)), "{rule}");
        }
    }
}
