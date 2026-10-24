//! The appearance tokens of `src/shared/appearance.ts` and `src/renderer/appearance.ts`: one
//! palette (background, accent, contrast) becomes every semantic color the shell paints with.

use cos_types::config::{AppearancePalette, AppearanceSettings, Theme};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgb(pub u8, pub u8, pub u8);

impl Rgb {
    /// `#rrggbb`, as the config stores colors.
    pub fn parse(hex: &str) -> Option<Self> {
        let digits = hex.strip_prefix('#')?;
        if digits.len() != 6 || !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let channel = |at: usize| u8::from_str_radix(&digits[at..at + 2], 16).ok();
        Some(Self(channel(0)?, channel(2)?, channel(4)?))
    }

    pub fn hex(self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.0, self.1, self.2)
    }

    fn channels(self) -> [f64; 3] {
        [self.0.into(), self.1.into(), self.2.into()]
    }

    pub fn to_rgba(self) -> gpui::Rgba {
        gpui::Rgba {
            r: f32::from(self.0) / 255.,
            g: f32::from(self.1) / 255.,
            b: f32::from(self.2) / 255.,
            a: 1.,
        }
    }

    pub fn hsla(self) -> gpui::Hsla {
        self.to_rgba().into()
    }
}

const WHITE: Rgb = Rgb(0xff, 0xff, 0xff);
const BLACK: Rgb = Rgb(0, 0, 0);
const GREEN: Rgb = Rgb(0x25, 0x85, 0x52);
const RED: Rgb = Rgb(0xd4, 0x45, 0x45);

/// `mixColor`: each channel moved `amount` of the way from `a` to `b`, rounded like `Math.round`.
pub fn mix(a: Rgb, b: Rgb, amount: f64) -> Rgb {
    let [ar, ag, ab] = a.channels();
    let [br, bg, bb] = b.channels();
    // Every value lies in 0..=255, where `round` and `Math.round` agree.
    let channel = |from: f64, to: f64| (from + (to - from) * amount).round() as u8;
    Rgb(channel(ar, br), channel(ag, bg), channel(ab, bb))
}

pub fn luminance(color: Rgb) -> f64 {
    let [r, g, b] = color.channels().map(|value| {
        let n = value / 255.;
        if n <= 0.04045 {
            n / 12.92
        } else {
            ((n + 0.055) / 1.055).powf(2.4)
        }
    });
    r * 0.2126 + g * 0.7152 + b * 0.0722
}

pub fn contrast_ratio(a: Rgb, b: Rgb) -> f64 {
    let (x, y) = (luminance(a), luminance(b));
    (x.max(y) + 0.05) / (x.min(y) + 0.05)
}

/// White or black, whichever reads better on `background`.
pub fn readable_ink(background: Rgb) -> Rgb {
    if contrast_ratio(background, WHITE) > contrast_ratio(background, BLACK) {
        WHITE
    } else {
        BLACK
    }
}

fn readable_tint(color: Rgb, background: Rgb, ratio: f64) -> Rgb {
    let ink = readable_ink(background);
    (0..=20)
        .map(|step| mix(color, ink, f64::from(step) / 20.))
        .find(|candidate| contrast_ratio(*candidate, background) >= ratio)
        .unwrap_or(ink)
}

/// The semantic colors one palette produces (`paletteTokens`), named after the CSS variables.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tokens {
    pub page: Rgb,
    pub ink: Rgb,
    pub card: Rgb,
    pub sunk: Rgb,
    pub hover: Rgb,
    pub raise: Rgb,
    pub popover: Rgb,
    pub soft: Rgb,
    pub faint: Rgb,
    pub line: Rgb,
    pub edge: Rgb,
    pub track: Rgb,
    pub blue: Rgb,
    pub accent: Rgb,
    pub accent_fill: Rgb,
    pub on_accent: Rgb,
    pub wash: Rgb,
    pub blue_line: Rgb,
    pub accent_wash: Rgb,
    pub accent_edge: Rgb,
    pub knob_off: Rgb,
    pub knob_on: Rgb,
    pub green: Rgb,
    pub green_wash: Rgb,
    pub green_line: Rgb,
    pub red: Rgb,
    pub red_wash: Rgb,
    pub red_line: Rgb,
}

