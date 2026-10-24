//! The app shell: title bar, sidebar (session list, settings navigation, connection capsule)
//! and the main area, laid out like `src/renderer/index.html`.

use cos_types::ids::SessionId;
use gpui::{
    App, ClickEvent, Context, Entity, FocusHandle, Hsla, InteractiveElement as _, IntoElement,
    ParentElement as _, Pixels, Render, Role, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window, div, prelude::FluentBuilder as _, px, uniform_list,
};
use gpui_component::button::{Button, ButtonVariants as _};
use gpui_component::{
    Icon, IconName, Selectable as _, Sizable as _, Theme, TitleBar, h_flex, v_flex,
};

use crate::app::{self, Look, ToggleFullscreen, t, t_args};
use crate::appearance::{Appearance, Rgb, Tokens};
use crate::binding::{Models, Timeline, TimelineState};
use crate::status::{self, Tone};

/// The Electron renderer is zoomed by `UI_BASE_ZOOM` (1.17); CSS pixels are scaled the same way.
const ZOOM: f32 = 1.17;
/// The sidebar lists this many sessions, as the TypeScript store does (`MAX_LISTED_SESSIONS`).
pub const LISTED_SESSIONS: usize = 200;

fn z(css: f32) -> Pixels {
    px(css * ZOOM)
}

/// The settings pages (`data-tab` in `index.html`), in navigation order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tab {
    Home,
    General,
    Usage,
    Setup,
    Settings,
    Appearance,
    Activity,
}

impl Tab {
    pub const ALL: [Tab; 7] = [
        Tab::Home,
        Tab::General,
        Tab::Usage,
        Tab::Setup,
        Tab::Settings,
        Tab::Appearance,
        Tab::Activity,
    ];

    /// The `data-tab` value, used as the automation id.
    pub fn id(self) -> &'static str {
        match self {
            Tab::Home => "home",
            Tab::General => "general",
            Tab::Usage => "usage",
            Tab::Setup => "setup",
            Tab::Settings => "settings",
            Tab::Appearance => "appearance",
            Tab::Activity => "activity",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Tab::Home => "Workspace",
            Tab::General => "General",
            Tab::Usage => "Usage",
            Tab::Setup => "Setup",
            Tab::Settings => "Agents & automation",
            Tab::Appearance => "Appearance",
            Tab::Activity => "Activity",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Screen {
    Chat,
    Settings(Tab),
}

pub struct Shell {
    models: Models,
    /// The chat picked in the list, followed while it stays picked.
    timeline: Option<Entity<Timeline>>,
    screen: Screen,
    sidebar_open: bool,
    popover_open: bool,
    focus: FocusHandle,
}

impl Shell {
    pub fn new(models: Models, window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.observe(&models.sessions, |_, _, cx| cx.notify())
            .detach();
        cx.observe(&models.connection, |_, _, cx| cx.notify())
            .detach();
        cx.observe(&models.bridge, |_, _, cx| cx.notify()).detach();
        cx.observe_window_bounds(window, |_, window, cx| app::remember_bounds(window, cx))
            .detach();
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        Self {
            models,
            timeline: None,
            screen: Screen::Chat,
            sidebar_open: true,
            popover_open: false,
            focus,
        }
    }

    fn show(&mut self, screen: Screen, cx: &mut Context<Self>) {
        self.screen = screen;
        self.popover_open = false;
        cx.notify();
    }

    fn pick(&mut self, session: SessionId, cx: &mut Context<Self>) {
        if self
            .timeline
            .as_ref()
            .is_some_and(|timeline| timeline.read(cx).session() == &session)
        {
            return;
        }
        let timeline = Timeline::open(&self.models.core, session, cx);
        cx.observe(&timeline, |_, _, cx| cx.notify()).detach();
        self.timeline = Some(timeline);
        cx.notify();
    }

    fn capsule_clicked(&mut self, cx: &mut Context<Self>) {
        let state = self.models.connection.read(cx).state;
        if state == cos_types::app_state::ConnectionState::Disconnected {
            // It says Connect, so it connects.
            self.popover_open = false;
            app::connection(&self.models.core, true);
        } else {
            self.popover_open = !self.popover_open;
        }
        cx.notify();
    }
}

impl Render for Shell {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let look = cx.global::<Look>().0;
        let page = look.page;
        v_flex()
            .id("app")
            .role(Role::Application)
            .aria_label(app::WINDOW_TITLE)
            .track_focus(&self.focus)
            .on_action(|_: &ToggleFullscreen, window, _| window.toggle_fullscreen())
            .size_full()
            .bg(c(page.page))
            .text_color(c(page.ink))
            .text_size(z(14.) * look.text_scale)
            .when_some(look.font.family(), |this, family| this.font_family(family))
            .child(self.title_bar(&look, cx))
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .items_stretch()
                    .when(self.sidebar_open, |this| {
                        this.child(self.sidebar(&look, cx))
                    })
                    .child(self.main(&look, cx)),
            )
    }
}

