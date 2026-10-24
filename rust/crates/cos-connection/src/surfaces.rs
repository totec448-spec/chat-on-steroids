//! What each connector card says, running or not (`describeSurfaces` in `connection.ts`, the
//! definitions in `mcp/surfaces.ts`). Built even while disconnected, because Setup shows the
//! exact connector name and description before anything is live.

use cos_mcp::SurfaceUrls;
use cos_store::Platform;
use cos_tools::{Capability, Feature, Grants};
use cos_types::app_state::{SurfaceConnectionState, SurfaceId, SurfaceStatus};

struct Definition {
    description: &'static str,
    card_summary: &'static str,
    optional: bool,
}

fn definition(id: SurfaceId) -> &'static Definition {
    match id {
        SurfaceId::Core => &CORE,
        SurfaceId::Desktop => &DESKTOP,
        SurfaceId::Plugins => &PLUGINS,
    }
}

const CORE: Definition = Definition {
    description: "Read and edit code and text files on this computer, and run commands in a real terminal. \
        Use for: opening and reading files, searching a repository, applying patches, creating, renaming and deleting files, \
        running builds, tests, linters, git, npm and shell commands, continuing long-running or interactive terminal sessions, \
        and saving images and files ChatGPT generates onto this computer. \
        Also displays task plans and \u{2014} when the user has \
        enabled it \u{2014} spawns and coordinates worker agents, subagents or a parallel swarm across several ChatGPT conversations.",
    card_summary: "Files, patches and terminal.",
    optional: false,
};

const DESKTOP: Definition = Definition {
    description: "Control browser tabs in the background and this computer desktop, including its clipboard. \
        Attach existing Chrome/Edge/Brave tabs or open new tabs; inspect DOM refs, page screenshots, JavaScript, console errors and network requests; click, fill forms and navigate without foreground activation. \
        Use for: listing and launching apps, taking background window screenshots, reading what is on screen, listing and finding windows, inspecting buttons, fields and other UI controls, \
        clicking, typing, pressing keys, scrolling and dragging in native applications, \
        and reading the clipboard or copying and pasting text between programs.",
    card_summary: "Browser and desktop apps.",
    optional: true,
};

const PLUGINS: Definition = Definition {
    description: "Tools from external MCP integrations installed and enabled in Chat On Steroids Settings, including Blender and other connected applications and services.",
    card_summary: "One shared connector for your enabled external MCP plugins.",
    optional: true,
};

const BROWSER_READ_TOOLS: [&str; 5] = [
    "browser_tabs",
    "browser_snapshot",
    "browser_screenshot",
    "browser_console",
    "browser_network",
];
const BROWSER_WRITE_TOOLS: [&str; 3] = ["browser_navigate", "browser_action", "browser_evaluate"];
const WINDOWS_READ_METHODS: [&str; 4] = [
    "list_windows",
    "get_window",
    "list_apps",
    "get_window_state",
];
const WINDOWS_INPUT_METHODS: [&str; 9] = [
    "launch_app",
    "click",
    "press_key",
    "type_text",
    "scroll",
    "set_value",
    "drag",
    "perform_secondary_action",
    "activate_window",
];

/// The tunnel-side facts about one connector in the running generation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SurfaceReport {
    pub state: SurfaceConnectionState,
    pub detail: String,
    pub public_url: Option<String>,
}

impl Default for SurfaceReport {
    fn default() -> Self {
        Self {
            state: SurfaceConnectionState::Off,
            detail: String::new(),
            public_url: None,
        }
    }
}

/// One value per surface, indexed by [`SurfaceId`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct PerSurface<T>([T; 3]);

impl<T> PerSurface<T> {
    fn slot(id: SurfaceId) -> usize {
        match id {
            SurfaceId::Core => 0,
            SurfaceId::Desktop => 1,
            SurfaceId::Plugins => 2,
        }
    }

