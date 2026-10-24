//! Exact SendInput semantics, including primary-button swaps and best-effort release
//! after partial injection. Enigo's convenience chords cannot return the OS's partial
//! event count, express raw wheel units or guarantee release order, so this uses Win32.
use super::policy;
use super::win::{self, Result, fail};
use serde_json::Value;
use std::thread;
use std::time::{Duration, Instant};
use windows::Win32::UI::Input::KeyboardAndMouse::*;

const EXTENDED: i32 = 0x1_0000;

trait InputSink {
    fn send(&mut self, events: &[INPUT]) -> Result<()>;
}

struct NativeInput;
impl InputSink for NativeInput {
    fn send(&mut self, events: &[INPUT]) -> Result<()> {
        if events.is_empty() {
            return Ok(());
        }
        policy::require_native_effects()?;
        // SAFETY: INPUT is the SDK's native layout; all records are initialized,
        // and SendInput receives the exact size expected by user32.
        let sent = unsafe { SendInput(events, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize != events.len() {
            return Err(fail(
                "INPUT_FAILED",
                format!(
                    "SendInput was blocked (sent {sent} of {}). A window running as administrator can refuse synthetic input.",
                    events.len()
                ),
            ));
        }
        Ok(())
    }
}

fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn keyboard(key: i32, up: bool) -> INPUT {
    let flags = (if up { KEYEVENTF_KEYUP.0 } else { 0 })
        | (if key & EXTENDED != 0 {
            KEYEVENTF_EXTENDEDKEY.0
        } else {
            0
        });
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY((key & 0xffff) as u16),
                wScan: 0,
                dwFlags: KEYBD_EVENT_FLAGS(flags),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn unicode(key: u16, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: key,
                dwFlags: KEYBD_EVENT_FLAGS(
                    KEYEVENTF_UNICODE.0 | if up { KEYEVENTF_KEYUP.0 } else { 0 },
                ),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn send_move(sink: &mut impl InputSink, x: i32, y: i32) -> Result<()> {
    let sx = win::system_metric(76);
    let sy = win::system_metric(77);
    let sw = win::system_metric(78).max(1);
    let sh = win::system_metric(79).max(1);
    let nx = ((i64::from(x) - i64::from(sx)) * 65_535 / i64::from(sw - 1).max(1)) as i32;
    let ny = ((i64::from(y) - i64::from(sy)) * 65_535 / i64::from(sh - 1).max(1)) as i32;
    sink.send(&[mouse(
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        nx,
        ny,
        0,
    )])
}

fn buttons(button: &str, swapped: bool) -> (MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS) {
    match button {
        "right" => {
            if swapped {
                (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
            } else {
                (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
            }
        }
        "middle" | "wheel" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        _ => {
            if swapped {
                (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
            } else {
                (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
            }
        }
    }
}

fn click_using(
    sink: &mut impl InputSink,
    x: i32,
    y: i32,
    button: &str,
    count: u32,
    swapped: bool,
) -> Result<()> {
    if !(1..=3).contains(&count) {
        return Err(fail("BAD_ACTION", "click count must be between 1 and 3"));
    }
    send_move(sink, x, y)?;
    let (down, up) = buttons(button, swapped);
    let mut events = Vec::with_capacity(count as usize * 2);
    for _ in 0..count {
        events.push(mouse(down, 0, 0, 0));
        events.push(mouse(up, 0, 0, 0));
    }
    if let Err(error) = sink.send(&events) {
        let _ = sink.send(&[mouse(up, 0, 0, 0)]);
        return Err(error);
    }
    Ok(())
}

pub(crate) fn click(x: i32, y: i32, button: &str, count: u32) -> Result<()> {
    // Read *every* time: a cached SM_SWAPBUTTON repeats issue #76 after the user changes it.
    click_using(
        &mut NativeInput,
        x,
        y,
        button,
        count,
        win::system_metric(23) != 0,
    )
}

pub(crate) fn move_to(x: i32, y: i32) -> Result<()> {
    send_move(&mut NativeInput, x, y)
}

pub(crate) fn scroll(x: i32, y: i32, dx: i32, dy: i32, raw: bool) -> Result<()> {
    scroll_using(&mut NativeInput, x, y, dx, dy, raw)
}

fn scroll_using(
    sink: &mut impl InputSink,
    x: i32,
    y: i32,
    dx: i32,
    dy: i32,
    raw: bool,
) -> Result<()> {
    let unit = if raw { 1 } else { 120 };
    let mut events = Vec::new();
    if dy != 0 {
        let delta = -i64::from(dy) * unit;
        let delta = i32::try_from(delta)
            .map_err(|_| fail("BAD_ACTION", "vertical wheel delta overflow"))?;
        events.push(mouse(MOUSEEVENTF_WHEEL, 0, 0, delta as u32));
    }
    if dx != 0 {
        let delta = i64::from(dx) * unit;
        let delta = i32::try_from(delta)
            .map_err(|_| fail("BAD_ACTION", "horizontal wheel delta overflow"))?;
        events.push(mouse(MOUSEEVENTF_HWHEEL, 0, 0, delta as u32));
    }
    // Overflow is a deterministic invalid action. Refuse before even moving
    // the cursor, so a failed wheel cannot produce an unexplained pointer effect.
    send_move(sink, x, y)?;
    sink.send(&events)
}

pub(crate) fn drag(xs: &[i32], ys: &[i32], button: &str, duration: u32) -> Result<()> {
    drag_using(
        &mut NativeInput,
        xs,
        ys,
        button,
        duration,
        win::system_metric(23) != 0,
    )
}

fn drag_using(
    sink: &mut impl InputSink,
    xs: &[i32],
    ys: &[i32],
    button: &str,
    duration: u32,
    swapped: bool,
) -> Result<()> {
    if xs.len() != ys.len() || !(2..=64).contains(&xs.len()) || !(50..=2000).contains(&duration) {
        return Err(fail(
            "BAD_ACTION",
            "drag requires 2-64 points and a 50-2000 ms duration",
        ));
    }
    let mut lengths = vec![0.0f64; xs.len()];
    for i in 1..xs.len() {
        let dx = f64::from(xs[i]) - f64::from(xs[i - 1]);
        let dy = f64::from(ys[i]) - f64::from(ys[i - 1]);
        lengths[i] = lengths[i - 1] + dx.hypot(dy);
    }
    send_move(sink, xs[0], ys[0])?;
    let (down, up) = buttons(button, swapped);
    if let Err(error) = sink.send(&[mouse(down, 0, 0, 0)]) {
        // A short SendInput reply can mean the down was applied before the
        // error. Best-effort release is mandatory even in this first packet.
        let _ = sink.send(&[mouse(up, 0, 0, 0)]);
        return Err(error);
    }
    let actual = (|| -> Result<()> {
        let steps = (duration.div_ceil(10)).clamp(2, 256);
        let clock = Instant::now();
        let mut segment = 1;
        for step in 1..=steps {
            let progress = lengths[xs.len() - 1] * f64::from(step) / f64::from(steps);
            while segment < lengths.len() - 1 && lengths[segment] < progress {
                segment += 1;
            }
            let length = lengths[segment] - lengths[segment - 1];
            let fraction = if length <= 0.0 {
                1.0
            } else {
                (progress - lengths[segment - 1]) / length
            };
            let x = (f64::from(xs[segment - 1])
                + (f64::from(xs[segment]) - f64::from(xs[segment - 1])) * fraction)
                .round() as i32;
            let y = (f64::from(ys[segment - 1])
                + (f64::from(ys[segment]) - f64::from(ys[segment - 1])) * fraction)
                .round() as i32;
            send_move(sink, x, y)?;
            let remaining =
                Duration::from_millis(u64::from(duration) * u64::from(step) / u64::from(steps))
                    .saturating_sub(clock.elapsed());
            if !remaining.is_zero() {
                thread::sleep(remaining.min(Duration::from_millis(10)));
            }
        }
        Ok(())
    })();
    // Every drag releases the button even if its motion fails.
    let release = sink.send(&[mouse(up, 0, 0, 0)]);
    actual.and(release)
}

pub(crate) fn type_text(text: &str) -> Result<()> {
    type_text_using(&mut NativeInput, text)
}

fn type_text_using(sink: &mut impl InputSink, text: &str) -> Result<()> {
    if text.contains(['\r', '\n']) {
        return Err(fail(
            "MULTILINE_REQUIRES_PASTE",
            "literal multiline text requires the clipboard paste action",
        ));
    }
    let mut batch = Vec::with_capacity(200);
    for character in text.encode_utf16() {
        batch.push(unicode(character, false));
        batch.push(unicode(character, true));
        if batch.len() >= 200 {
            send_unicode(sink, &batch)?;
            batch.clear();
        }
    }
    send_unicode(sink, &batch)
}

fn send_unicode(sink: &mut impl InputSink, events: &[INPUT]) -> Result<()> {
    if let Err(error) = sink.send(events) {
        let release: Vec<_> = events
            .iter()
            .filter_map(|event| {
                // SAFETY: callers construct only keyboard records for this helper.
                let key = unsafe { event.Anonymous.ki };
                if key.dwFlags.0 & KEYEVENTF_KEYUP.0 == 0 {
                    Some(unicode(key.wScan, true))
                } else {
                    None
                }
            })
            .collect();
        let _ = sink.send(&release);
        return Err(error);
    }
    Ok(())
}

pub(crate) fn keypress(resolved: &[i32]) -> Result<()> {
    keypress_using(&mut NativeInput, resolved)
}

fn keypress_using(sink: &mut impl InputSink, resolved: &[i32]) -> Result<()> {
    let down = resolved
        .iter()
        .map(|key| keyboard(*key, false))
        .collect::<Vec<_>>();
    let up = resolved
        .iter()
        .rev()
        .map(|key| keyboard(*key, true))
        .collect::<Vec<_>>();
    let result = sink.send(&down);
    if result.is_ok() {
        thread::sleep(Duration::from_millis(35));
    }
    // Releases are attempted even after partial down injection.
    let released = sink.send(&up);
    result.and(released)
}

fn named(key: &str) -> Option<i32> {
    let code = match key {
        "CTRL" | "CONTROL" => 0x11,
        "SHIFT" => 0x10,
        "ALT" | "OPTION" => 0x12,
        "CONTROL_L" | "CTRL_L" => 0xa2,
        "CONTROL_R" | "CTRL_R" => EXTENDED | 0xa3,
        "SHIFT_L" => 0xa0,
        "SHIFT_R" => 0xa1,
        "ALT_L" => 0xa4,
        "ALT_R" => EXTENDED | 0xa5,
        "WIN" | "WINDOWS" | "SUPER" | "META" | "CMD" | "COMMAND" | "SUPER_L" | "META_L" => {
            EXTENDED | 0x5b
        }
        "SUPER_R" | "META_R" => EXTENDED | 0x5c,
        "ENTER" | "RETURN" => 0x0d,
        "TAB" => 0x09,
        "ESC" | "ESCAPE" => 0x1b,
        "SPACE" => 0x20,
        "BACKSPACE" | "BACK_SPACE" | "BKSP" => 0x08,
        "DELETE" | "DEL" => EXTENDED | 0x2e,
        "INSERT" | "INS" => EXTENDED | 0x2d,
        "HOME" => EXTENDED | 0x24,
        "END" => EXTENDED | 0x23,
        "PAGEUP" | "PAGE_UP" | "PGUP" | "PRIOR" => EXTENDED | 0x21,
        "PAGEDOWN" | "PAGE_DOWN" | "PGDN" | "NEXT" => EXTENDED | 0x22,
        "UP" | "ARROWUP" => EXTENDED | 0x26,
        "DOWN" | "ARROWDOWN" => EXTENDED | 0x28,
        "LEFT" | "ARROWLEFT" => EXTENDED | 0x25,
        "RIGHT" | "ARROWRIGHT" => EXTENDED | 0x27,
        "PRINTSCREEN" | "PRINT" => EXTENDED | 0x2c,
        "CAPSLOCK" | "CAPS_LOCK" => 0x14,
        "NUMLOCK" | "NUM_LOCK" => EXTENDED | 0x90,
        "SCROLLLOCK" | "SCROLL_LOCK" => 0x91,
        "PAUSE" => 0x13,
        "MENU" | "APPS" => EXTENDED | 0x5d,
        "KP_ENTER" => EXTENDED | 0x0d,
        "KP_ADD" => 0x6b,
        "KP_SUBTRACT" => 0x6d,
        "KP_MULTIPLY" => 0x6a,
        "KP_DIVIDE" => EXTENDED | 0x6f,
        "KP_DECIMAL" => 0x6e,
        "KP_SEPARATOR" => 0x6c,
        "KP_HOME" => 0x24,
        "KP_END" => 0x23,
        "KP_UP" => 0x26,
        "KP_DOWN" => 0x28,
        "KP_LEFT" => 0x25,
        "KP_RIGHT" => 0x27,
        "KP_PRIOR" => 0x21,
        "KP_NEXT" => 0x22,
        "KP_INSERT" => 0x2d,
        "KP_DELETE" => 0x2e,
        _ => return None,
    };
    Some(code)
}

fn symbol(name: &str) -> Option<char> {
    match name {
        "MINUS" => Some('-'),
        "EQUALS" | "EQUAL" => Some('='),
        "PLUS" => Some('+'),
        "LBRACKET" | "BRACKETLEFT" => Some('['),
        "RBRACKET" | "BRACKETRIGHT" => Some(']'),
        "BACKSLASH" => Some('\\'),
        "SEMICOLON" => Some(';'),
        "COLON" => Some(':'),
        "QUOTE" | "APOSTROPHE" => Some('\''),
        "QUOTEDBL" => Some('"'),
        "COMMA" => Some(','),
        "PERIOD" => Some('.'),
        "SLASH" => Some('/'),
        "QUESTION" => Some('?'),
        "GREATER" => Some('>'),
        "LESS" => Some('<'),
        "BACKQUOTE" | "GRAVE" => Some('`'),
        "TILDE" | "ASCIITILDE" => Some('~'),
        "EXCLAM" => Some('!'),
        "AT" => Some('@'),
        "NUMBERSIGN" => Some('#'),
        "DOLLAR" => Some('$'),
        "PERCENT" => Some('%'),
        "ASCIICIRCUM" => Some('^'),
        "AMPERSAND" => Some('&'),
        "ASTERISK" => Some('*'),
        "PARENLEFT" => Some('('),
        "PARENRIGHT" => Some(')'),
        "UNDERSCORE" => Some('_'),
        "BRACELEFT" => Some('{'),
        "BRACERIGHT" => Some('}'),
        "BAR" => Some('|'),
        _ => None,
    }
}

fn modifier_group(key: i32) -> i32 {
    match key & 0xffff {
        0x10 | 0xa0 | 0xa1 => 1,
        0x11 | 0xa2 | 0xa3 => 2,
        0x12 | 0xa4 | 0xa5 => 4,
        0x5b | 0x5c => 8,
        _ => 0,
    }
}

pub(crate) fn resolve_keys_with<F>(keys: &[Value], mut translate: F) -> Result<Vec<i32>>
where
    F: FnMut(char) -> Option<i16>,
{
    if keys.is_empty() || keys.len() > 16 {
        return Err(fail("BAD_KEY", "a chord needs between 1 and 16 keys"));
    }
    let mut modifiers = Vec::new();
    let mut normals = Vec::new();
    let mut required = 0;
    for key in keys {
        let raw = key
            .as_str()
            .ok_or_else(|| fail("BAD_KEY", "key name is invalid"))?;
        let name = raw.trim().to_ascii_uppercase();
        if name.is_empty() {
            return Err(fail("BAD_KEY", "key name is empty"));
        }
        let name = name
            .strip_prefix("NUMPAD_")
            .map(|tail| format!("KP_{tail}"))
            .unwrap_or(name);
        let code = if let Some(named) = named(&name) {
            named
        } else if let Some(num) = name
            .strip_prefix('F')
            .and_then(|x| x.parse::<i32>().ok())
            .filter(|n| (1..=24).contains(n))
        {
            0x6f + num
        } else if let Some(digit) = name
            .strip_prefix("KP_")
            .filter(|s| s.len() == 1)
            .and_then(|s| s.chars().next())
            .filter(char::is_ascii_digit)
        {
            0x60 + digit.to_digit(10).unwrap_or(0) as i32
        } else if name.len() == 1 && name.chars().all(|x| x.is_ascii_alphanumeric()) {
            name.as_bytes()[0] as i32
        } else {
            let c = symbol(&name)
                .or_else(|| {
                    let mut chars = name.chars();
                    let c = chars.next()?;
                    if chars.next().is_some() || c.is_control() {
                        None
                    } else {
                        Some(c)
                    }
                })
                .ok_or_else(|| fail("BAD_KEY", format!("unsupported key {name}")))?;
            let mapped = translate(c).ok_or_else(|| {
                fail(
                    "BAD_KEY",
                    format!("key is unavailable in the target keyboard layout: {name}"),
                )
            })?;
            if mapped == -1 || ((i32::from(mapped) >> 8) & 0xff) > 7 {
                return Err(fail(
                    "BAD_KEY",
                    format!("key is unavailable in the target keyboard layout: {name}"),
                ));
            }
            required |= (i32::from(mapped) >> 8) & 7;
            i32::from(mapped) & 0xff
        };
        if modifier_group(code) != 0 {
            if !modifiers.contains(&code) {
                modifiers.push(code);
            }
        } else {
            if normals.contains(&code) {
                return Err(fail("BAD_KEY", "chord repeats a key"));
            }
            normals.push(code);
        }
    }
    let present = modifiers
        .iter()
        .fold(0, |acc, item| acc | modifier_group(*item));
    if required & 1 != 0 && present & 1 == 0 {
        modifiers.push(0x10);
    }
    if required & 2 != 0 && present & 2 == 0 {
        modifiers.push(0x11);
    }
    if required & 4 != 0 && present & 4 == 0 {
        modifiers.push(0x12);
    }
    modifiers.extend(normals);
    Ok(modifiers)
}

pub(crate) fn resolve_keys(keys: &[Value], window: i64) -> Result<Vec<i32>> {
    let (layout, _) = win::layout(window)?;
    resolve_keys_with(keys, |ch| win::vk_scan(ch, layout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Event {
        Key {
            vk: u16,
            scan: u16,
            flags: u32,
        },
        Mouse {
            flags: u32,
            delta: i32,
            x: i32,
            y: i32,
        },
    }

    #[derive(Default)]
    struct RecordingSink {
        calls: Vec<Vec<Event>>,
        fail_on: Option<usize>,
        also_fail_on: Option<usize>,
    }

    impl InputSink for RecordingSink {
        fn send(&mut self, events: &[INPUT]) -> Result<()> {
            let mut call = Vec::new();
            for event in events {
                if event.r#type == INPUT_KEYBOARD {
                    // SAFETY: tagged INPUT_KEYBOARD instances contain an initialized KEYBDINPUT.
                    let key = unsafe { event.Anonymous.ki };
                    call.push(Event::Key {
                        vk: key.wVk.0,
                        scan: key.wScan,
                        flags: key.dwFlags.0,
                    });
                } else if event.r#type == INPUT_MOUSE {
                    // SAFETY: tagged INPUT_MOUSE instances contain an initialized MOUSEINPUT.
                    let mouse = unsafe { event.Anonymous.mi };
                    call.push(Event::Mouse {
                        flags: mouse.dwFlags.0,
                        delta: mouse.mouseData as i32,
                        x: mouse.dx,
                        y: mouse.dy,
                    });
                }
            }
            self.calls.push(call);
            if self.fail_on == Some(self.calls.len()) || self.also_fail_on == Some(self.calls.len())
            {
                return Err(fail(
                    "INPUT_FAILED",
                    format!("simulated short SendInput on call {}", self.calls.len()),
                ));
            }
            Ok(())
        }
    }

    #[test]
    fn partial_chord_attempts_reverse_releases_with_extended_flags() {
        let mut sink = RecordingSink {
            fail_on: Some(1),
            ..Default::default()
        };
        let error = keypress_using(&mut sink, &[0x11, EXTENDED | 0x25]).err();
        assert_eq!(error.map(|e| e.code), Some("INPUT_FAILED"));
        assert_eq!(sink.calls.len(), 2);
        assert_eq!(
            sink.calls[0],
            vec![
                Event::Key {
                    vk: 0x11,
                    scan: 0,
                    flags: 0
                },
                Event::Key {
                    vk: 0x25,
                    scan: 0,
                    flags: KEYEVENTF_EXTENDEDKEY.0
                }
            ]
        );
        assert_eq!(
            sink.calls[1],
            vec![
                Event::Key {
                    vk: 0x25,
                    scan: 0,
                    flags: KEYEVENTF_KEYUP.0 | KEYEVENTF_EXTENDEDKEY.0
                },
                Event::Key {
                    vk: 0x11,
                    scan: 0,
                    flags: KEYEVENTF_KEYUP.0
                }
            ]
        );
    }

    #[test]
    fn partial_unicode_releases_each_attempted_utf16_down_and_preserves_error() {
        let mut sink = RecordingSink {
            fail_on: Some(1),
            ..Default::default()
        };
        assert_eq!(
            type_text_using(&mut sink, "a🦀").err().map(|e| e.code),
            Some("INPUT_FAILED")
        );
        assert_eq!(sink.calls.len(), 2);
        let code_units = "a🦀".encode_utf16().collect::<Vec<_>>();
        assert_eq!(
            sink.calls[0],
            code_units
                .iter()
                .flat_map(|ch| [
                    Event::Key {
                        vk: 0,
                        scan: *ch,
                        flags: KEYEVENTF_UNICODE.0
                    },
                    Event::Key {
                        vk: 0,
                        scan: *ch,
                        flags: KEYEVENTF_UNICODE.0 | KEYEVENTF_KEYUP.0
                    },
                ])
                .collect::<Vec<_>>()
        );
        assert_eq!(
            sink.calls[1],
            code_units
                .iter()
                .map(|ch| Event::Key {
                    vk: 0,
                    scan: *ch,
                    flags: KEYEVENTF_UNICODE.0 | KEYEVENTF_KEYUP.0
                })
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn unicode_typing_refuses_multiline_without_any_input_packet() {
        let mut sink = RecordingSink::default();
        let failed = type_text_using(&mut sink, "a\nb\r\nc").err();
        assert_eq!(
            failed.map(|error| error.code),
            Some("MULTILINE_REQUIRES_PASTE")
        );
        assert!(sink.calls.is_empty());

        assert!(type_text_using(&mut sink, "a🦀").is_ok());
        assert_eq!(sink.calls.len(), 1);
        assert_eq!(sink.calls[0].len(), "a🦀".encode_utf16().count() * 2);
    }

    #[test]
    fn clicks_emit_exact_pairs_and_primary_swaps_both_halves() {
        for count in 1..=3 {
            let mut sink = RecordingSink::default();
            assert!(click_using(&mut sink, 5, 6, "left", count, true).is_ok());
            assert_eq!(sink.calls.len(), 2);
            let pair = [
                Event::Mouse {
                    flags: MOUSEEVENTF_RIGHTDOWN.0,
                    delta: 0,
                    x: 0,
                    y: 0,
                },
                Event::Mouse {
                    flags: MOUSEEVENTF_RIGHTUP.0,
                    delta: 0,
                    x: 0,
                    y: 0,
                },
            ];
            assert_eq!(
                sink.calls[1],
                (0..count)
                    .flat_map(|_| pair.iter().cloned())
                    .collect::<Vec<_>>()
            );
        }
        for button in ["right", "middle"] {
            let mut sink = RecordingSink::default();
            assert!(click_using(&mut sink, 5, 6, button, 1, true).is_ok());
            let (down, up) = if button == "right" {
                (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
            } else {
                (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP)
            };
            assert_eq!(
                sink.calls[1],
                vec![
                    Event::Mouse {
                        flags: down.0,
                        delta: 0,
                        x: 0,
                        y: 0
                    },
                    Event::Mouse {
                        flags: up.0,
                        delta: 0,
                        x: 0,
                        y: 0
                    }
                ]
            );
        }
        for count in [0, 4] {
            let mut sink = RecordingSink::default();
            assert_eq!(
                click_using(&mut sink, 5, 6, "left", count, false)
                    .err()
                    .map(|e| e.code),
                Some("BAD_ACTION")
            );
            assert!(sink.calls.is_empty());
        }
    }

    #[test]
    fn partial_click_always_attempts_release_and_keeps_original_failure() {
        let mut sink = RecordingSink {
            fail_on: Some(2),
            also_fail_on: Some(3),
            ..Default::default()
        };
        let failure = click_using(&mut sink, 5, 6, "left", 1, true).err();
        assert_eq!(failure.as_ref().map(|e| e.code), Some("INPUT_FAILED"));
        assert_eq!(
            failure.as_ref().map(|e| e.message.as_str()),
            Some("simulated short SendInput on call 2")
        );
        assert_eq!(sink.calls.len(), 3);
        assert_eq!(
            sink.calls[2],
            vec![Event::Mouse {
                flags: MOUSEEVENTF_RIGHTUP.0,
                delta: 0,
                x: 0,
                y: 0
            }]
        );
    }

    #[test]
    fn chord_and_drag_do_not_report_success_when_final_release_fails() {
        let mut keys = RecordingSink {
            fail_on: Some(2),
            ..Default::default()
        };
        assert_eq!(
            keypress_using(&mut keys, &[EXTENDED | 0x25])
                .err()
                .map(|e| e.code),
            Some("INPUT_FAILED")
        );
        assert_eq!(keys.calls.len(), 2);
        assert_eq!(
            keys.calls[1],
            vec![Event::Key {
                vk: 0x25,
                scan: 0,
                flags: KEYEVENTF_EXTENDEDKEY.0 | KEYEVENTF_KEYUP.0
            }]
        );

        // A 50 ms drag has five move steps after its initial move/down. The
        // final release is the eighth SendInput call; its failure must surface.
        let mut pointer = RecordingSink {
            fail_on: Some(8),
            ..Default::default()
        };
        assert_eq!(
            drag_using(&mut pointer, &[1, 2], &[1, 2], "left", 50, false)
                .err()
                .map(|e| e.code),
            Some("INPUT_FAILED")
        );
        assert_eq!(pointer.calls.len(), 8);
        assert_eq!(
            pointer.calls.last(),
            Some(&vec![Event::Mouse {
                flags: MOUSEEVENTF_LEFTUP.0,
                delta: 0,
                x: 0,
                y: 0
            }])
        );
    }

    #[test]
    fn raw_and_detent_wheels_keep_signs_and_validate_before_moving() {
        for (raw, vertical, horizontal) in [(true, 3, 2), (false, 360, 240)] {
            let mut sink = RecordingSink::default();
            assert!(scroll_using(&mut sink, 1, 1, 2, -3, raw).is_ok());
            assert_eq!(sink.calls.len(), 2);
            assert_eq!(
                sink.calls[1],
                vec![
                    Event::Mouse {
                        flags: MOUSEEVENTF_WHEEL.0,
                        delta: vertical,
                        x: 0,
                        y: 0
                    },
                    Event::Mouse {
                        flags: MOUSEEVENTF_HWHEEL.0,
                        delta: horizontal,
                        x: 0,
                        y: 0
                    }
                ]
            );
        }
        for (x, y, raw) in [
            (i32::MAX, 1, false),
            (1, i32::MIN, false),
            (1, i32::MIN, true),
        ] {
            let mut sink = RecordingSink::default();
            assert_eq!(
                scroll_using(&mut sink, 1, 1, x, y, raw)
                    .err()
                    .map(|e| e.code),
                Some("BAD_ACTION")
            );
            assert!(
                sink.calls.is_empty(),
                "overflow must not even move the pointer"
            );
        }
    }

    #[test]
    fn drag_rejects_bad_shapes_before_injection_and_releases_failed_down_or_motion() {
        for (xs, ys, duration) in [
            (vec![], vec![], 50),
            (vec![1], vec![1], 50),
            (vec![1, 2], vec![1], 50),
            (vec![1, 2], vec![1, 2], 49),
            (vec![1, 2], vec![1, 2], 2001),
            (vec![0; 65], vec![0; 65], 50),
        ] {
            let mut sink = RecordingSink::default();
            assert_eq!(
                drag_using(&mut sink, &xs, &ys, "left", duration, false)
                    .err()
                    .map(|e| e.code),
                Some("BAD_ACTION")
            );
            assert!(sink.calls.is_empty());
        }
        for fail_on in [2, 3] {
            let mut sink = RecordingSink {
                fail_on: Some(fail_on),
                ..Default::default()
            };
            assert_eq!(
                drag_using(&mut sink, &[1, 2], &[1, 2], "left", 50, false)
                    .err()
                    .map(|e| e.code),
                Some("INPUT_FAILED")
            );
            assert_eq!(
                sink.calls.last(),
                Some(&vec![Event::Mouse {
                    flags: MOUSEEVENTF_LEFTUP.0,
                    delta: 0,
                    x: 0,
                    y: 0
                }])
            );
        }
    }

    #[test]
    fn drag_finishes_at_requested_absolute_endpoint_and_releases_primary_button() {
        let mut sink = RecordingSink::default();
        assert!(drag_using(&mut sink, &[1, 5, 10], &[1, 5, 10], "left", 50, true).is_ok());
        let expected_end = {
            let mut sink = RecordingSink::default();
            assert!(send_move(&mut sink, 10, 10).is_ok());
            sink.calls.remove(0)
        };
        assert_eq!(sink.calls[sink.calls.len() - 2], expected_end);
        assert_eq!(
            sink.calls.last(),
            Some(&vec![Event::Mouse {
                flags: MOUSEEVENTF_RIGHTUP.0,
                delta: 0,
                x: 0,
                y: 0
            }])
        );
    }
    #[test]
    fn windows_keys_target_layout_and_altgr() {
        let keys = |list: &[&str]| {
            list.iter()
                .map(|key| Value::String((*key).to_owned()))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            resolve_keys_with(&keys(&["Control_L", "greater"]), |ch| (ch == '>')
                .then_some(0x1be))
            .ok(),
            Some(vec![0xa2, 0x10, 0xbe])
        );
        assert_eq!(
            resolve_keys_with(&keys(&["Control_R", "at"]), |ch| (ch == '@')
                .then_some(0x651))
            .ok(),
            Some(vec![EXTENDED | 0xa3, 0x12, 0x51])
        );
        assert_eq!(
            resolve_keys_with(&keys(&["Numpad_Enter"]), |_| None).ok(),
            Some(vec![EXTENDED | 0x0d])
        );
        assert_eq!(
            resolve_keys_with(&keys(&["KP_0", "F24"]), |_| None).ok(),
            Some(vec![0x60, 0x87])
        );
        assert!(resolve_keys_with(&keys(&["imaginary"]), |_| None).is_err());
    }
    #[test]
    fn primary_swapped_button_is_rechecked_per_action() {
        assert_eq!(
            buttons("left", false),
            (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
        );
        assert_eq!(
            buttons("left", true),
            (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
        );
        assert_eq!(
            buttons("right", true),
            (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
        );
    }
}