impl Shell {
    fn title_bar(&self, look: &Appearance, cx: &mut Context<Self>) -> impl IntoElement {
        let bar = look.sidebar;
        let open = self.sidebar_open;
        TitleBar::new()
            .bg(c(bar.page))
            .border_color(c(bar.page))
            .child(
                Button::new("sidebar-toggle")
                    .ghost()
                    .small()
                    .icon(IconName::PanelLeft)
                    .text_color(c(bar.soft))
                    .accessibility_id("sidebarToggle")
                    .accessibility_label(t(cx, "Toggle sidebar"))
                    .tooltip(t(cx, "Toggle sidebar"))
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.sidebar_open = !open;
                        cx.notify();
                    })),
            )
    }

    fn sidebar(&self, look: &Appearance, cx: &mut Context<Self>) -> impl IntoElement {
        let side = look.sidebar;
        v_flex()
            .id("sidebar")
            .role(Role::Navigation)
            .aria_label(t(cx, "Chat list"))
            .relative()
            .w(z(272.))
            .flex_none()
            .h_full()
            .bg(c(side.page))
            .text_color(c(side.ink))
            .px(z(12.))
            .pt(z(20.))
            .pb(z(10.))
            .child(
                div()
                    .px(z(8.))
                    .pb(z(24.))
                    .text_size(z(15.) * look.text_scale)
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .child(app::WINDOW_TITLE),
            )
            .child(match self.screen {
                Screen::Chat => self.session_list(&side, look, cx).into_any_element(),
                Screen::Settings(tab) => self.settings_nav(tab, &side, look, cx).into_any_element(),
            })
            .child(self.sidebar_bottom(&side, look, cx))
            .when(self.popover_open, |this| {
                this.child(self.connection_popover(&side, look, cx))
            })
    }

    fn session_list(
        &self,
        side: &Tokens,
        look: &Appearance,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let sessions = self.models.sessions.read(cx);
        let count = sessions.index.sessions.len().min(LISTED_SESSIONS);
        let empty = (count == 0).then(|| {
            if sessions.restored {
                t(cx, "No chats outside projects yet.")
            } else {
                t(cx, "Loading chats…")
            }
        });
        let row_height = z(30.) * look.text_scale;
        let (hover, faint) = (c(side.hover), c(side.faint));
        v_flex()
            .flex_1()
            .min_h_0()
            .child(
                div()
                    .px(z(8.))
                    .py(z(5.))
                    .text_color(faint)
                    .text_size(z(12.) * look.text_scale)
                    .child(t(cx, "Chats")),
            )
            .child(match empty {
                Some(text) => div()
                    .id("chat-list-empty")
                    .role(Role::Status)
                    .aria_label(text.clone())
                    .px(z(8.))
                    .text_color(faint)
                    .text_size(z(13.) * look.text_scale)
                    .child(text)
                    .into_any_element(),
                None => div()
                    .id("chat-list")
                    .role(Role::List)
                    .aria_label(t(cx, "Chats"))
                    .flex_1()
                    .min_h_0()
                    .child(
                        uniform_list(
                            "chat-rows",
                            count,
                            cx.processor(move |this, range: std::ops::Range<usize>, _, cx| {
                                let sessions = this.models.sessions.read(cx);
                                let picked = this
                                    .timeline
                                    .as_ref()
                                    .map(|timeline| timeline.read(cx).session().clone());
                                let now = now_ms();
                                sessions.index.sessions[range.clone()]
                                    .iter()
                                    .zip(range)
                                    .map(|(summary, index)| {
                                        let title: SharedString = if summary.title.is_empty() {
                                            t(cx, "Untitled session")
                                        } else {
                                            summary.title.clone().into()
                                        };
                                        let (when, value) = status::ago(summary.updated_at, now);
                                        let value = value.map(|value| value.to_string());
                                        let ago = t_args(
                                            cx,
                                            when,
                                            &value.iter().map(String::as_str).collect::<Vec<_>>(),
                                        );
                                        div()
                                            .id(SharedString::from(format!(
                                                "session-{}",
                                                summary.id.as_str()
                                            )))
                                            .role(Role::ListItem)
                                            .accessibility_id(format!(
                                                "session-{}",
                                                summary.id.as_str()
                                            ))
                                            .aria_label(format!("{title} · {ago}"))
                                            .aria_position_in_set(index + 1)
                                            .aria_size_of_set(count)
                                            .h(row_height)
                                            .px(z(8.))
                                            .flex()
                                            .items_center()
                                            .rounded(z(8.))
                                            .hover(move |style| style.bg(hover))
                                            .when(picked.as_ref() == Some(&summary.id), |row| {
                                                row.bg(hover).aria_selected(true)
                                            })
                                            .on_click({
                                                let id = summary.id.clone();
                                                cx.listener(move |this, _: &ClickEvent, _, cx| {
                                                    this.pick(id.clone(), cx)
                                                })
                                            })
                                            .child(div().truncate().child(title))
                                    })
                                    .collect::<Vec<_>>()
                            }),
                        )
                        .size_full(),
                    )
                    .into_any_element(),
            })
    }

    fn settings_nav(
        &self,
        selected: Tab,
        side: &Tokens,
        look: &Appearance,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let soft = c(side.soft);
        v_flex()
            .flex_1()
            .min_h_0()
            .gap(px(2.))
            .child(
                nav_button(
                    "backToChat",
                    IconName::ArrowLeft,
                    t(cx, "Back to chat"),
                    false,
                    side,
                    look,
                )
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.show(Screen::Chat, cx))),
            )
            .child(
                div()
                    .id("tabs")
                    .role(Role::TabList)
                    .aria_label(t(cx, "Settings navigation"))
                    .mt(z(10.))
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .text_color(soft)
                    .children(Tab::ALL.into_iter().map(|tab| {
                        let label = t(cx, tab.label());
                        Button::new(tab.id())
                            .ghost()
                            .role(Role::Tab)
                            .accessibility_id(format!("tab-{}", tab.id()))
                            .accessibility_label(label.clone())
                            .child(div().w_full().truncate().child(label))
                            .selected(tab == selected)
                            .h(z(38.) * look.text_scale)
                            .px(z(12.))
                            .text_size(z(13.) * look.text_scale)
                            .text_color(if tab == selected { c(side.ink) } else { soft })
                            .when(tab == selected, |this| this.bg(c(side.hover)))
                            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                                this.show(Screen::Settings(tab), cx)
                            }))
                    })),
            )
    }

    fn sidebar_bottom(
        &self,
        side: &Tokens,
        look: &Appearance,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let capsule = status::capsule(self.models.connection.read(cx));
        let status_text = t(cx, capsule.status);
        let label: SharedString = match capsule.verified_at {
            Some(at) => {
                let (when, value) = status::ago(at, now_ms());
                let value = value.map(|value| value.to_string());
                let ago = t_args(
                    cx,
                    when,
                    &value.iter().map(String::as_str).collect::<Vec<_>>(),
                );
                format!("{status_text} · {}", t_args(cx, "verified {0}", &[&ago])).into()
            }
            None => status_text,
        };
        let dot = match capsule.tone {
            Tone::Connected => c(side.green),
            Tone::Offline | Tone::Error => c(side.red),
            _ => c(side.faint),
        };
        let words = capsule.words.map(|words| t(cx, words));
        let settings_selected = matches!(self.screen, Screen::Settings(_));
        h_flex()
            .pt(z(10.))
            .gap(z(8.))
            .justify_between()
            .child(
                nav_button(
                    "workspaceSettings",
                    IconName::Settings,
                    t(cx, "Settings"),
                    settings_selected,
                    side,
                    look,
                )
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                    let next = match this.screen {
                        Screen::Chat => Screen::Settings(Tab::Home),
                        settings => settings,
                    };
                    this.show(next, cx)
                })),
            )
            .child(
                // A button, so the capsule takes keyboard focus like the rest of the sidebar.
                Button::new("sidebarConnection")
                    .ghost()
                    .accessibility_id("sidebarConnection")
                    .accessibility_label(label)
                    .h(z(36.))
                    .min_w(z(36.))
                    .px(z(12.))
                    .rounded(z(9.))
                    .border_1()
                    .border_color(c(if words.is_some() {
                        side.edge
                    } else {
                        side.line
                    }))
                    .text_size(z(13.) * look.text_scale)
                    .text_color(c(if capsule.tone == Tone::Busy {
                        side.soft
                    } else {
                        side.ink
                    }))
                    .child(
                        h_flex()
                            .gap(z(8.))
                            .when(capsule.dot, |this| {
                                this.child(div().size(z(8.)).rounded_full().bg(dot))
                            })
                            .when_some(words, |this, words| {
                                this.child(div().whitespace_nowrap().child(words))
                            }),
                    )
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.capsule_clicked(cx))),
            )
    }

    fn connection_popover(
        &self,
        side: &Tokens,
        look: &Appearance,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let state = self.models.connection.read(cx).state;
        let running = status::is_running(state);
        let title = t(cx, status::status_text(state));
        let action = t(cx, if running { "Disconnect" } else { "Connect" });
        let browser = format!(
            "{} · {}",
            t(cx, "Browser"),
            t(cx, status::browser_text(self.models.bridge.read(cx)))
        );
        v_flex()
            .id("connectionPopover")
            .role(Role::Dialog)
            .aria_label(t(cx, "Connection"))
            .absolute()
            .left(z(12.))
            .bottom(z(56.))
            .w(z(160.))
            .p(z(10.))
            .gap(z(10.))
            .rounded(z(12.))
            .border_1()
            .border_color(c(side.edge))
            .bg(c(side.popover))
            .shadow_lg()
            .child(
                div()
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_size(z(13.) * look.text_scale)
                    .child(title),
            )
            .child(
                div()
                    .id("connectionPopoverBrowser")
                    .accessibility_id("connectionPopoverBrowser")
                    .role(Role::Status)
                    .aria_label(browser.clone())
                    .text_size(z(12.) * look.text_scale)
                    .child(browser),
            )
            .child(
                Button::new("connectionPopoverToggle")
                    .primary()
                    .small()
                    .accessibility_id("connectionPopoverToggle")
                    .accessibility_label(action.clone())
                    .label(action)
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.popover_open = false;
                        app::connection(&this.models.core, !running);
                        cx.notify();
                    })),
            )
    }

    fn main(&self, look: &Appearance, cx: &mut Context<Self>) -> impl IntoElement {
        let page = look.page;
        let (heading, id) = match self.screen {
            Screen::Chat => (t(cx, "New chat"), "chat"),
            Screen::Settings(tab) => (t(cx, tab.label()), tab.id()),
        };
        v_flex()
            .id(SharedString::from(format!("panel-{id}")))
            .role(Role::Main)
            .aria_label(heading.clone())
            .flex_1()
            .min_w_0()
            .h_full()
            .px(z(36.))
            .pt(z(46.))
            .gap(z(9.))
            .child(
                div()
                    .text_size(z(30.) * look.text_scale)
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .child(heading),
            )
            .child(
                div()
                    .text_color(c(page.soft))
                    .child(t(cx, "This page is not in the native app yet.")),
            )
            .when(self.screen == Screen::Chat, |this| {
                this.child(self.core_status(cx))
            })
    }

    /// What the bound models hold, until the timeline and settings views show it properly.
    fn core_status(&self, cx: &Context<Self>) -> impl IntoElement {
        let listed = self
            .models
            .sessions
            .read(cx)
            .index
            .sessions
            .len()
            .to_string();
        let connection = t(
            cx,
            status::status_text(self.models.connection.read(cx).state),
        );
        let bridge = self.models.bridge.read(cx);
        let port = match bridge.port.filter(|_| bridge.running) {
            Some(port) => t_args(cx, "bridge on port {0}", &[&port.to_string()]),
            None => t(cx, "bridge stopped"),
        };
        let browser = t(cx, status::browser_text(bridge));
        let picked = self.timeline.as_ref().map(|timeline| {
            let timeline = timeline.read(cx);
            let title = self
                .models
                .sessions
                .read(cx)
                .index
                .sessions
                .iter()
                .find(|summary| &summary.id == timeline.session())
                .map(|summary| summary.title.clone())
                .unwrap_or_default();
            let state: SharedString = match timeline.state() {
                TimelineState::Loading => t(cx, "Loading…"),
                TimelineState::Missing => t(cx, "This chat could not be read."),
                TimelineState::Ready(page) => {
                    let last = page.events.last().map_or("-", |event| event.kind.as_str());
                    t_args(
                        cx,
                        "{0} events, {1} on this page, last {2}",
                        &[
                            &page.total.to_string(),
                            &page.events.len().to_string(),
                            last,
                        ],
                    )
                }
            };
            format!("{title} · {state}")
        });
        let line = |id: &'static str, text: SharedString| {
            div()
                .id(id)
                .accessibility_id(id)
                .role(Role::Status)
                .aria_label(text.clone())
                .child(text)
        };
        v_flex()
            .id("coreStatus")
            .pt(z(24.))
            .gap(z(4.))
            .child(line("coreSessions", t_args(cx, "{0} chats", &[&listed])))
            .child(line(
                "coreConnection",
                format!("{} · {connection}", t(cx, "Connection")).into(),
            ))
            .child(line(
                "coreBrowser",
                format!("{} · {browser} · {port}", t(cx, "Browser")).into(),
            ))
            .when_some(picked, |this, picked| {
                this.child(line("coreTimeline", picked.into()))
            })
    }
}

