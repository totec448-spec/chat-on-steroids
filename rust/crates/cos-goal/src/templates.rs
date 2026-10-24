//! The offline Goal protocol (`shared/goal-templates.ts`): only an exact last line is
//! actionable, and a missing marker pauses the run.

use crate::decision::Decision;

pub const MARKER_INSTRUCTION: &str = "\n\nFor this Goal session only: at the end of each final reply, write exactly one separate last line: [[COS_GOAL:COMPLETE]] if the entire requested task is finished, or [[COS_GOAL:CONTINUE]] if requested work remains. Do not claim completion for partial work. If user input is required, explain it and omit both markers.";

const OPENINGS: [&str; 20] = [
    "Keep going until the requested work is finished.",
    "Finish the unfinished parts of my request.",
    "Continue the task from where you left off.",
    "Get back to the concrete work that remains.",
    "Carry the original request through to completion.",
    "Complete the next unfinished requirement.",
    "Follow through on the work you just identified.",
    "Keep working toward the stated finish line.",
    "Resolve what is still missing from my request.",
    "Pick up the remaining work and finish it.",
    "Turn the next announced step into completed work.",
    "Continue with the remaining requested changes.",
    "Work through the unresolved items in my request.",
    "Bring the requested task to its actual conclusion.",
    "Keep making progress on the goal I gave you.",
    "Complete the required work that is still pending.",
    "Continue the work you have already started.",
    "Address the outstanding part of the original task.",
    "Keep going on the job until the requested result is ready.",
    "Finish the remaining work instead of just promising it.",
];

const CLOSINGS: [&str; 10] = [
    "Stay within what I asked for.",
    "Use the context already in this conversation.",
    "Do the next concrete step now.",
    "Do not add unrelated work.",
    "Keep the original requirements in view.",
    "Focus on the parts that are still incomplete.",
    "Respect the constraints I already gave you.",
    "Use the results you already have.",
    "Keep the update brief and get back to the work.",
    "Stop when the requested goal is fully complete.",
];

/// How many continuations there are (`GOAL_CONTINUATIONS.length`).
pub const CONTINUATIONS: usize = OPENINGS.len() * CLOSINGS.len();

/// `GOAL_CONTINUATIONS[slot]`: every opening with each closing, openings outermost.
pub fn continuation(slot: usize) -> String {
    let slot = slot % CONTINUATIONS;
    format!(
        "{} {}",
        OPENINGS[slot / CLOSINGS.len()],
        CLOSINGS[slot % CLOSINGS.len()]
    )
}

/// `templateGoalDecision(final, slot, secondSlot)`.
pub fn decision(last_answer: &str, slot: u64, second_slot: u64) -> Decision {
    let last = crate::js::trim(last_answer)
        .split('\n')
        .next_back()
        .map(|line| crate::js::trim(line.strip_suffix('\r').unwrap_or(line)));
    if last == Some("[[COS_GOAL:COMPLETE]]") {
        return Decision::Stop;
    }
    if last != Some("[[COS_GOAL:CONTINUE]]") {
        return Decision::Invalid("goal_marker_missing".to_owned());
    }
    let first = (slot % CONTINUATIONS as u64) as usize;
    let mut second = (second_slot % CONTINUATIONS as u64) as usize;
    if second == first {
        second = (first + 1) % CONTINUATIONS;
    }
    Decision::Continue(format!(
        "{} {}{MARKER_INSTRUCTION}",
        continuation(first),
        continuation(second)
    ))
}
