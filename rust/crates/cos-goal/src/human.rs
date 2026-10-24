//! The finished draft as a person would have typed it (`humanReply`), and the per-message cut
//! that keeps both ends of a long answer (`clip`). Every choice is seeded by the draft itself,
//! so asking twice returns the identical string. Offsets are UTF-16 units, as in TypeScript.

use std::sync::LazyLock;

use regex::Regex;

use crate::js;

const NEWLINE: u16 = b'\n' as u16;
const RETURN: u16 = b'\r' as u16;
const EM_DASH: u16 = 0x2014;
const EN_DASH: u16 = 0x2013;
const CURLY_APOSTROPHE: u16 = 0x2019;

fn horizontal_space(unit: u16) -> bool {
    unit != NEWLINE && unit != RETURN && js::is_space_unit(unit)
}

fn ascii(unit: u16, set: &[u8]) -> bool {
    u8::try_from(unit).is_ok_and(|byte| set.contains(&byte))
}

fn digit(unit: u16) -> bool {
    (u16::from(b'0')..=u16::from(b'9')).contains(&unit)
}

/// The em dash and the spaced en dash, replaced by what that sentence looks like typed.
fn undash(text: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        let mut dash = at;
        while dash < text.len() && horizontal_space(text[dash]) {
            dash += 1;
        }
        if dash < text.len() && (text[dash] == EM_DASH || text[dash] == EN_DASH) {
            let mut end = dash + 1;
            while end < text.len() && horizontal_space(text[end]) {
                end += 1;
            }
            let before = at.checked_sub(1).map(|index| text[index]);
            let after = text.get(end).copied();
            let replacement: &str = match (before, after) {
                (None | Some(NEWLINE), _) | (_, None | Some(NEWLINE)) => "",
                (Some(b), Some(a)) if digit(b) && digit(a) => "-",
                (Some(b), Some(a)) if ascii(b, b",;:") || ascii(a, b",;:.!?") => " ",
                _ => ", ",
            };
            out.extend(replacement.encode_utf16());
            at = end;
        } else if dash > at {
            out.extend_from_slice(&text[at..dash]);
            at = dash;
        } else {
            out.push(text[at]);
            at += 1;
        }
    }
    out
}

/// Text a mistake must never be put into: code, URLs, paths and file names.
static PROTECTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"```[\s\S]*?```|`[^`\n]*`|https?://\S+|\S+[\\/@]\S+|[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")
        .unwrap_or_else(|error| panic!("protected pattern: {error}"))
});

fn lower(unit: u16) -> bool {
    (u16::from(b'a')..=u16::from(b'z')).contains(&unit)
}

fn apostrophe(unit: u16) -> bool {
    unit == u16::from(b'\'') || unit == CURLY_APOSTROPHE
}

/// `[\w'’-]`, the characters a candidate may not touch on either side.
fn joins_word(unit: u16) -> bool {
    ascii(unit, b"_-")
        || apostrophe(unit)
        || u8::try_from(unit).is_ok_and(|b| b.is_ascii_alphanumeric())
}

/// The mistake this word would carry, in the order a real one happens.
fn mistyped(word: &[u16]) -> Option<Vec<u16>> {
    if word.iter().copied().any(apostrophe) {
        let dropped: Vec<u16> = word
            .iter()
            .copied()
            .filter(|&unit| !apostrophe(unit))
            .collect();
        if dropped.len() >= 3 && dropped != word {
            return Some(dropped);
        }
    }
    if word.len() >= 5 {
        if let Some(at) =
            (0..word.len() - 1).find(|&at| lower(word[at]) && word[at] == word[at + 1])
        {
            let mut out = word.to_vec();
            out.remove(at);
            return Some(out);
        }
        // Never the first or last letter: a reader recognises a word by those two.
        for at in (1..=(word.len() - 1) / 2).rev() {
            if at + 1 < word.len() - 1 && word[at] != word[at + 1] {
                let mut out = word.to_vec();
                out.swap(at, at + 1);
                return Some(out);
            }
        }
    }
    None
}

struct Site {
    at: usize,
    len: usize,
    typo: Vec<u16>,
}

/// Every plain lowercase word that could carry a mistake, outside the protected spans.
fn typo_sites(text: &[u16]) -> Vec<Site> {
    let rendered = js::string(text);
    let guarded: Vec<(usize, usize)> = PROTECTED
        .find_iter(&rendered)
        .map(|found| {
            (
                js::utf16_offset(&rendered, found.start()),
                js::utf16_offset(&rendered, found.end()),
            )
        })
        .collect();
    let mut sites = Vec::new();
    let mut at = 0;
    while at < text.len() {
        let in_run = |unit: u16| lower(unit) || apostrophe(unit);
        if !in_run(text[at]) {
            at += 1;
            continue;
        }
        let start = at;
        while at < text.len() && in_run(text[at]) {
            at += 1;
        }
        let word = &text[start..at];
        let alone = start
            .checked_sub(1)
            .is_none_or(|before| !joins_word(text[before]))
            && text.get(at).is_none_or(|&after| !joins_word(after));
        let shaped = word.len() >= 4 && lower(word[0]) && lower(word[word.len() - 1]);
        if !alone || !shaped {
            continue;
        }
        if guarded.iter().any(|&(from, to)| start < to && at > from) {
            continue;
        }
        if let Some(typo) = mistyped(word) {
            sites.push(Site {
                at: start,
                len: word.len(),
                typo,
            });
        }
    }
    sites
}

/// FNV-1a over the draft's UTF-16 units, so every choice is the draft's own.
fn seed_of(text: &[u16]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for &unit in text {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    if hash == 0 { 1 } else { hash }
}

/// xorshift32.
fn stepped(seed: u32) -> impl FnMut() -> u32 {
    let mut state = if seed == 0 { 1 } else { seed };
    move || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        state
    }
}

/// `humanReply`: no em dash, and one to three slips spread across the message.
pub fn human_reply(reply: &str) -> String {
    let text = undash(&js::units(reply));
    let sites = typo_sites(&text);
    if sites.is_empty() {
        return js::string(&text);
    }
    let wanted = 3.min(1 + text.len() / 220);
    let mut next = stepped(seed_of(&text));
    let bucket = sites.len() as f64 / wanted as f64;
    let mut chosen: Vec<usize> = Vec::new();
    for index in 0..wanted {
        let from = (index as f64 * bucket).floor() as usize;
        let to = (from + 1).max(
            sites
                .len()
                .min(((index + 1) as f64 * bucket).floor() as usize),
        );
        let pick = from + (next() as usize) % (to - from);
        if !chosen.contains(&pick) {
            chosen.push(pick);
        }
    }
    chosen.sort_unstable_by(|a, b| b.cmp(a));
    let mut out = text;
    for index in chosen {
        let site = &sites[index];
        out.splice(site.at..site.at + site.len, site.typo.iter().copied());
    }
    js::string(&out)
}

/// `clip(text, limit)`: trimmed, and over the limit both ends are kept around a marker.
pub fn clip(text: &str, limit: usize) -> String {
    let trimmed = js::units(js::trim(text));
    if trimmed.len() <= limit {
        return js::string(&trimmed);
    }
    let marker = js::units("\n[… cut …]\n");
    let budget = limit - marker.len();
    let head = budget.div_ceil(2);
    let tail = budget - head;
    let mut out = trimmed[..head].to_vec();
    out.extend_from_slice(&marker);
    out.extend_from_slice(&trimmed[trimmed.len() - tail..]);
    js::string(&out)
}
