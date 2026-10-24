//! Interface language: the 12 catalogs of `src/renderer/locales`, keyed by the English source
//! text, with `t` and `systemLanguage` from `src/renderer/i18n.ts`.
//!
//! The renderer kept the choice in `localStorage` (`cos.ui.language`) and mirrored it into
//! `config.json` as `ui.language`. The native app has no renderer storage, so `ui.language` is
//! the one place the choice lives.

use std::collections::HashMap;

pub use cos_types::config::UiLanguage as Language;

macro_rules! catalogs {
    ($($language:ident => $file:literal),* $(,)?) => {
        fn source(language: Language) -> Option<&'static str> {
            match language {
                Language::En => None,
                $(Language::$language => Some(include_str!(concat!("../../../../src/renderer/locales/", $file))),)*
            }
        }
    };
}

catalogs! {
    De => "de.json",
    Es => "es.json",
    Fr => "fr.json",
    PtBr => "pt-BR.json",
    PtPt => "pt-PT.json",
    Ru => "ru.json",
    Tr => "tr.json",
    Vi => "vi.json",
    Ja => "ja.json",
    Ko => "ko.json",
    ZhCn => "zh-CN.json",
    ZhTw => "zh-TW.json",
}

/// The translations of one language. English has none: its keys are the texts.
#[derive(Clone, Debug, Default)]
pub struct Catalog {
    language: Option<Language>,
    texts: HashMap<String, String>,
}

impl Catalog {
    /// The catalog shipped for `language`. A catalog that does not parse leaves English texts.
    pub fn load(language: Language) -> Self {
        let texts = source(language)
            .and_then(|json| serde_json::from_str(json).ok())
            .unwrap_or_default();
        Self {
            language: Some(language),
            texts,
        }
    }

    pub fn language(&self) -> Language {
        self.language.unwrap_or(Language::En)
    }

    /// `t(source)`: the translation, else the source text itself.
    pub fn t(&self, source: &str) -> String {
        self.t_args(source, &[])
    }

    /// `t(source, args)`: `{0}`, `{1}` ... are replaced by `args` verbatim; a placeholder with no
    /// argument stays as written.
    pub fn t_args(&self, source: &str, args: &[&str]) -> String {
        let translated = self.texts.get(source).cloned().or_else(|| {
            let key = source.split_whitespace().collect::<Vec<_>>().join(" ");
            self.texts.get(&key).cloned()
        });
        substitute(translated.as_deref().unwrap_or(source), args)
    }
}

fn substitute(text: &str, args: &[&str]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let digits = after.bytes().take_while(u8::is_ascii_digit).count();
        let argument = (digits > 0 && after[digits..].starts_with('}'))
            .then(|| after[..digits].parse::<usize>().ok())
            .flatten()
            .and_then(|index| args.get(index));
        match argument {
            Some(value) => {
                out.push_str(value);
                rest = &after[digits + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// `systemLanguage`: the first preferred language the app speaks, else English.
pub fn system_language<S: AsRef<str>>(preferred: &[S]) -> Language {
    for raw in preferred {
        let tag = raw.as_ref().to_lowercase();
        let base = tag.split('-').next().unwrap_or_default();
        let has_subtag = |subtags: &[&str]| {
            tag.split('-')
                .skip(1)
                .any(|subtag| subtags.contains(&subtag))
        };
        let language = match base {
            "zh" if has_subtag(&["hant", "tw", "hk", "mo"]) => Language::ZhTw,
            "zh" => Language::ZhCn,
            "pt" if tag == "pt-pt" || tag.starts_with("pt-pt-") => Language::PtPt,
            "pt" => Language::PtBr,
            "en" => Language::En,
            "es" => Language::Es,
            "ja" => Language::Ja,
            "ko" => Language::Ko,
            "tr" => Language::Tr,
            "vi" => Language::Vi,
            "fr" => Language::Fr,
            "de" => Language::De,
            "ru" => Language::Ru,
            _ => continue,
        };
        return language;
    }
    Language::En
}

/// The user's preferred UI languages, most preferred first.
#[cfg(windows)]
pub fn preferred_languages() -> Vec<String> {
    use windows::Win32::Globalization::{GetUserPreferredUILanguages, MUI_LANGUAGE_NAME};
    let mut count = 0u32;
    let mut length = 0u32;
    // SAFETY: a null buffer with a zero length asks only for the required length.
    let sized =
        unsafe { GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, None, &mut length) };
    if sized.is_err() || length == 0 {
        return Vec::new();
    }
    let mut buffer = vec![0u16; length as usize];
    // SAFETY: `buffer` holds exactly the `length` UTF-16 units the first call asked for.
    let filled = unsafe {
        GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut count,
            Some(windows::core::PWSTR(buffer.as_mut_ptr())),
            &mut length,
        )
    };
    if filled.is_err() {
        return Vec::new();
    }
    buffer
        .split(|unit| *unit == 0)
        .filter(|name| !name.is_empty())
        .map(String::from_utf16_lossy)
        .collect()
}

#[cfg(not(windows))]
pub fn preferred_languages() -> Vec<String> {
    std::env::var("LANG")
        .map(|lang| vec![lang.split('.').next().unwrap_or_default().replace('_', "-")])
        .unwrap_or_default()
}
