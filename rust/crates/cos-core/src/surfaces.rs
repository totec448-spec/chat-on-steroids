//! Which tool objects each surface can list. Listing order and rules are the kernel's.

use std::sync::Arc;

use cos_agents::Agents;
use cos_browser_control::BrowserControl;
use cos_continuation::finish::Finish;
use cos_exec::ExecManager;
use cos_files::FileToolsDeps;
use cos_sessions::SessionStore;
use cos_store::Logger;
use cos_tools::{SurfaceId, SurfaceTools};

const SURFACES: [SurfaceId; 3] = [SurfaceId::Core, SurfaceId::Desktop, SurfaceId::Plugins];

pub(crate) fn assemble(
    files: FileToolsDeps,
    sessions: &SessionStore,
    exec: &Arc<ExecManager>,
    browser: &BrowserControl,
    finish: &Finish,
    agents: &Agents,
    logger: &Logger,
) -> SurfaceTools {
    let mut tools = SurfaceTools::default();
    for tool in cos_files::tools(files) {
        tools.add(SurfaceId::Core, tool);
    }
    tools.add(SurfaceId::Core, cos_patch::tool());
    for tool in exec.tools() {
        tools.add(SurfaceId::Core, tool);
    }
    tools.add(SurfaceId::Core, sessions.plan_tool());
    // The Window2 and clipboard tools. The desktop thread starts on their first call.
    #[cfg(windows)]
    for tool in cos_windows_desktop::tools(&cos_windows_desktop::Desktop::new()) {
        tools.add(SurfaceId::Desktop, tool);
    }
    // The browser tools act through the extension, so every platform has them.
    for tool in cos_browser_control::tools(browser) {
        tools.add(SurfaceId::Desktop, tool);
    }
    tools.add(SurfaceId::Core, finish.tool());
    tools.add(SurfaceId::Core, agents.tool());
    // G4.3 serves the Plugins surface's dynamic tools.
    for surface in SURFACES {
        tools.add(surface, cos_codemode::tool());
    }
    publishable(tools, logger)
}

/// Drops every surface that registers a tool with no recorded declaration. The kernel would
/// silently leave that tool out of the list, and a surface that is missing a tool is worse
/// than no surface.
fn publishable(tools: SurfaceTools, logger: &Logger) -> SurfaceTools {
    let undeclared = tools.undeclared();
    if undeclared.is_empty() {
        return tools;
    }
    let mut kept = SurfaceTools::default();
    for surface in SURFACES {
        let missing: Vec<&str> = undeclared
            .iter()
            .filter(|(owner, _)| *owner == surface)
            .map(|(_, name)| *name)
            .collect();
        if missing.is_empty() {
            for tool in tools.of(surface) {
                kept.add(surface, tool.clone());
            }
        } else {
            logger.error(&format!(
                "MCP surface {} is not published: no recorded declaration for {}",
                surface.as_str(),
                missing.join(", ")
            ));
        }
    }
    kept
}

#[cfg(test)]
mod tests {
    use cos_browser_control::{BrowserControlDeps, NoChatProof};
    use cos_exec::{ExecDeps, FreshProcess};
    use cos_store::config::recovery_config;
    use cos_store::{AppPaths, Platform};
    use cos_tools::GrantEnv;

    use super::*;

    fn names(tools: &SurfaceTools, surface: SurfaceId) -> Vec<&'static str> {
        let mut names: Vec<_> = tools
            .of(surface)
            .iter()
            .map(|tool| tool.spec().name)
            .collect();
        names.sort_unstable();
        names
    }

    fn assembled(logger: &Logger) -> SurfaceTools {
        let profile =
            std::env::temp_dir().join(format!("cos-core-surfaces-{}", std::process::id()));
        let sessions = SessionStore::open(&AppPaths::at(&profile), logger.clone());
        let exec = ExecManager::new(ExecDeps {
            launcher: Arc::new(FreshProcess),
        });
        let (_config, receiver) = tokio::sync::watch::channel(Arc::new(recovery_config()));
        let browser = BrowserControl::new(BrowserControlDeps {
            config: receiver.clone(),
            env: GrantEnv {
                skills_dir: profile.join("skills"),
                platform: Platform::current(),
            },
            proof: Arc::new(NoChatProof),
            wake: Arc::new(|| {}),
        });
        let finish = cos_continuation::finish::Finish::new(cos_continuation::finish::FinishDeps {
            sessions: sessions.clone(),
            config: tokio::sync::watch::channel(Arc::new(recovery_config())).1,
            inputs: Arc::new(cos_continuation::finish::NoFinishInputs),
            chats: Arc::new(cos_continuation::finish::NoFinishChats),
            notifier: None,
            clock: cos_continuation::system_clock(),
        });
        let agents = crate::agents::build(
            &cos_store::DurableStore::new(profile.join("state"), logger.clone()),
            receiver,
            Arc::default(),
            logger,
        );
        assemble(
            FileToolsDeps::default(),
            &sessions,
            &exec,
            &browser,
            &finish,
            &agents,
            logger,
        )
    }

    #[test]
    fn every_registered_tool_has_a_declaration() {
        let logger = Logger::with_clock(|| 0, false);
        let tools = assembled(&logger);
        assert_eq!(tools.undeclared(), Vec::new());
        assert!(names(&tools, SurfaceId::Core).contains(&"update_plan"));
        assert!(names(&tools, SurfaceId::Core).contains(&"agents"));
        let desktop: &[&str] = if cfg!(windows) {
            &[
                "activate_window",
                "browser_action",
                "browser_console",
                "browser_evaluate",
                "browser_navigate",
                "browser_network",
                "browser_screenshot",
                "browser_snapshot",
                "browser_tabs",
                "click",
                "drag",
                "exec",
                "get_window",
                "get_window_state",
                "launch_app",
                "list_apps",
                "list_windows",
                "perform_secondary_action",
                "press_key",
                "read_clipboard",
                "scroll",
                "set_value",
                "type_text",
                "write_clipboard",
            ]
        } else {
            &[
                "browser_action",
                "browser_console",
                "browser_evaluate",
                "browser_navigate",
                "browser_network",
                "browser_screenshot",
                "browser_snapshot",
                "browser_tabs",
                "exec",
            ]
        };
        assert_eq!(names(&tools, SurfaceId::Desktop), desktop);
        assert!(logger.entries().is_empty(), "{:?}", logger.entries());
    }

    #[test]
    fn a_surface_with_an_undeclared_tool_is_not_published() {
        let logger = Logger::with_clock(|| 0, false);
        let mut tools = assembled(&logger);
        let core = names(&tools, SurfaceId::Core);
        tools.add(SurfaceId::Desktop, cos_patch::tool());

        let published = publishable(tools, &logger);

        assert_eq!(names(&published, SurfaceId::Core), core);
        assert_eq!(names(&published, SurfaceId::Desktop), Vec::<&str>::new());
        assert_eq!(names(&published, SurfaceId::Plugins), ["exec"]);
        let lines: Vec<String> = logger
            .entries()
            .into_iter()
            .map(|entry| entry.message)
            .collect();
        assert_eq!(
            lines,
            ["MCP surface desktop is not published: no recorded declaration for apply_patch"]
        );
    }
}
