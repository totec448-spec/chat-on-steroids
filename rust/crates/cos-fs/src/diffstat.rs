//! Line add/remove counts for an edit, for the "+18 −4" in the activity timeline
//! (`diffstat.ts`).
//!
//! Common leading and trailing lines are trimmed first. A small remainder gets an exact LCS; a
//! large one gets a Myers pass bounded by edit distance, and only a true large rewrite falls
//! back to the trimmed block sizes, flagged as approximate.

/// Above this many lines on either side, the LCS pass is skipped as too expensive.
const LCS_LINE_LIMIT: usize = 1500;
/// Maximum edit distance the sparse Myers pass will chase on a large remaining block.
const MYERS_EDIT_LIMIT: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LineDelta {
    pub added: usize,
    pub removed: usize,
    /// True when the numbers are bounded rather than the result of a real diff.
    pub approximate: bool,
}

fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find(['\r', '\n']) {
        lines.push(&rest[..at]);
        let width = if rest[at..].starts_with("\r\n") { 2 } else { 1 };
        rest = &rest[at + width..];
    }
    // A trailing newline leaves one empty piece that is not a real line.
    if !rest.is_empty() {
        lines.push(rest);
    }
    lines
}

/// Length of the longest common subsequence, in two rolling rows.
fn lcs_length(a: &[&str], b: &[&str]) -> usize {
    let mut previous = vec![0usize; b.len() + 1];
    let mut current = vec![0usize; b.len() + 1];
    for line in a {
        for j in 1..=b.len() {
            current[j] = if *line == b[j - 1] {
                previous[j - 1] + 1
            } else {
                previous[j].max(current[j - 1])
            };
        }
        std::mem::swap(&mut previous, &mut current);
        current.fill(0);
    }
    previous[b.len()]
}

/// Exact insert/delete edit distance when it is at most `MYERS_EDIT_LIMIT`.
fn bounded_myers_distance(a: &[&str], b: &[&str]) -> Option<usize> {
    let (n, m) = (a.len() as isize, b.len() as isize);
    let max_d = MYERS_EDIT_LIMIT.min(a.len() + b.len()) as isize;
    let offset = max_d + 1;
    let mut frontier = vec![-1isize; (2 * max_d + 3) as usize];
    frontier[(offset + 1) as usize] = 0;
    for d in 0..=max_d {
        let mut k = -d;
        while k <= d {
            let index = (offset + k) as usize;
            let mut x = if k == -d || (k != d && frontier[index - 1] < frontier[index + 1]) {
                frontier[index + 1]
            } else {
                frontier[index - 1] + 1
            };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            frontier[index] = x;
            if x >= n && y >= m {
                return Some(d as usize);
            }
            k += 2;
        }
    }
    None
}

/// Added and removed line counts between two versions of the same text.
pub fn line_delta(before: &str, after: &str) -> LineDelta {
    let exact = |added, removed| LineDelta {
        added,
        removed,
        approximate: false,
    };
    if before == after {
        return exact(0, 0);
    }
    let old_lines = split_lines(before);
    let new_lines = split_lines(after);
    let start = old_lines
        .iter()
        .zip(&new_lines)
        .take_while(|(a, b)| a == b)
        .count();
    let end = old_lines[start..]
        .iter()
        .rev()
        .zip(new_lines[start..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let old_block = &old_lines[start..old_lines.len() - end];
    let new_block = &new_lines[start..new_lines.len() - end];

    // One side empty is a pure insertion or deletion, which needs no diff at all.
    if old_block.is_empty() || new_block.is_empty() {
        return exact(new_block.len(), old_block.len());
    }
    if old_block.len() > LCS_LINE_LIMIT || new_block.len() > LCS_LINE_LIMIT {
        return match bounded_myers_distance(old_block, new_block) {
            Some(distance) => {
                let added = (distance + new_block.len() - old_block.len()) / 2;
                exact(added, distance - added)
            }
            None => LineDelta {
                added: new_block.len(),
                removed: old_block.len(),
                approximate: true,
            },
        };
    }
    let common = lcs_length(old_block, new_block);
    exact(new_block.len() - common, old_block.len() - common)
}

/// `+18 −4`, `+214`, `−83`, or `None` when nothing changed.
pub fn format_delta(added: usize, removed: usize) -> Option<String> {
    match (added, removed) {
        (0, 0) => None,
        (added, 0) => Some(format!("+{added}")),
        (0, removed) => Some(format!("\u{2212}{removed}")),
        (added, removed) => Some(format!("+{added} \u{2212}{removed}")),
    }
}