pub fn palette_tokens(background: Rgb, accent: Rgb, contrast: u8) -> Tokens {
    let ink = readable_ink(background);
    let c = f64::from(contrast) / 100.;
    let card = mix(background, ink, 0.025 + 0.06 * c);
    let hover = mix(background, ink, 0.055 + 0.07 * c);
    let accent_text = readable_tint(accent, background, 4.5);
    Tokens {
        page: background,
        ink,
        card,
        sunk: mix(background, ink, 0.018 + 0.025 * c),
        hover,
        raise: hover,
        popover: mix(background, ink, 0.06 + 0.06 * c),
        soft: readable_tint(mix(background, ink, 0.53 + 0.2 * c), card, 4.5),
        faint: readable_tint(mix(background, ink, 0.43 + 0.2 * c), card, 4.5),
        line: mix(background, ink, 0.09 + 0.13 * c),
        edge: mix(background, ink, 0.12 + 0.15 * c),
        track: mix(background, ink, 0.18 + 0.14 * c),
        blue: accent_text,
        accent: accent_text,
        accent_fill: accent,
        on_accent: readable_ink(accent),
        wash: mix(background, accent, 0.12),
        blue_line: mix(background, accent, 0.3),
        accent_wash: mix(background, accent, 0.12),
        accent_edge: mix(background, accent, 0.35),
        knob_off: ink,
        knob_on: readable_ink(accent),
        green: readable_tint(GREEN, card, 4.5),
        green_wash: mix(background, GREEN, 0.12),
        green_line: mix(background, GREEN, 0.3),
        red: readable_tint(RED, card, 4.5),
        red_wash: mix(background, RED, 0.12),
        red_line: mix(background, RED, 0.3),
    }
}

/// One palette from the config, with any color the config could not hold replaced by the default.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Palette {
    pub background: Rgb,
    pub sidebar: Rgb,
    pub accent: Rgb,
    pub contrast: u8,
}

impl Palette {
    pub const DARK: Self = Self {
        background: Rgb(0x18, 0x18, 0x18),
        sidebar: Rgb(0x1a, 0x21, 0x29),
        accent: Rgb(0xb0, 0xcb, 0xed),
        contrast: 60,
    };
    pub const LIGHT: Self = Self {
        background: Rgb(0xf4, 0xf4, 0xf5),
        sidebar: Rgb(0xe9, 0xed, 0xf2),
        accent: Rgb(0x48, 0x6f, 0x9d),
        contrast: 45,
    };

    fn from_config(saved: &AppearancePalette, fallback: Self) -> Self {
        Self {
            background: Rgb::parse(&saved.background).unwrap_or(fallback.background),
            sidebar: Rgb::parse(&saved.sidebar).unwrap_or(fallback.sidebar),
            accent: Rgb::parse(&saved.accent).unwrap_or(fallback.accent),
            contrast: saved.contrast.min(100),
        }
    }
}

/// Everything the shell paints with for one theme (`applyAppearance`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Appearance {
    pub theme: Theme,
    /// The page: main area and cards.
    pub page: Tokens,
    /// The sidebar and title bar, which carry the sidebar tint.
    pub sidebar: Tokens,
    /// `fontSize / 14`.
    pub text_scale: f32,
    pub font: Font,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Font {
    System,
    Sans,
    Serif,
    Mono,
}

impl Font {
    /// The family the shell asks for, `None` for the platform UI font.
    pub fn family(self) -> Option<&'static str> {
        match self {
            Self::System => None,
            Self::Sans => Some("Arial"),
            Self::Serif => Some("Georgia"),
            Self::Mono => Some("Cascadia Mono"),
        }
    }
}

impl Appearance {
    pub fn resolve(theme: Theme, saved: Option<&AppearanceSettings>) -> Self {
        let fallback = match theme {
            Theme::Dark => Palette::DARK,
            Theme::Light => Palette::LIGHT,
        };
        let palette = saved.map_or(fallback, |saved| {
            let chosen = match theme {
                Theme::Dark => &saved.dark,
                Theme::Light => &saved.light,
            };
            Palette::from_config(chosen, fallback)
        });
        let translucent = saved.is_none_or(|saved| saved.translucent_sidebar);
        // The translucent sidebar is glass over the page; a solid fill of the same mix stands in.
        let sidebar_fill = if translucent {
            mix(palette.sidebar, palette.background, 0.13)
        } else {
            palette.sidebar
        };
        let font = saved.map_or(Font::System, |saved| {
            use cos_types::config::AppearanceFont;
            match saved.font {
                AppearanceFont::System => Font::System,
                AppearanceFont::Sans => Font::Sans,
                AppearanceFont::Serif => Font::Serif,
                AppearanceFont::Mono => Font::Mono,
            }
        });
        Self {
            theme,
            page: palette_tokens(palette.background, palette.accent, palette.contrast),
            sidebar: palette_tokens(sidebar_fill, palette.accent, palette.contrast),
            text_scale: f32::from(saved.map_or(14, |saved| saved.font_size)) / 14.,
            font,
        }
    }
}