    pub fn get(&self, id: SurfaceId) -> &T {
        &self.0[Self::slot(id)]
    }

    pub fn set(&mut self, id: SurfaceId, value: T) {
        self.0[Self::slot(id)] = value;
    }
}

/// When a surface last saw a request and a tool call, from the kernel's clocks.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Clocks {
    pub request_at: Option<u64>,
    pub tool_call_at: Option<u64>,
}

/// Everything a card is built from.
pub(crate) struct View<'a> {
    pub grants: &'a Grants,
    pub platform: Platform,
    pub connector_suffix: Option<&'a str>,
    /// The running endpoint's URLs; `None` while no endpoint runs.
    pub urls: Option<&'a SurfaceUrls>,
    pub reports: &'a PerSurface<SurfaceReport>,
    pub clocks: &'a PerSurface<Clocks>,
}

/// The cards in Setup order. A report is shown only while an endpoint runs for it, so a
/// finished disconnect can never show a live card or a dead tunnel URL.
pub(crate) fn describe(view: &View<'_>) -> Vec<SurfaceStatus> {
    SurfaceId::ALL
        .iter()
        .map(|&id| {
            let definition = definition(id);
            let available = available(id, view.grants, view.platform);
            let report = view.reports.get(id);
            let running = view.urls.is_some();
            let clocks = view.clocks.get(id);
            SurfaceStatus {
                id,
                connector_name: cos_types::connectors::connector_name(id, view.connector_suffix),
                // No learned ChatGPT name exists until connector identity is ported.
                chatgpt_name: Some(None),
                description: definition.description.to_owned(),
                card_summary: definition.card_summary.to_owned(),
                optional: definition.optional,
                available,
                local_url: view.urls.map(|urls| urls.of(id).to_owned()),
                public_url: if running {
                    report.public_url.clone()
                } else {
                    None
                },
                tools: tools(id, view.grants, view.platform)
                    .into_iter()
                    .map(str::to_owned)
                    .collect(),
                state: if available && running {
                    report.state
                } else {
                    SurfaceConnectionState::Off
                },
                detail: match (available, running) {
                    (true, true) => report.detail.clone(),
                    (true, false) => String::new(),
                    (false, _) => unavailable_detail(id, view.platform).to_owned(),
                },
                last_request_at: clocks.request_at,
                last_tool_call_at: clocks.tool_call_at,
                // Earlier-run proof needs a tunnel key, which a manual or cloudflared
                // connection does not have.
                proof: Some(None),
            }
        })
        .collect()
}

/// Whether a surface has anything to offer (`surfaceIsUseful`). Core always does, so its
/// connector identity survives a moment with every permission off.
pub(crate) fn available(id: SurfaceId, grants: &Grants, platform: Platform) -> bool {
    let caps = grants.capabilities;
    match id {
        SurfaceId::Desktop => {
            caps.any_of(&[Capability::Screen, Capability::Control])
                || (desktop_automation(platform)
                    && caps.any_of(&[Capability::ClipboardRead, Capability::ClipboardWrite]))
        }
        SurfaceId::Core | SurfaceId::Plugins => true,
    }
}

/// Whether the capabilities in effect need an approved folder
/// (`requiresApprovedFilesystemRoot`). Only screen, control and clipboard are rootless;
/// command still needs a root for its starting folder.
pub(crate) fn requires_root(grants: &Grants) -> bool {
    const ROOTLESS: [Capability; 4] = [
        Capability::Screen,
        Capability::Control,
        Capability::ClipboardRead,
        Capability::ClipboardWrite,
    ];
    Capability::ALL.iter().any(|capability| {
        !ROOTLESS.contains(capability) && grants.capabilities.contains(*capability)
    })
}

/// Windows has native desktop tools; macOS keeps `observe` and `computer`.
fn desktop_automation(platform: Platform) -> bool {
    matches!(platform, Platform::Windows | Platform::Macos)
}

