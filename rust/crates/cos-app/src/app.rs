//! The GPUI side of the process: theme and language from the config, the live snapshots the
//! views read, the main window's life (open, hide to the tray, show again) and the tray.

use cos_core::AppCore;
use cos_store::Durable;
use cos_types::config::{Config, Theme};
use gpui::{
    App, AppContext as _, Bounds, Global, KeyBinding, SharedString, TitlebarOptions, WindowBounds,
    WindowHandle, WindowOptions, point, px, size,
};
use gpui_component::{Root, TitleBar, theme::ThemeMode};
use tokio::sync::mpsc;

use crate::appearance::Appearance;
use crate::binding::Models;
use crate::i18n::{self, Catalog};
use crate::placement::{self, Placement, Rect};
use crate::platform::{self, NativeWindow};
use crate::shell::{self, Shell};
use crate::status::tray_status;
use crate::trace::Trace;
use crate::tray::{self, TrayCommand};

pub const WINDOW_TITLE: &str = "Chat On Steroids";
/// The launch flag that starts the app to the tray (login start).
pub const BACKGROUND: &str = "--background";
/// Asks the running instance to open its tray menu, for UI automation. Honored only when the
/// running instance was started with `COS_APP_AUTOMATION=1`.
pub const SHOW_TRAY_MENU: &str = "--show-tray-menu";

/// What the binary hands the UI after the Core has started.
pub struct Startup {
    pub core: AppCore,
    pub background: bool,
    pub launches: Option<mpsc::UnboundedReceiver<Vec<String>>>,
    /// `state/window-bounds.json`.
    pub bounds: Durable<Placement>,
    pub trace: Trace,
}

/// The interface language in effect.
pub struct Strings(pub Catalog);
impl Global for Strings {}

/// Translates an English source text into the interface language.
pub fn t(cx: &App, source: &str) -> SharedString {
    cx.global::<Strings>().0.t(source).into()
}

pub fn t_args(cx: &App, source: &str, args: &[&str]) -> SharedString {
    cx.global::<Strings>().0.t_args(source, args).into()
}

/// The colors and type in effect.
pub struct Look(pub Appearance);
impl Global for Look {}

/// The main window, when one is open.
#[derive(Default)]
struct MainWindow {
    window: Option<(WindowHandle<Root>, Option<NativeWindow>)>,
}
impl Global for MainWindow {}

struct Ledgers {
    bounds: Durable<Placement>,
    minimize_to_tray: bool,
}
impl Global for Ledgers {}
impl Global for Trace {}

gpui::actions!(cos_app, [ToggleFullscreen]);

pub fn run(startup: Startup) {
    let Startup {
        core,
        background,
        launches,
        bounds,
        trace,
    } = startup;
    trace.mark("gpui starting");
    let automation = std::env::var("COS_APP_AUTOMATION").is_ok_and(|value| value == "1");
    gpui_platform::application()
        .with_assets(gpui_kit_assets::Assets)
        .run(move |cx: &mut App| {
            trace.mark("platform ready");
            gpui_component::init(cx);
            cx.bind_keys([KeyBinding::new("f11", ToggleFullscreen, None)]);
            let models = Models::bind(core, cx);
            let config = models.settings.read(cx).shared();
            apply_config(&config, cx);
            cx.set_global(Ledgers {
                bounds,
                minimize_to_tray: config.ui.minimize_to_tray,
            });
            cx.set_global(MainWindow::default());
            cx.set_global(trace);
            cx.observe(&models.settings, |settings, cx| {
                let config = settings.read(cx).shared();
                cx.global_mut::<Ledgers>().minimize_to_tray = config.ui.minimize_to_tray;
                apply_config(&config, cx);
                cx.refresh_windows();
            })
            .detach();

            if !background {
                show_main(&models, cx);
            }
            let commands = tray::start(&models.connection, cx);
            listen_tray(commands, models.clone(), cx);
            if let Some(launches) = launches {
                listen_launches(launches, models, automation, cx);
            }
        });
}

fn apply_config(config: &Config, cx: &mut App) {
    let language = config
        .ui
        .language
        .unwrap_or_else(|| i18n::system_language(&i18n::preferred_languages()));
    let current = cx
        .try_global::<Strings>()
        .map(|strings| strings.0.language());
    if current != Some(language) {
        cx.set_global(Strings(Catalog::load(language)));
    }
    let look = Appearance::resolve(config.ui.theme, config.ui.appearance.as_ref());
    if cx.try_global::<Look>().map(|current| current.0) != Some(look) {
        shell::apply_theme(&look, cx);
        cx.set_global(Look(look));
    }
}

/// Shows the main window, opening it if there is none.
pub fn show_main(models: &Models, cx: &mut App) {
    let open = cx.global::<MainWindow>().window;
    if let Some((handle, native)) = open
        && handle.update(cx, |_, _, _| ()).is_ok()
    {
        if let Some(native) = native {
            // Activation messages arrive synchronously, so this runs outside the current update.
            cx.foreground_executor()
                .spawn(async move { platform::reveal(native) })
                .detach();
        }
        return;
    }
    open_main(models, cx);
}

