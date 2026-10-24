//! The connector's small glob grammar (`globToRegExp` in `search.ts`).
//!
//! `*` is any run within one segment, `?` one character other than `/`, `**/` zero or more
//! whole segments, a bare `**` anything, and every other character is literal. Matching runs over
//! UTF-16 code units with JavaScript's non-Unicode regex rules, so `?` and case folding behave as
//! the TypeScript `RegExp` does.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Token {
    Unit(u16),
    /// `*`: `[^/]*`
    Segment,
    /// `?`: `[^/]`
    One,
    /// `**/`: `(?:.*/)?`
    Directories,
    /// `**`: `.*`
    Anything,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Glob {
    tokens: Vec<Token>,
    case_sensitive: bool,
}

const SLASH: u16 = b'/' as u16;

/// `.` in a JavaScript regex matches every unit except the line terminators.
fn is_line_terminator(unit: u16) -> bool {
    matches!(unit, 0x0a | 0x0d | 0x2028 | 0x2029)
}

/// `Canonicalize` for a non-Unicode case-insensitive JavaScript regex: the simple uppercase of
/// the unit, unless that is not one unit or maps a non-ASCII unit into ASCII.
fn canonicalize(unit: u16) -> u16 {
    let Some(c) = char::from_u32(u32::from(unit)) else {
        return unit;
    };
    let mut upper = c.to_uppercase();
    match (upper.next(), upper.next()) {
        (Some(u), None) if u.len_utf16() == 1 => {
            let mapped = u as u32 as u16;
            if unit >= 128 && mapped < 128 {
                unit
            } else {
                mapped
            }
        }
        _ => unit,
    }
}

impl Glob {
    pub fn new(pattern: &str, case_sensitive: bool) -> Self {
        let units: Vec<u16> = pattern.encode_utf16().collect();
        let star = u16::from(b'*');
        let mut tokens = Vec::new();
        let mut index = 0;
        while index < units.len() {
            let unit = units[index];
            if unit == star {
                if units.get(index + 1) == Some(&star) {
                    if units.get(index + 2) == Some(&SLASH) {
                        tokens.push(Token::Directories);
                        index += 2;
                    } else {
                        tokens.push(Token::Anything);
                        index += 1;
                    }
                } else {
                    tokens.push(Token::Segment);
                }
            } else if unit == u16::from(b'?') {
                tokens.push(Token::One);
            } else {
                tokens.push(Token::Unit(unit));
            }
            index += 1;
        }
        Self {
            tokens,
            case_sensitive,
        }
    }

    /// True when the whole of `text` matches.
    pub fn is_match(&self, text: &str) -> bool {
        let units: Vec<u16> = text.encode_utf16().collect();
        // reachable[i]: the tokens consumed so far can end exactly at unit i.
        let mut reachable = vec![false; units.len() + 1];
        reachable[0] = true;
        for token in &self.tokens {
            let mut next = vec![false; units.len() + 1];
            for start in 0..=units.len() {
                if !reachable[start] {
                    continue;
                }
                match *token {
                    Token::Unit(wanted) => {
                        if units
                            .get(start)
                            .is_some_and(|&unit| self.same(unit, wanted))
                        {
                            next[start + 1] = true;
                        }
                    }
                    Token::One => {
                        if units.get(start).is_some_and(|&unit| unit != SLASH) {
                            next[start + 1] = true;
                        }
                    }
                    Token::Segment => {
                        next[start] = true;
                        for end in start..units.len() {
                            if units[end] == SLASH {
                                break;
                            }
                            next[end + 1] = true;
                        }
                    }
                    Token::Anything => {
                        next[start] = true;
                        for end in start..units.len() {
                            if is_line_terminator(units[end]) {
                                break;
                            }
                            next[end + 1] = true;
                        }
                    }
                    Token::Directories => {
                        next[start] = true;
                        for end in start..units.len() {
                            if units[end] == SLASH {
                                next[end + 1] = true;
                            }
                            if is_line_terminator(units[end]) {
                                break;
                            }
                        }
                    }
                }
            }
            reachable = next;
        }
        reachable[units.len()]
    }

    fn same(&self, unit: u16, wanted: u16) -> bool {
        unit == wanted || (!self.case_sensitive && canonicalize(unit) == canonicalize(wanted))
    }
}
