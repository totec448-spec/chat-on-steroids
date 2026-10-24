//! `config.json` (`Config` in `src/shared/types.ts`, written by `src/main/config.ts`).
//!
//! These types describe the file the TypeScript app writes after its schema parse: every
//! section present, legacy keys migrated away. Reading an older or hand-edited file (missing
//! sections, `powershell`/`deleteFolder` capabilities, out-of-range numbers, unknown enum
//! words) is the job of the config loader, which repairs before it trusts. Unknown keys in a
//! section are kept in that section's `extra` so a newer build's settings survive a Rust save.
//!
//! Field order follows the zod schema in `config.ts`, which decides the order TypeScript writes,
//! so serializing a [`Config`] with `to_string_pretty` reproduces the file byte for byte.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::json::{Extra, string_enum};
use crate::session::ReasoningEffort;

/// An approved folder: the virtual name the model sees and the host path it never sees.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Root {
    pub name: String,
    pub path: String,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    /// One capability per user-facing checkbox (`CAPABILITIES`).
    pub enum Capability {
        Browse = "browse", Search = "search", Read = "read", Metadata = "metadata", Create = "create",
        Edit = "edit", Move = "move", DeleteFile = "deleteFile", Command = "command", Screen = "screen",
        Control = "control", ClipboardRead = "clipboardRead", ClipboardWrite = "clipboardWrite",
    }
}

/// `Record<Capability, boolean>`; every key is present once the config schema has parsed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub browse: bool,
    pub search: bool,
    pub read: bool,
    pub metadata: bool,
    pub create: bool,
    pub edit: bool,
    #[serde(rename = "move")]
    pub move_: bool,
    pub delete_file: bool,
    pub command: bool,
    pub screen: bool,
    pub control: bool,
    pub clipboard_read: bool,
    pub clipboard_write: bool,
    #[serde(flatten)]
    pub extra: Extra,
}

impl Capabilities {
    /// Whether `capability` is switched on.
    pub fn get(&self, capability: Capability) -> bool {
        match capability {
            Capability::Browse => self.browse,
            Capability::Search => self.search,
            Capability::Read => self.read,
            Capability::Metadata => self.metadata,
            Capability::Create => self.create,
            Capability::Edit => self.edit,
            Capability::Move => self.move_,
            Capability::DeleteFile => self.delete_file,
            Capability::Command => self.command,
            Capability::Screen => self.screen,
            Capability::Control => self.control,
            Capability::ClipboardRead => self.clipboard_read,
            Capability::ClipboardWrite => self.clipboard_write,
        }
    }
}

string_enum! {
    pub enum TunnelKind { Openai = "openai", Cloudflared = "cloudflared", Manual = "manual" }
}

/// The active setup's connectors (`TunnelSettings`). Ids are free text here; empty means unset.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_epoch: Option<u64>,
    pub kind: TunnelKind,
    pub tunnel_id: String,
    pub desktop_tunnel_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugins_tunnel_id: Option<String>,
    pub binary_path: String,
    #[serde(flatten)]
    pub extra: Extra,
}

/// An inactive setup (`Config.setupProfiles[]`); its keys live in encrypted secret slots.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupProfile {
    pub id: String,
    pub name: String,
    pub tunnel_id: String,
    pub desktop_tunnel_id: String,
    pub plugins_tunnel_id: String,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    /// `CHAT_BROWSERS`; `cos` is the built-in browser.
    pub enum ChatBrowser { Chrome = "chrome", Edge = "edge", Brave = "brave", Cos = "cos" }
}

string_enum! {
    /// `UI_LANGUAGES`.
    pub enum UiLanguage {
        En = "en", De = "de", Es = "es", Fr = "fr", PtBr = "pt-BR", PtPt = "pt-PT", Ru = "ru",
        Tr = "tr", Vi = "vi", Ja = "ja", Ko = "ko", ZhCn = "zh-CN", ZhTw = "zh-TW",
    }
}

