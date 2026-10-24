//! Key chords: the parser native input and the browser policy share
//! (`parseWindowsKeyChord`), and the chords a browser takes for its tabs, windows and history
//! (`browser-chords.ts`). Pure, so the policy is testable without a window.

use crate::computer::ComputerError;

fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `Control_L+s` as key names. A final literal plus is written `+` or `Control_L++`.
pub(crate) fn parse_key_chord(key: &str) -> Result<Vec<String>, ComputerError> {
    let mut keys: Vec<String> = js_trim(key)
        .split('+')
        .map(|part| js_trim(part).to_owned())
        .collect();
    let count = keys.len();
    if count >= 2 && keys[count - 1].is_empty() && keys[count - 2].is_empty() {
        keys.truncate(count - 2);
        keys.push("+".to_owned());
    }
    if keys.len() > 6
        || keys
            .iter()
            .any(|part| part.is_empty() || part.encode_utf16().count() > 20)
    {
        return Err(ComputerError::new(
            "INVALID_KEY: use up to six key names; write the plus key as plus or Control_L++.",
        ));
    }
    Ok(keys)
}

const MODIFIERS: [&str; 4] = ["ctrl", "shift", "alt", "cmd"];

fn alias(key: &str) -> &str {
    match key {
        "control" | "control_l" | "control_r" | "ctrl_l" | "ctrl_r" => "ctrl",
        "shift_l" | "shift_r" => "shift",
        "alt_l" | "alt_r" | "option" => "alt",
        "super_l" | "super_r" | "meta_l" | "meta_r" | "command" | "meta" | "super" | "win"
        | "windows" => "cmd",
        "pgup" | "page_up" | "prior" | "kp_prior" | "numpad_prior" => "pageup",
        "pgdn" | "page_down" | "next" | "kp_next" | "numpad_next" => "pagedown",
        "kp_left" | "numpad_left" | "arrowleft" => "left",
        "kp_right" | "numpad_right" | "arrowright" => "right",
        "kp_home" | "numpad_home" => "home",
        "bracketleft" => "[",
        "bracketright" => "]",
        other => other,
    }
}

fn is_tab_chord(chord: &str) -> bool {
    const FIXED: [&str; 31] = [
        "ctrl+w",
        "ctrl+shift+w",
        "ctrl+f4",
        "alt+f4",
        "ctrl+t",
        "ctrl+shift+t",
        "ctrl+n",
        "ctrl+shift+n",
        "ctrl+tab",
        "ctrl+shift+tab",
        "ctrl+pageup",
        "ctrl+pagedown",
        "ctrl+shift+q",
        "alt+left",
        "alt+right",
        "alt+home",
        "cmd+w",
        "cmd+shift+w",
        "cmd+q",
        "cmd+h",
        "cmd+alt+h",
        "cmd+t",
        "cmd+shift+t",
        "cmd+n",
        "cmd+shift+n",
        "cmd+shift+]",
        "cmd+shift+[",
        "cmd+alt+left",
        "cmd+alt+right",
        "cmd+[",
        "cmd+]",
    ];
    if FIXED.contains(&chord) {
        return true;
    }
    let digit = |prefix: &str| {
        chord
            .strip_prefix(prefix)
            .is_some_and(|rest| matches!(rest, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"))
    };
    digit("ctrl+") || digit("cmd+")
}

/// The normalized chord when a browser takes it for tab or window management.
pub(crate) fn browser_tab_chord(keys: &[String]) -> Option<String> {
    let parts: Vec<String> = keys
        .iter()
        .map(|key| js_trim(key).to_lowercase())
        .map(|key| alias(&key).to_owned())
        .filter(|key| !key.is_empty())
        .collect();
    let (modifiers, rest): (Vec<&String>, Vec<&String>) = parts
        .iter()
        .partition(|key| MODIFIERS.contains(&key.as_str()));
    let [key] = rest.as_slice() else {
        return None;
    };
    let has = |name: &str| modifiers.iter().any(|modifier| *modifier == name);
    let chord: Vec<&str> = ["cmd", "ctrl", "alt", "shift"]
        .into_iter()
        .filter(|name| has(name))
        .chain(std::iter::once(key.as_str()))
        .collect();
    let chord = chord.join("+");
    is_tab_chord(&chord).then_some(chord)
}

/// Whether a window's process name is a web browser.
pub(crate) fn is_browser_process(process: &str) -> bool {
    const BROWSERS: [&str; 10] = [
        "chrome", "chromium", "msedge", "edge", "firefox", "brave", "opera", "vivaldi", "arc",
        "safari",
    ];
    let name = js_trim(process).to_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    name.split(|c: char| c.is_whitespace() || c == '_' || c == '-')
        .any(|token| BROWSERS.contains(&token))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(chord: &str) -> Vec<String> {
        parse_key_chord(chord).expect("valid chord")
    }

    #[test]
    fn a_literal_plus_and_named_keys_parse_into_the_same_tokens() {
        assert_eq!(keys("Control_L+s"), ["Control_L", "s"]);
        assert_eq!(keys("Control_L++"), ["Control_L", "+"]);
        assert_eq!(keys("+"), ["+"]);
        assert_eq!(keys(" ctrl + plus "), ["ctrl", "plus"]);
        for bad in ["a+b+c+d+e+f+g", "ctrl++s", "", "abcdefghijklmnopqrstu"] {
            assert!(parse_key_chord(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn browser_tab_management_chords_are_recognized_in_any_spelling() {
        assert_eq!(
            browser_tab_chord(&keys("Control_L+w")),
            Some("ctrl+w".to_owned())
        );
        assert_eq!(
            browser_tab_chord(&keys("shift+CTRL+Tab")),
            Some("ctrl+shift+tab".to_owned())
        );
        assert_eq!(
            browser_tab_chord(&keys("Super_L+3")),
            Some("cmd+3".to_owned())
        );
        assert_eq!(
            browser_tab_chord(&keys("alt+ArrowLeft")),
            Some("alt+left".to_owned())
        );
        assert_eq!(browser_tab_chord(&keys("ctrl+s")), None);
        assert_eq!(browser_tab_chord(&keys("ctrl+0")), None);
        assert_eq!(browser_tab_chord(&keys("ctrl")), None);
    }

    #[test]
    fn browsers_are_recognized_by_process_name_token() {
        for name in [
            "chrome",
            "msedge.exe",
            "Brave Browser",
            "Google Chrome",
            "firefox-esr",
        ] {
            assert!(is_browser_process(name), "{name}");
        }
        for name in ["notepad", "chromedriver", "powershell", "operator"] {
            assert!(!is_browser_process(name), "{name}");
        }
    }
}