/// The tools a surface would advertise now, for the card's "what you get" list.
fn tools(id: SurfaceId, grants: &Grants, platform: Platform) -> Vec<&'static str> {
    let caps = grants.capabilities;
    let on = |capability| caps.contains(capability);
    let mut tools = Vec::new();
    match id {
        SurfaceId::Core => {
            if caps.any_of(&[Capability::Read, Capability::Browse, Capability::Metadata]) {
                tools.push("read");
            }
            if on(Capability::Read) {
                tools.push("view_image");
            }
            if !on(Capability::Command) && on(Capability::Search) {
                tools.push("find");
            }
            if caps.any_of(&[
                Capability::Create,
                Capability::Edit,
                Capability::Move,
                Capability::DeleteFile,
            ]) {
                tools.push("apply_patch");
            }
            if on(Capability::Command) {
                tools.extend(["exec_command", "write_stdin"]);
            }
            if grants.features.contains(Feature::SessionRecording) {
                tools.push("update_plan");
            }
            if grants.features.contains(Feature::MultiAgent) {
                tools.push("agents");
            }
        }
        SurfaceId::Desktop => {
            if on(Capability::Screen) {
                tools.extend(BROWSER_READ_TOOLS);
            }
            if on(Capability::Control) {
                tools.extend(BROWSER_WRITE_TOOLS);
            }
            match platform {
                Platform::Windows => {
                    if on(Capability::Screen) {
                        tools.extend(WINDOWS_READ_METHODS);
                    }
                    if on(Capability::Control) {
                        tools.extend(WINDOWS_INPUT_METHODS);
                    }
                    if on(Capability::ClipboardRead) {
                        tools.push("read_clipboard");
                    }
                    if on(Capability::ClipboardWrite) {
                        tools.push("write_clipboard");
                    }
                }
                Platform::Macos => {
                    if on(Capability::Screen) {
                        tools.push("observe");
                    }
                    if caps.any_of(&[
                        Capability::Control,
                        Capability::ClipboardRead,
                        Capability::ClipboardWrite,
                    ]) {
                        tools.push("computer");
                    }
                }
                Platform::Linux => {}
            }
        }
        // The plugin manager is not ported yet, and with no plugin installed it lists none.
        SurfaceId::Plugins => {}
    }
    tools
}

fn unavailable_detail(id: SurfaceId, platform: Platform) -> &'static str {
    match id {
        SurfaceId::Desktop if !desktop_automation(platform) => {
            "Enable screen or input access for browser control through the companion extension. Native desktop input requires Windows or supported macOS."
        }
        SurfaceId::Desktop => {
            "Turn on \"See the screen\", \"Control mouse and keyboard\" or a clipboard permission to use this connector."
        }
        SurfaceId::Core | SurfaceId::Plugins => "",
    }
}

/// A shared-origin transport (cloudflared, a manual reverse proxy) publishes every surface at
/// its own path on one public origin. Keeps the public URL's query and fragment, as `URL`
/// does when only `pathname` is replaced.
pub(crate) fn sibling_public_url(public_url: Option<&str>, local_url: &str) -> Option<String> {
    let public_url = public_url?;
    let path_of = |url: &str| -> Option<usize> {
        let after_scheme = url.find("://")? + 3;
        Some(
            url[after_scheme..]
                .find('/')
                .map_or(url.len(), |at| after_scheme + at),
        )
    };
    let origin_end = path_of(public_url)?;
    let local_path_start = path_of(local_url)?;
    let local_path = &local_url[local_path_start..];
    let local_path = local_path
        .find(['?', '#'])
        .map_or(local_path, |at| &local_path[..at]);
    let rest = &public_url[origin_end..];
    let suffix = rest.find(['?', '#']).map_or("", |at| &rest[at..]);
    let path = if local_path.is_empty() {
        "/"
    } else {
        local_path
    };
    Some(format!("{}{path}{suffix}", &public_url[..origin_end]))
}