string_enum! {
    pub enum Theme { Light = "light", Dark = "dark" }
}
string_enum! {
    pub enum BackgroundPlacement { Window = "window", Group = "group" }
}
string_enum! {
    pub enum PlanBackend { Chatgpt = "chatgpt", Api = "api" }
}
string_enum! {
    pub enum FinishAction { Notify = "notify", Goal = "goal" }
}

/// `ui.browserBridgePort`: `"auto"` or one of the fixed ports 8765..=8769.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BrowserBridgePort {
    Auto,
    Fixed(u16),
}

impl BrowserBridgePort {
    /// The fixed choices Settings offers (`BROWSER_BRIDGE_PORTS`).
    pub const FIXED: [u16; 5] = [8765, 8766, 8767, 8768, 8769];
}

impl Serialize for BrowserBridgePort {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Auto => serializer.serialize_str("auto"),
            Self::Fixed(port) => serializer.serialize_u16(*port),
        }
    }
}

impl<'de> Deserialize<'de> for BrowserBridgePort {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Port(u16),
            Word(String),
        }
        match Raw::deserialize(deserializer)? {
            Raw::Word(word) if word == "auto" => Ok(Self::Auto),
            Raw::Port(port) if Self::FIXED.contains(&port) => Ok(Self::Fixed(port)),
            _ => Err(serde::de::Error::custom(
                "browserBridgePort must be \"auto\" or 8765..8769",
            )),
        }
    }
}

/// Browser-owned display preferences the app keeps for a reinstalled extension.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserPreferences {
    pub overwrite: bool,
    pub durations: bool,
}