fn open_main(models: &Models, cx: &mut App) {
    let saved = cx.global::<Ledgers>().bounds.read();
    let saved = saved.as_ref().and_then(placement::parse);
    let primary = cx
        .primary_display()
        .map(|display| rect(display.visible_bounds()))
        .unwrap_or(Rect {
            x: 0,
            y: 0,
            width: 1280,
            height: 800,
        });
    let areas: Vec<Rect> = cx
        .displays()
        .iter()
        .map(|display| rect(display.visible_bounds()))
        .collect();
    let layout = placement::layout(primary, &areas, saved);
    let bounds = Bounds {
        origin: point(px(layout.bounds.x as f32), px(layout.bounds.y as f32)),
        size: size(
            px(layout.bounds.width as f32),
            px(layout.bounds.height as f32),
        ),
    };
    let options = WindowOptions {
        window_bounds: Some(if layout.maximized {
            WindowBounds::Maximized(bounds)
        } else {
            WindowBounds::Windowed(bounds)
        }),
        titlebar: Some(TitlebarOptions {
            title: Some(WINDOW_TITLE.into()),
            ..TitleBar::title_bar_options()
        }),
        window_min_size: Some(size(
            px(layout.min_width as f32),
            px(layout.min_height as f32),
        )),
        ..TitleBar::window_options()
    };
    let models = models.clone();
    cx.global::<Trace>().mark("window opening");
    let trace = cx.global::<Trace>().clone();
    let opened = cx.open_window(options, move |window, cx| {
        window.set_window_title(WINDOW_TITLE);
        trace.mark("window created");
        window.on_next_frame(move |_, _| trace.mark("first frame"));
        let view = cx.new(|cx| Shell::new(models, window, cx));
        cx.new(|cx| Root::new(view, window, cx))
    });
    let Ok(handle) = opened else {
        return;
    };
    let native = handle
        .update(cx, |_, window, cx| {
            window.on_window_should_close(cx, |window, cx| {
                if !cx.global::<Ledgers>().minimize_to_tray {
                    return true;
                }
                if let Some(native) = NativeWindow::of(window) {
                    platform::hide(native);
                }
                false
            });
            NativeWindow::of(window)
        })
        .ok()
        .flatten();
    cx.global_mut::<MainWindow>().window = Some((handle, native));
    let closed = handle.window_id();
    cx.on_window_closed(move |cx, id| {
        // Closing the window without the tray option quits, as on Windows and Linux before.
        if id == closed {
            cx.global_mut::<MainWindow>().window = None;
            cx.quit();
        }
    })
    .detach();
}

fn rect(bounds: Bounds<gpui::Pixels>) -> Rect {
    Rect {
        x: f32::from(bounds.origin.x).round() as i64,
        y: f32::from(bounds.origin.y).round() as i64,
        width: f32::from(bounds.size.width).round() as i64,
        height: f32::from(bounds.size.height).round() as i64,
    }
}

/// Remembers the normal rectangle while the window is used, as `trackNormalWindowBounds` does:
/// a maximized window keeps its normal rectangle, and minimized or full-screen geometry is
/// never saved.
pub fn remember_bounds(window: &gpui::Window, cx: &App) {
    if window.is_fullscreen() || NativeWindow::of(window).is_some_and(platform::is_minimized) {
        return;
    }
    let (bounds, maximized) = match window.window_bounds() {
        WindowBounds::Windowed(bounds) => (bounds, false),
        WindowBounds::Maximized(bounds) => (bounds, true),
        WindowBounds::Fullscreen(_) => return,
    };
    let placement = Placement {
        bounds: rect(bounds),
        maximized,
    };
    if placement.bounds.width > 0 && placement.bounds.height > 0 {
        // Queued; the ledger's own thread writes it after the burst settles.
        let _ = cx.global::<Ledgers>().bounds.write_soon(&placement);
    }
}

fn listen_tray(mut commands: mpsc::UnboundedReceiver<TrayCommand>, models: Models, cx: &mut App) {
    cx.spawn(async move |cx| {
        while let Some(command) = commands.recv().await {
            cx.update(|cx| match command {
                TrayCommand::Open => show_main(&models, cx),
                TrayCommand::ToggleConnection => {
                    let running = tray_status(models.connection.read(cx).state).running;
                    connection(&models.core, !running);
                }
                TrayCommand::Quit => cx.quit(),
            });
        }
    })
    .detach();
}

/// Starts or stops the connection. The Core reports the outcome through the status snapshot.
pub fn connection(core: &AppCore, connect: bool) {
    // Fire and forget: the command is queued on the Core's runtime.
    drop(core.spawn(move |domains| async move {
        if connect {
            domains.connection.connect();
        } else {
            domains.connection.disconnect();
        }
    }));
}

fn listen_launches(
    mut launches: mpsc::UnboundedReceiver<Vec<String>>,
    models: Models,
    automation: bool,
    cx: &mut App,
) {
    cx.spawn(async move |cx| {
        while let Some(argv) = launches.recv().await {
            if automation && argv.iter().any(|arg| arg == SHOW_TRAY_MENU) {
                // The menu runs its own modal loop, so it opens outside any GPUI update.
                if let Some(menu) = cx.update(tray::menu_opener) {
                    menu();
                    cx.update(|cx| tray::menu_closed(&models.connection, cx));
                }
                continue;
            }
            if !argv.iter().any(|arg| arg == BACKGROUND) {
                cx.update(|cx| show_main(&models, cx));
            }
        }
    })
    .detach();
}

/// The theme mode GPUI components draw with.
pub fn theme_mode(theme: Theme) -> ThemeMode {
    match theme {
        Theme::Dark => ThemeMode::Dark,
        Theme::Light => ThemeMode::Light,
    }
}