fn nav_button(
    id: &'static str,
    icon: IconName,
    label: SharedString,
    selected: bool,
    side: &Tokens,
    look: &Appearance,
) -> Button {
    // The label goes in as a full-width child: the button centers its content, the sidebar does not.
    Button::new(id)
        .ghost()
        .accessibility_id(id)
        .accessibility_label(label.clone())
        .child(
            h_flex()
                .w_full()
                .gap(z(10.))
                .child(Icon::new(icon).small())
                .child(div().truncate().child(label)),
        )
        .selected(selected)
        .h(z(38.) * look.text_scale)
        .px(z(12.))
        .text_size(z(13.) * look.text_scale)
        .text_color(c(if selected { side.ink } else { side.soft }))
}

fn c(color: Rgb) -> Hsla {
    color.hsla()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// Points the component library's colors at the appearance tokens.
pub fn apply_theme(look: &Appearance, cx: &mut App) {
    Theme::change(app::theme_mode(look.theme), None, cx);
    let (page, side) = (look.page, look.sidebar);
    Theme::update(cx, |theme| {
        theme.background = c(page.page);
        theme.foreground = c(page.ink);
        theme.border = c(page.line);
        theme.input = c(page.edge);
        theme.ring = c(page.accent_edge);
        theme.muted = c(page.sunk);
        theme.muted_foreground = c(page.soft);
        theme.accent = c(side.hover);
        theme.accent_foreground = c(side.ink);
        theme.secondary = c(page.card);
        theme.secondary_hover = c(page.hover);
        theme.secondary_active = c(page.hover);
        theme.secondary_foreground = c(page.ink);
        theme.primary = c(page.accent_fill);
        theme.primary_hover = c(page.accent_fill);
        theme.primary_active = c(page.accent_fill);
        theme.primary_foreground = c(page.on_accent);
        theme.popover = c(page.popover);
        theme.popover_foreground = c(page.ink);
        theme.title_bar = c(side.page);
        theme.title_bar_border = c(side.page);
        theme.sidebar = c(side.page);
        theme.sidebar_foreground = c(side.ink);
        theme.sidebar_border = c(side.line);
        theme.sidebar_accent = c(side.hover);
        theme.sidebar_accent_foreground = c(side.ink);
        theme.list_hover = c(side.hover);
        theme.list_active = c(side.hover);
        theme.danger = c(page.red);
        theme.success = c(page.green);
        theme.font_size = px(14. * ZOOM * look.text_scale);
        if let Some(family) = look.font.family() {
            theme.font_family = family.into();
        }
    });
}
