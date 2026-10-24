//! Interface texts: the shipped catalogs, `t` and `systemLanguage` (cases from
//! `test/renderer-i18n.test.ts`).

use cos_app::i18n::{Catalog, Language, system_language};
use serde_json::{Map, Value};

fn shipped(file: &str) -> Map<String, Value> {
    let path = format!(
        "{}/../../../src/renderer/locales/{file}",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).expect("the locale file exists");
    serde_json::from_str(&text).expect("the locale file is a JSON object")
}

#[test]
fn every_shipped_language_translates_the_shell_texts_from_its_catalog() {
    let languages = [
        (Language::De, "de.json"),
        (Language::Es, "es.json"),
        (Language::Fr, "fr.json"),
        (Language::PtBr, "pt-BR.json"),
        (Language::PtPt, "pt-PT.json"),
        (Language::Ru, "ru.json"),
        (Language::Tr, "tr.json"),
        (Language::Vi, "vi.json"),
        (Language::Ja, "ja.json"),
        (Language::Ko, "ko.json"),
        (Language::ZhCn, "zh-CN.json"),
        (Language::ZhTw, "zh-TW.json"),
    ];
    for (language, file) in languages {
        let catalog = Catalog::load(language);
        let texts = shipped(file);
        assert_eq!(catalog.language(), language);
        for source in [
            "Settings",
            "Connected",
            "Not connected",
            "Open",
            "Quit",
            "Back to chat",
        ] {
            let expected = texts[source].as_str().expect("a translation");
            assert_eq!(catalog.t(source), expected, "{file}: {source}");
        }
    }
}

#[test]
fn english_and_unknown_texts_stay_as_written() {
    let english = Catalog::load(Language::En);
    assert_eq!(english.t("Settings"), "Settings");
    let japanese = Catalog::load(Language::Ja);
    assert_eq!(japanese.t("Settings"), "設定");
    assert_eq!(
        japanese.t("unknown /Save/<img src=x>"),
        "unknown /Save/<img src=x>"
    );
}

#[test]
fn a_source_with_odd_spacing_finds_its_translation() {
    let german = Catalog::load(Language::De);
    assert_eq!(german.t("  Back   to\nchat "), "Zurück zum Chat");
}

#[test]
fn placeholders_take_their_arguments_and_missing_ones_stay() {
    let english = Catalog::load(Language::En);
    assert_eq!(english.t_args("{0}s ago", &["12"]), "12s ago");
    assert_eq!(english.t_args("{0} of {1}", &["a"]), "a of {1}");
    assert_eq!(english.t_args("{x} {} {0", &["a"]), "{x} {} {0");
    let german = Catalog::load(Language::De);
    let expected = shipped("de.json")["verified {0}"]
        .as_str()
        .expect("a translation")
        .replace("{0}", "2m ago");
    assert_eq!(german.t_args("verified {0}", &["2m ago"]), expected);
}

#[test]
fn the_system_language_is_the_first_preferred_one_the_app_speaks() {
    let cases: [(&[&str], Language); 13] = [
        (&["de-DE", "de"], Language::De),
        (&["zh-Hant-TW"], Language::ZhTw),
        (&["zh-HK"], Language::ZhTw),
        (&["zh-CN"], Language::ZhCn),
        (&["zh"], Language::ZhCn),
        (&["pt-PT"], Language::PtPt),
        (&["pt-BR"], Language::PtBr),
        (&["pt"], Language::PtBr),
        (&["nl-NL", "fr-FR"], Language::Fr),
        (&["nl", "sv"], Language::En),
        (&["en-GB", "de-DE"], Language::En),
        (&["ja-JP"], Language::Ja),
        (&[], Language::En),
    ];
    for (preferred, expected) in cases {
        assert_eq!(system_language(preferred), expected, "{preferred:?}");
    }
}
