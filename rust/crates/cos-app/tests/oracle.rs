//! The Rust ports against what the TypeScript modules compute for the same inputs
//! (`tests/oracle.json`, recorded by `tools/oracle.mjs`).

use base64::Engine as _;
use cos_app::appearance::{Rgb, Tokens, mix, palette_tokens};
use cos_app::placement::{self, Rect};
use cos_app::tray_image::tray_rgba;
use serde_json::Value;

fn oracle() -> Value {
    serde_json::from_str(include_str!("oracle.json")).expect("the oracle is JSON")
}

fn rgb(value: &Value) -> Rgb {
    Rgb::parse(value.as_str().expect("a color string")).expect("a #rrggbb color")
}

fn named(tokens: &Tokens) -> Vec<(&'static str, Rgb)> {
    vec![
        ("--page", tokens.page),
        ("--ink", tokens.ink),
        ("--card", tokens.card),
        ("--sunk", tokens.sunk),
        ("--hover", tokens.hover),
        ("--raise", tokens.raise),
        ("--popover", tokens.popover),
        ("--soft", tokens.soft),
        ("--faint", tokens.faint),
        ("--line", tokens.line),
        ("--edge", tokens.edge),
        ("--track", tokens.track),
        ("--blue", tokens.blue),
        ("--accent", tokens.accent),
        ("--accent-fill", tokens.accent_fill),
        ("--on-accent", tokens.on_accent),
        ("--wash", tokens.wash),
        ("--blue-line", tokens.blue_line),
        ("--accent-wash", tokens.accent_wash),
        ("--accent-edge", tokens.accent_edge),
        ("--knob-off", tokens.knob_off),
        ("--knob-on", tokens.knob_on),
        ("--green", tokens.green),
        ("--green-wash", tokens.green_wash),
        ("--green-line", tokens.green_line),
        ("--red", tokens.red),
        ("--red-wash", tokens.red_wash),
        ("--red-line", tokens.red_line),
    ]
}

#[test]
fn every_palette_produces_the_tokens_the_renderer_paints_with() {
    let oracle = oracle();
    let cases = oracle["tokens"].as_array().expect("token cases");
    assert!(cases.len() >= 9);
    for case in cases {
        let contrast = case["contrast"].as_u64().expect("contrast") as u8;
        let tokens = palette_tokens(rgb(&case["background"]), rgb(&case["accent"]), contrast);
        let expected = case["tokens"].as_object().expect("token map");
        let ours = named(&tokens);
        assert_eq!(ours.len(), expected.len(), "every CSS token is ported");
        for (name, color) in ours {
            assert_eq!(color.hex(), expected[name], "{name} for {case}");
        }
    }
}

#[test]
fn colors_mix_like_mix_color() {
    for case in oracle()["mixes"].as_array().expect("mix cases") {
        let mixed = mix(
            rgb(&case["a"]),
            rgb(&case["b"]),
            case["amount"].as_f64().expect("amount"),
        );
        assert_eq!(mixed.hex(), case["mixed"], "{case}");
    }
}

fn rect(value: &Value) -> Rect {
    let field = |name: &str| value[name].as_i64().expect("an integer field");
    Rect {
        x: field("x"),
        y: field("y"),
        width: field("width"),
        height: field("height"),
    }
}

#[test]
fn the_window_opens_where_window_layout_for_displays_puts_it() {
    let oracle = oracle();
    let primary = rect(&oracle["displays"]["primary"]);
    let all: Vec<Rect> = oracle["displays"]["all"]
        .as_array()
        .expect("work areas")
        .iter()
        .map(rect)
        .collect();
    let cases = oracle["placements"].as_array().expect("placement cases");
    assert!(cases.len() >= 10);
    for case in cases {
        let layout = placement::layout(primary, &all, placement::parse(&case["saved"]));
        let expected = &case["layout"];
        assert_eq!(
            layout.bounds,
            rect(expected),
            "bounds for {}",
            case["saved"]
        );
        assert_eq!(
            layout.min_width,
            expected["minWidth"].as_i64().expect("minWidth")
        );
        assert_eq!(
            layout.min_height,
            expected["minHeight"].as_i64().expect("minHeight")
        );
        assert_eq!(
            layout.restored, case["restored"],
            "restored for {}",
            case["saved"]
        );
        // `ready-to-show` maximizes a fresh window and one last used maximized.
        let maximized = !layout.restored || case["maximized"] == true;
        assert_eq!(
            layout.maximized, maximized,
            "maximized for {}",
            case["saved"]
        );
    }
}

#[test]
fn the_tray_dot_matches_tray_rgba_pixel_for_pixel() {
    for case in oracle()["trayImages"].as_array().expect("tray cases") {
        let running = case["running"].as_bool().expect("running");
        let scale = case["scale"].as_u64().expect("scale") as u32;
        let image = tray_rgba(running, scale);
        let expected = base64::engine::general_purpose::STANDARD
            .decode(case["rgba"].as_str().expect("base64 pixels"))
            .expect("decodes");
        assert_eq!(u64::from(image.size), case["size"].as_u64().expect("size"));
        assert_eq!(image.rgba, expected, "running={running} scale={scale}");
    }
}

#[test]
fn a_saved_appearance_colors_the_page_and_the_caption_like_the_electron_window() {
    use cos_app::appearance::Appearance;
    use cos_types::config::{AppearanceSettings, Theme};
    for case in oracle()["windows"].as_array().expect("window cases") {
        let theme = match case["theme"].as_str() {
            Some("dark") => Theme::Dark,
            _ => Theme::Light,
        };
        let saved: AppearanceSettings =
            serde_json::from_value(case["appearance"].clone()).expect("an appearance");
        let look = Appearance::resolve(theme, Some(&saved));
        // `backgroundColor` paints the page; the caption glyphs are the sidebar's ink.
        assert_eq!(look.page.page.hex(), case["background"], "{case}");
        assert_eq!(look.sidebar.ink.hex(), case["captionSymbol"], "{case}");
    }
    let unsaved = Appearance::resolve(Theme::Dark, None);
    assert_eq!(unsaved.page.page.hex(), "#181818");
}
