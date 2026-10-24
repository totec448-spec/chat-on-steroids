//! The tray icon and its menu (`refreshTray` in `src/main/index.ts`): the status line, Open,
//! Connect or Disconnect, and Quit. The built-in browser's Show/Hide item is gone with the
//! built-in browser (standing order 12).

use cos_types::app_state::ConnectionStatus;
use gpui::{App, Entity, Global};
use tokio::sync::mpsc;
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

use crate::app::{WINDOW_TITLE, t};
use crate::binding::Snapshot;
use crate::status::{TrayStatus, tray_status};
use crate::tray_image::tray_rgba;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayCommand {
    Open,
    /// Connect, or disconnect while running: the item's label follows the status.
    ToggleConnection,
    Quit,
}

const OPEN: &str = "open";
const TOGGLE: &str = "toggle";
const QUIT: &str = "quit";

struct Tray {
    icon: TrayIcon,
    status: MenuItem,
    open: MenuItem,
    toggle: MenuItem,
    quit: MenuItem,
    shown: Option<(TrayStatus, String)>,
    /// The automation menu borrows the icon for its whole modal loop; updates wait for it.
    menu_open: bool,
}
impl Global for Tray {}

/// Builds the tray icon and returns the commands its menu and clicks send.
pub fn start(
    connection: &Entity<Snapshot<ConnectionStatus>>,
    cx: &mut App,
) -> mpsc::UnboundedReceiver<TrayCommand> {
    let (send, commands) = mpsc::unbounded_channel();
    let Some(tray) = build() else {
        return commands;
    };
    cx.set_global(tray);
    refresh(connection, cx);
    let watched = connection.clone();
    cx.observe(connection, move |_, cx| refresh(&watched, cx))
        .detach();

    let menu_send = send.clone();
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let command = match event.id.0.as_str() {
            OPEN => TrayCommand::Open,
            TOGGLE => TrayCommand::ToggleConnection,
            QUIT => TrayCommand::Quit,
            _ => return,
        };
        let _ = menu_send.send(command);
    }));
    let click_send = send;
    TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            let _ = click_send.send(TrayCommand::Open);
        }
    }));
    commands
}

fn build() -> Option<Tray> {
    let status = MenuItem::new("", false, None);
    let open = MenuItem::with_id(OPEN, "Open", true, None);
    let toggle = MenuItem::with_id(TOGGLE, "Connect", true, None);
    let quit = MenuItem::with_id(QUIT, "Quit", true, None);
    let menu = Menu::new();
    menu.append_items(&[
        &status,
        &PredefinedMenuItem::separator(),
        &open,
        &toggle,
        &PredefinedMenuItem::separator(),
        &quit,
    ])
    .ok()?;
    let icon = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_menu_on_left_click(false)
        .with_tooltip(WINDOW_TITLE)
        .with_icon(status_icon(false)?)
        .build()
        .ok()?;
    Some(Tray {
        icon,
        status,
        open,
        toggle,
        quit,
        shown: None,
        menu_open: false,
    })
}

fn status_icon(running: bool) -> Option<Icon> {
    let image = tray_rgba(running, 2);
    Icon::from_rgba(image.rgba, image.size, image.size).ok()
}

pub fn refresh(connection: &Entity<Snapshot<ConnectionStatus>>, cx: &mut App) {
    let status = tray_status(connection.read(cx).state);
    let label = t(cx, status.label).to_string();
    let texts = [
        t(cx, "Open"),
        t(
            cx,
            if status.running {
                "Disconnect"
            } else {
                "Connect"
            },
        ),
        t(cx, "Quit"),
    ];
    let Some(tray) = cx.try_global::<Tray>().filter(|tray| !tray.menu_open) else {
        return;
    };
    let key = (
        status,
        format!("{label}|{}|{}|{}", texts[0], texts[1], texts[2]),
    );
    if tray.shown.as_ref() == Some(&key) {
        return;
    }
    tray.status.set_text(&label);
    tray.open.set_text(&texts[0]);
    tray.toggle.set_text(&texts[1]);
    tray.quit.set_text(&texts[2]);
    if tray.shown.as_ref().map(|(shown, _)| shown.running) != Some(status.running) {
        let _ = tray.icon.set_icon(status_icon(status.running));
    }
    let _ = tray
        .icon
        .set_tooltip(Some(format!("{WINDOW_TITLE} — {label}")));
    cx.global_mut::<Tray>().shown = Some(key);
}

/// Opens the tray menu at the icon, as a right-click does. The returned call blocks in the
/// menu's own loop, so it must run outside any GPUI update; call [`menu_closed`] after it.
pub fn menu_opener(cx: &mut App) -> Option<impl FnOnce() + use<>> {
    if !cx.has_global::<Tray>() {
        return None;
    }
    let tray = cx.global_mut::<Tray>();
    tray.menu_open = true;
    let icon = tray.icon.clone();
    Some(move || icon.show_menu())
}

pub fn menu_closed(connection: &Entity<Snapshot<ConnectionStatus>>, cx: &mut App) {
    if cx.has_global::<Tray>() {
        cx.global_mut::<Tray>().menu_open = false;
    }
    refresh(connection, cx);
}
