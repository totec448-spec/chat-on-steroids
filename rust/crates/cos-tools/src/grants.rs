//! What the live settings allow, derived from one config snapshot.
//!
//! `Grants` is never stored or published: the kernel derives it from the config snapshot at the
//! start of each call, so it can never disagree with the config the Settings owner published.

use std::path::PathBuf;

use cos_fs::Roots;
use cos_store::Platform;
use cos_types::config::{Capability, Config};

use crate::ToolError;
use crate::tool::Requirement;

/// A set of [`Capability`] values, one bit each in `Capability::ALL` order.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct CapabilitySet(u16);

impl CapabilitySet {
    pub const EMPTY: Self = Self(0);

    pub const fn bits(self) -> u16 {
        self.0
    }

    pub const fn from_bits(bits: u16) -> Self {
        Self(bits)
    }

    pub fn contains(self, capability: Capability) -> bool {
        self.0 & bit(capability) != 0
    }

    pub fn with(self, capability: Capability) -> Self {
        Self(self.0 | bit(capability))
    }

    pub fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    pub fn any_of(self, capabilities: &[Capability]) -> bool {
        capabilities
            .iter()
            .any(|&capability| self.contains(capability))
    }
}

fn bit(capability: Capability) -> u16 {
    1 << capability as u16
}

/// App features that gate tools without being a capability checkbox.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Feature {
    /// `sessions.record`: `update_plan`.
    SessionRecording,
    /// `multiAgent.enabled`: `agents`.
    MultiAgent,
    /// `ui.finishTool`: `session_finish`.
    FinishTool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct FeatureSet(u8);

impl FeatureSet {
    pub const fn bits(self) -> u8 {
        self.0
    }

    pub const fn from_bits(bits: u8) -> Self {
        Self(bits)
    }

    pub fn contains(self, feature: Feature) -> bool {
        self.0 & (1 << feature as u8) != 0
    }

    pub fn with(self, feature: Feature) -> Self {
        Self(self.0 | (1 << feature as u8))
    }

    pub fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }
}

/// Facts about this install that grants depend on but the config does not hold.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrantEnv {
    /// `<userData>/skills`, exposed as `/skills`.
    pub skills_dir: PathBuf,
    pub platform: Platform,
}

/// The live permissions of one call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grants {
    /// Effective capabilities: the checkboxes with Read-only applied (`effectiveCapabilities`).
    pub capabilities: CapabilitySet,
    pub read_only: bool,
    pub features: FeatureSet,
    /// `multiAgent.allowUnattributedCalls`.
    pub allow_unattributed: bool,
    pub roots: Roots,
    pub platform: Platform,
}

/// The capabilities Read-only switches off (`WRITE_CAPABILITIES`).
const WRITE: &[Capability] = &[
    Capability::Create,
    Capability::Edit,
    Capability::Move,
    Capability::DeleteFile,
    Capability::Command,
    Capability::Control,
    Capability::ClipboardWrite,
];

/// The Settings label of each permission (`CAPABILITY_LABELS`).
fn label(capability: Capability) -> &'static str {
    match capability {
        Capability::Browse => "Browse folders",
        Capability::Search => "Search files",
        Capability::Read => "Read files",
        Capability::Metadata => "File metadata",
        Capability::Create => "Create files",
        Capability::Edit => "Edit files",
        Capability::Move => "Move / rename",
        Capability::DeleteFile => "Delete files",
        Capability::Command => "Run commands",
        Capability::Screen => "See the screen",
        Capability::Control => "Control mouse and keyboard",
        Capability::ClipboardRead => "Read clipboard",
        Capability::ClipboardWrite => "Write clipboard",
    }
}

impl Feature {
    /// The feature and the setting that turns it on, as `featureDisabled` names them.
    fn wording(self) -> (&'static str, &'static str) {
        match self {
            Self::SessionRecording => ("Session recording", "Settings → Chat"),
            Self::MultiAgent => ("Multi-agent mode", "Multi-agent mode (experimental)"),
            // No TypeScript tool refuses on this switch: `session_finish` answers RELEASED.
            Self::FinishTool => ("Session finish", "Finish tool"),
        }
    }
}

/// Whether native desktop automation exists on this platform (`desktopAutomationSupported`).
pub(crate) fn desktop_supported(platform: Platform) -> bool {
    matches!(platform, Platform::Windows | Platform::Macos)
}

impl Grants {
    /// `effectiveCapabilities()` plus the feature switches, from one config snapshot.
    pub fn derive(config: &Config, env: &GrantEnv) -> Self {
        let mut capabilities = CapabilitySet::EMPTY;
        for &capability in Capability::ALL {
            // `capabilitiesForPlatform`: without native automation only the clipboard goes;
            // screen and control still govern the browser extension.
            let native_only = matches!(
                capability,
                Capability::ClipboardRead | Capability::ClipboardWrite
            );
            let available = desktop_supported(env.platform) || !native_only;
            let blocked = config.read_only && WRITE.contains(&capability);
            if config.capabilities.get(capability) && available && !blocked {
                capabilities = capabilities.with(capability);
            }
        }
        let mut features = FeatureSet::default();
        for (on, feature) in [
            (config.sessions.record, Feature::SessionRecording),
            (config.multi_agent.enabled, Feature::MultiAgent),
            (config.ui.finish_tool == Some(true), Feature::FinishTool),
        ] {
            if on {
                features = features.with(feature);
            }
        }
        Self {
            capabilities,
            read_only: config.read_only,
            features,
            allow_unattributed: config.multi_agent.allow_unattributed_calls,
            roots: Roots::from_config(&config.roots, &env.skills_dir),
            platform: env.platform,
        }
    }

    /// Refuses with the exact `TOOL_DISABLED` or `FEATURE_DISABLED` text when `requirement` is
    /// not live. Read-only is named as the owner when it is what turned a capability off.
    pub fn require(&self, requirement: Requirement, tool: &str) -> Result<(), ToolError> {
        match requirement {
            Requirement::None => Ok(()),
            Requirement::Capability(capability) if self.capabilities.contains(capability) => Ok(()),
            Requirement::Capability(capability)
                if self.read_only && WRITE.contains(&capability) =>
            {
                Err(ToolError::Refused(format!(
                    "TOOL_DISABLED: {tool} is disabled because Read-only mode is on. Ask the user to turn Read-only off in the app, then retry."
                )))
            }
            Requirement::Capability(capability) => {
                let label = label(capability);
                Err(ToolError::Refused(format!(
                    "TOOL_DISABLED: {tool} requires the \"{label}\" permission. Ask the user to enable \"{label}\" in the app, then retry."
                )))
            }
            Requirement::Feature(feature) if self.features.contains(feature) => Ok(()),
            Requirement::Feature(feature) => {
                let (name, setting) = feature.wording();
                Err(ToolError::Refused(format!(
                    "FEATURE_DISABLED: {name} is switched off in Chat On Steroids. Ask the user to enable \"{setting}\" in the app, then try again."
                )))
            }
        }
    }
}