string_enum! {
    pub enum AppearanceFont { System = "system", Sans = "sans", Serif = "serif", Mono = "mono" }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AppearancePalette {
    pub background: String,
    pub sidebar: String,
    pub accent: String,
    pub contrast: u8,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `ui.appearance` (`AppearanceSettings`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettings {
    pub light: AppearancePalette,
    pub dark: AppearancePalette,
    pub font: AppearanceFont,
    pub font_size: u8,
    pub translucent_sidebar: bool,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `ui` (`UiPrefs`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPrefs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<AppearanceSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_continue: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_chat_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_chat_reasoning: Option<ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_browser: Option<ChatBrowser>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub developer_mode: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playful_status: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow_output: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mention_core: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<UiLanguage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_preferences: Option<BrowserPreferences>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cos_browser_tray_hint: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_tool: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_backend: Option<PlanBackend>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_action: Option<FinishAction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_lead_minutes: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_chats: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_placement: Option<BackgroundPlacement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_bridge_port: Option<BrowserBridgePort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_refresh_plugins: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_select_skills: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tabs_to_keep_open: Option<u8>,
    pub minimize_to_tray: bool,
    pub auto_connect: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_at_login: Option<bool>,
    pub privacy_screenshots: bool,
    pub theme: Theme,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `sessions` (`SessionSettings`). `record` is always `true` and `retainDays` always `0`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSettings {
    pub record: bool,
    pub retain_days: u32,
    pub advisory_tokens: u64,
    pub limit_tokens: u64,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    pub enum HandoffLength { Thorough = "thorough", Standard = "standard", Short = "short" }
}

/// `compaction` (`CompactionSettings`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionSettings {
    pub auto: bool,
    pub auto_tokens: u64,
    pub handoff_prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff_length: Option<HandoffLength>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `multiAgent.defaultReasoning`: a reasoning effort, or `""` for none chosen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DefaultReasoning {
    Unset,
    Effort(ReasoningEffort),
}

impl Serialize for DefaultReasoning {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Unset => serializer.serialize_str(""),
            Self::Effort(effort) => effort.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for DefaultReasoning {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        if word.is_empty() {
            return Ok(Self::Unset);
        }
        ReasoningEffort::ALL
            .iter()
            .find(|effort| effort.as_str() == word)
            .map(|effort| Self::Effort(*effort))
            .ok_or_else(|| {
                serde::de::Error::custom(format_args!("unknown reasoning effort {word:?}"))
            })
    }
}

/// `multiAgent` (`MultiAgentSettings`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiAgentSettings {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_reasoning: Option<DefaultReasoning>,
    pub max_workers: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub global_max_workers: Option<u8>,
    pub allow_unattributed_calls: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strict_chat_allowlist: Option<bool>,
    pub recover_agent_tabs: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_for_sub_agents: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_worktrees: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_sleeping_worker_processes: Option<bool>,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    pub enum CommandPolicyMode { Allow = "allow", Deny = "deny" }
}

/// `commandAllowlist` (`CommandAllowlistSettings`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CommandAllowlistSettings {
    pub enabled: bool,
    pub mode: CommandPolicyMode,
    pub rules: Vec<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

string_enum! {
    pub enum GoalMode { Goal = "goal", Loop = "loop" }
}
string_enum! {
    pub enum GoalBackend { Api = "api", Chatgpt = "chatgpt", Templates = "templates" }
}
string_enum! {
    pub enum LoopBackend { Api = "api", Chatgpt = "chatgpt" }
}
string_enum! {
    pub enum GoalProviderKind { Openrouter = "openrouter", Custom = "custom" }
}
string_enum! {
    /// `GOAL_REASONING_LEVELS`, in OpenRouter's vocabulary.
    pub enum GoalReasoning {
        Default = "default", None = "none", Minimal = "minimal", Low = "low", Medium = "medium",
        High = "high", Xhigh = "xhigh", Max = "max",
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalProviderSettings {
    pub kind: GoalProviderKind,
    pub base_url: String,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `goal` (`GoalSettings`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub impulse_minutes: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_tool_calls: Option<bool>,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<GoalBackend>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_backend: Option<LoopBackend>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_reasoning: Option<ReasoningEffort>,
    pub mode: GoalMode,
    pub provider: GoalProviderSettings,
    pub model: String,
    pub reasoning: GoalReasoning,
    pub prompt: String,
    pub objective_prompt: String,
    pub loop_prompt: String,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `mcp` (`McpSettings`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct McpSettings {
    pub instructions: String,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `controlApi` (`ControlApiSettings`). `allowActions` is never true while `enabled` is false.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlApiSettings {
    pub enabled: bool,
    pub allow_actions: bool,
    #[serde(flatten)]
    pub extra: Extra,
}

/// The whole of `config.json` (`Config`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub roots: Vec<Root>,
    pub capabilities: Capabilities,
    pub read_only: bool,
    pub command_allowlist: CommandAllowlistSettings,
    pub tunnel: TunnelSettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connector_suffix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_profiles: Option<Vec<SetupProfile>>,
    pub ui: UiPrefs,
    pub sessions: SessionSettings,
    pub compaction: CompactionSettings,
    pub multi_agent: MultiAgentSettings,
    pub goal: GoalSettings,
    pub mcp: McpSettings,
    pub control_api: ControlApiSettings,
    #[serde(flatten)]
    pub extra: Extra,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_port_accepts_only_auto_and_the_fixed_range() {
        let auto: BrowserBridgePort = serde_json::from_str("\"auto\"").expect("auto");
        assert_eq!(auto, BrowserBridgePort::Auto);
        let fixed: BrowserBridgePort = serde_json::from_str("8767").expect("fixed");
        assert_eq!(serde_json::to_string(&fixed).expect("writes"), "8767");
        assert!(serde_json::from_str::<BrowserBridgePort>("18765").is_err());
        assert!(serde_json::from_str::<BrowserBridgePort>("\"8765\"").is_err());
    }

    #[test]
    fn default_reasoning_keeps_the_empty_choice() {
        let unset: DefaultReasoning = serde_json::from_str("\"\"").expect("empty");
        assert_eq!(unset, DefaultReasoning::Unset);
        assert_eq!(serde_json::to_string(&unset).expect("writes"), "\"\"");
        let high: DefaultReasoning = serde_json::from_str("\"high\"").expect("high");
        assert_eq!(high, DefaultReasoning::Effort(ReasoningEffort::High));
    }
}
