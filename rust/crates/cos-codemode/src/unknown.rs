//! What a bare "not a function" means (#1287): the script called a tool this connector does not
//! have, usually another connector's (`unknownToolReferences`, `unknownToolNote`).

use cos_tools::{Connectors, SurfaceId};

use crate::text::{is_js_space, utf16_len};

const SURFACES: [SurfaceId; 3] = [SurfaceId::Core, SurfaceId::Desktop, SurfaceId::Plugins];

/// The tools each connector declares (`SURFACES[id].tools` in `surfaces.ts`).
fn declared(surface: SurfaceId) -> &'static [&'static str] {
    match surface {
        SurfaceId::Core => &[
            "read",
            "view_image",
            "find",
            "apply_patch",
            "save_image",
            "exec_command",
            "write_stdin",
            "update_plan",
            "agents",
            "session_finish",
            "exec",
        ],
        SurfaceId::Desktop => &[
            "browser_tabs",
            "browser_snapshot",
            "browser_screenshot",
            "browser_console",
            "browser_network",
            "browser_navigate",
            "browser_action",
            "browser_evaluate",
            "list_windows",
            "get_window",
            "list_apps",
            "get_window_state",
            "launch_app",
            "click",
            "press_key",
            "type_text",
            "scroll",
            "set_value",
            "drag",
            "perform_secondary_action",
            "activate_window",
            "read_clipboard",
            "write_clipboard",
            "observe",
            "computer",
            "exec",
        ],
        SurfaceId::Plugins => &["exec"],
    }
}

/// Names a script calls on `tools` (dotted or quoted bracket access) that are not in
/// `available`, at most eight, in first-use order. Checking for a tool (`typeof tools.x`) is not
/// calling it.
pub(crate) fn unknown_tool_references(code: &str, available: &[&str]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let mut from = 0;
    while let Some(found) = code[from..].find("tools") {
        let start = from + found;
        let word_before = code[..start]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
        match (!word_before)
            .then(|| called_tool(&code[start + "tools".len()..]))
            .flatten()
        {
            Some((name, used)) => {
                if !names.contains(&name) {
                    names.push(name);
                }
                from = start + "tools".len() + used;
            }
            None => from = start + "tools".len(),
        }
    }
    names
        .into_iter()
        .filter(|name| !available.contains(&name.as_str()))
        .take(8)
        .collect()
}

/// After `tools`: `\s*(?:\??\.\s*IDENT|\[\s*QUOTED\s*\])\s*(?:\?\.\s*)?\(`. The name and the
/// bytes the match used.
fn called_tool(rest: &str) -> Option<(String, usize)> {
    let mut cursor = Cursor { text: rest, at: 0 };
    cursor.spaces();
    let name = if cursor.eat('[') {
        cursor.spaces();
        let quote = cursor.peek().filter(|c| matches!(c, '\'' | '"' | '`'))?;
        cursor.eat(quote);
        let body_start = cursor.at;
        let body_len = cursor.rest().find(['\'', '"', '`', '\n'])?;
        let body = &rest[body_start..body_start + body_len];
        cursor.at += body_len;
        if body.is_empty() || utf16_len(body) > 64 || !cursor.eat(quote) {
            return None;
        }
        cursor.spaces();
        if !cursor.eat(']') {
            return None;
        }
        body.to_owned()
    } else {
        cursor.eat('?');
        if !cursor.eat('.') {
            return None;
        }
        cursor.spaces();
        let ident_len = cursor
            .rest()
            .char_indices()
            .find(|&(index, c)| {
                let allowed = c.is_ascii_alphabetic() || c == '_' || c == '$';
                !(allowed || index > 0 && c.is_ascii_digit())
            })
            .map_or(cursor.rest().len(), |(index, _)| index);
        if ident_len == 0 {
            return None;
        }
        let ident = cursor.rest()[..ident_len].to_owned();
        cursor.at += ident_len;
        ident
    };
    cursor.spaces();
    let optional = cursor.at;
    if cursor.eat('?') && cursor.eat('.') {
        cursor.spaces();
    } else {
        cursor.at = optional;
    }
    cursor.eat('(').then_some((name, cursor.at))
}

struct Cursor<'a> {
    text: &'a str,
    at: usize,
}

impl Cursor<'_> {
    fn rest(&self) -> &str {
        &self.text[self.at..]
    }

    fn peek(&self) -> Option<char> {
        self.rest().chars().next()
    }

    fn eat(&mut self, expected: char) -> bool {
        if self.peek() == Some(expected) {
            self.at += expected.len_utf8();
            true
        } else {
            false
        }
    }

    fn spaces(&mut self) {
        let rest = self.rest();
        self.at += rest.len() - rest.trim_start_matches(is_js_space).len();
    }
}

/// The note appended to the result when a script used tools this connector lacks. With two
/// connectors on one Secure Tunnel ID, ChatGPT sends calls to either, so a script written for
/// one can run on the other.
pub(crate) fn unknown_tool_note(
    surface: SurfaceId,
    unknown: &[String],
    connectors: &Connectors,
) -> String {
    let here = connectors.name(surface);
    let named: Vec<String> = unknown
        .iter()
        .map(|name| {
            let owner = SURFACES.into_iter().find(|&id| {
                id != surface && name != "exec" && declared(id).contains(&name.as_str())
            });
            match owner {
                Some(owner) => format!("{name} (a {} tool)", connectors.name(owner)),
                None => name.clone(),
            }
        })
        .collect();
    let mut note = format!(
        "UNKNOWN_TOOL_NAMES: this script used tools.{}, which {here} does not offer; calling one fails with \"not a function\". ALL_TOOLS lists this connector's tools; call other tools through their own connector.",
        named.join(", tools."),
    );
    let shared = connectors.sharing_tunnel(surface);
    if !shared.is_empty() {
        let names: Vec<String> = shared.into_iter().map(|id| connectors.name(id)).collect();
        note.push_str(&format!(
            " {here} shares its Secure Tunnel ID with {}, so ChatGPT sends calls to either connector and a script meant for one can run on the other. Give each connector its own tunnel ID in Setup.",
            names.join(" and ")
        ));
    }
    note
}
