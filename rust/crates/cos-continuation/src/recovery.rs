//! The recovery constants and the Automatic Continue message (`shared/recovery.ts`).

/// `BROWSER_PICKUP_MAX_ATTEMPTS`: a pickup is offered at most three times.
pub const BROWSER_PICKUP_MAX_ATTEMPTS: u32 = 3;
/// `BROWSER_PICKUP_BACKOFF_MS`: after 2, 5 and 10 minutes.
pub const BROWSER_PICKUP_BACKOFF_MS: [u64; 3] = [2 * 60_000, 5 * 60_000, 10 * 60_000];

const CONTINUE_TEXTS: [&str; 10] = [
    "Continue until you are fully finished.",
    "Keep going until the task is done.",
    "Carry on until everything requested is finished.",
    "Please continue and finish the whole task.",
    "Resume the work and see it through.",
    "Keep working until the request is complete.",
    "Pick up where you left off and finish.",
    "Continue through the remaining work to completion.",
    "Carry on and finish what was requested.",
    "Resume and keep going until fully done.",
];

const RECOVERY_NOTES: [&str; 10] = [
    "The previous turn appears interrupted without a final answer; some work may already be done even if earlier tool calls are missing, so check the current state before repeating anything.",
    "Your last turn seems to have cut off; earlier tool calls may no longer be visible, so inspect what is already implemented and continue from there.",
    "The previous response ended without a final answer; you may already have completed part of the task, so verify the current state even if its tool history is missing.",
    "This turn appears to have been interrupted; missing tool calls do not mean no work happened, so check the existing results and build on them.",
    "The last turn did not deliver a final answer; some changes may already be in place despite gaps in the tool history, so check them before doing the same work again.",
    "The previous turn seems to have stopped unexpectedly; earlier work may still be present even if you cannot see its tool calls, so inspect the current state first.",
    "Your response appears to have stalled before its final answer; check for work already completed, because its tool calls may be absent from the visible history.",
    "The last response appears interrupted; some requested work may already exist even when prior tool calls are unavailable, so verify it and resume from the actual state.",
    "The previous turn stopped without a final answer; look for changes you already made rather than assuming missing tool history means you have not started.",
    "This looks like an interrupted turn; inspect the current results for completed work even if earlier tool calls are no longer visible, then finish what remains.",
];

const RECOVERY_SUFFIXES: [&str; 11] = [
    "Meme joke: tur tur sahur is my imaginary alarm clock.",
    "Fun fact: che put a mannequin and a fish tank on his dream-studio wish list.",
    "Fun fact: osamason had a cat named Flexer in his January 2025 FADER interview.",
    "Fun fact: nettspend picked Man in the Mirror when asked for his favorite Michael Jackson song.",
    "Fun fact: BLEOOD performed at Brooklyn venue Elsewhere on his 2026 PROTAGONIST tour.",
    "Fun fact: 2slimey said Italian jazz and mountain views help spark his ideas.",
    "Fun fact: kai angel said seeing the Viper Room sign in Hollywood inspired the Viperr name.",
    "Fun fact: 9mice answered 2030 when asked which decade made him nostalgic in 2025.",
    "Fun fact: nine vicous released EMOTIONS in April 2026.",
    "Meme joke: bombadiro crocodilo sounds like my laptop fan at full speed.",
    "Meme joke: Bananina Cappuccina sounds like my next questionable coffee order.",
];

/// `recoveryMessage` with the three picks given: 10 phrases, 10 notices, 11 asides.
pub fn recovery_message_from(phrase: usize, note: usize, aside: usize) -> String {
    format!(
        "{} {} (Unrelated aside: {} Ignore this aside; do not research or respond to it. Stay on the original task.)",
        CONTINUE_TEXTS[phrase % CONTINUE_TEXTS.len()],
        RECOVERY_NOTES[note % RECOVERY_NOTES.len()],
        RECOVERY_SUFFIXES[aside % RECOVERY_SUFFIXES.len()]
    )
}

/// `recoveryMessage`: one random Continue text, frozen by the outbox once.
pub fn recovery_message() -> String {
    let [a, b, c] = crate::random_bytes::<3>();
    recovery_message_from(usize::from(a), usize::from(b), usize::from(c))
}

/// `recoveryBusyMs`: the silence clock's one half-window while the native page is busy.
pub fn recovery_busy_ms(pro: bool) -> u64 {
    if pro { 5 * 60_000 } else { 60_000 }
}
