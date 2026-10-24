//! JavaScript string arithmetic the broker repeats: UTF-16 lengths, `trim`, `slice(0, n)` and
//! the worker brief format (`shared/worker-brief.ts`).

fn js_space(ch: char) -> bool {
    matches!(
        ch,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `text.length`.
pub(crate) fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.trim()`.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

/// `text.slice(0, max)` in UTF-16 units. A cut through a surrogate pair keeps the whole
/// character out, where JavaScript keeps a lone half.
pub(crate) fn js_slice(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in text.chars() {
        units += ch.len_utf16();
        if units > max {
            break;
        }
        out.push(ch);
    }
    out
}

/// `text.split(/[\r\n]/, 1)[0]`.
pub(crate) fn first_line(text: &str) -> &str {
    text.split(['\r', '\n']).next().unwrap_or_default()
}

const CONTEXT_HEADING: &str = "Shared context for every worker in this run:";
const TASK_HEADING: &str = "\n\nYour task:\n";

/// `workerBrief`: the run's shared context, when there is one, before the worker's own task.
pub(crate) fn worker_brief(context: &str, task: &str) -> String {
    if context.is_empty() {
        return task.to_owned();
    }
    format!("{CONTEXT_HEADING}\n{context}{TASK_HEADING}{task}")
}

/// `workerOwnTask`: the worker's own task with the shared context removed.
pub(crate) fn worker_own_task(brief: &str) -> &str {
    if !brief.starts_with(CONTEXT_HEADING) {
        return brief;
    }
    let Some(at) = brief.find(TASK_HEADING) else {
        return brief;
    };
    let rest = &brief[at + TASK_HEADING.len()..];
    if rest.contains(TASK_HEADING) {
        return brief;
    }
    let own = js_trim(rest);
    if own.is_empty() { brief } else { own }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_brief_round_trips_to_the_worker_own_task() {
        let brief = worker_brief("Repo X", "Write tests");
        assert_eq!(
            brief,
            "Shared context for every worker in this run:\nRepo X\n\nYour task:\nWrite tests"
        );
        assert_eq!(worker_own_task(&brief), "Write tests");
        assert_eq!(worker_brief("", "Alone"), "Alone");
        assert_eq!(worker_own_task("Alone"), "Alone");
        let twice = format!("{brief}{TASK_HEADING}again");
        assert_eq!(worker_own_task(&twice), twice);
    }

    #[test]
    fn lengths_and_slices_count_utf16_units() {
        assert_eq!(js_length("a\u{1F600}"), 3);
        assert_eq!(js_slice("ab\u{1F600}c", 3), "ab");
        assert_eq!(js_trim("\u{FEFF} x \n"), "x");
    }
}
