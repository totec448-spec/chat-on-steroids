//! The app-authored session events this unit writes (`recordNote`, `recordProgress`,
//! `recordHandoff` and `ensureHandoffRecorded` in `session/recorder.ts`).

use cos_sessions::SessionStore;
use cos_types::ids::SessionId;
use cos_types::json::Extra;
use cos_types::session::{
    EventBase, EventSource, FinishControl, HandoffEvent, NoteEvent, ProgressEvent, SessionEvent,
};

/// `storeText(sessionId, text, 4000)`: the inline cap of a note and a progress row.
const NOTE_CHARS: usize = 4000;

fn base(time: u64, turn: Option<&str>) -> EventBase {
    EventBase {
        model: None,
        reasoning_effort: None,
        seq: 0,
        time,
        authored_at: None,
        turn_origin: None,
        source: EventSource::App,
        agent: None,
        turn_id: turn.map(str::to_owned),
    }
}

/// `recordNote`: something the app decided, such as an abandoned Compact & Resume.
pub(crate) async fn record_note(
    sessions: &SessionStore,
    session: &SessionId,
    text: &str,
    continuation: Option<&str>,
    now: u64,
) {
    let message = sessions
        .store_text(session, text.to_owned(), NOTE_CHARS)
        .await;
    let event = SessionEvent::Note(NoteEvent {
        base: base(now, None),
        message,
        continuation: continuation.map(str::to_owned),
        extra: Extra::new(),
    });
    let _ = sessions.append_event(session, event).await;
}

/// Where a progress row sits: the first snapshot's `seq` and `time`, which later snapshots of
/// the same `progressId` reuse.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Anchor {
    pub seq: u64,
    pub time: u64,
}

/// One snapshot of a progress row.
pub(crate) struct Progress<'a> {
    pub(crate) id: &'a str,
    pub(crate) text: &'a str,
    pub(crate) anchor: Option<Anchor>,
    pub(crate) turn: Option<&'a str>,
    pub(crate) finish: Option<FinishControl>,
}

/// `recordProgress`: one app-owned status whose later snapshots replace its text in place.
pub(crate) async fn record_progress(
    sessions: &SessionStore,
    session: &SessionId,
    progress: Progress<'_>,
    now: u64,
) -> Option<Anchor> {
    let Progress {
        id: progress_id,
        text,
        anchor,
        turn,
        finish,
    } = progress;
    if progress_id.is_empty() {
        return None;
    }
    let time = anchor.map_or(now, |anchor| anchor.time);
    let message = sessions
        .store_text(session, text.to_owned(), NOTE_CHARS)
        .await;
    let event = SessionEvent::Progress(ProgressEvent {
        base: base(time, turn),
        message,
        progress_id: Some(progress_id.to_owned()),
        origin: anchor.map(|anchor| anchor.seq),
        finish_control: finish,
        extra: Extra::new(),
    });
    let appended = sessions.append_event(session, event).await.ok()?;
    Some(anchor.unwrap_or(Anchor {
        seq: appended.base().seq,
        time,
    }))
}

/// `recordHandoff`: publishes a stored brief into the session timeline (`lastHandoffId`).
pub(crate) async fn record_handoff(
    sessions: &SessionStore,
    session: &SessionId,
    handoff: &str,
    chars: u64,
    continuation: &str,
    now: u64,
) -> Result<(), String> {
    let event = SessionEvent::Handoff(HandoffEvent {
        base: base(now, None),
        handoff_id: handoff.to_owned(),
        chars,
        reason: "compact and resume".into(),
        continuation: Some(continuation.to_owned()).filter(|token| !token.is_empty()),
        extra: Extra::new(),
    });
    sessions.append_event(session, event).await.map(|_| ())
}

/// `ensureHandoffRecorded`: appends the handoff event only when no event names that handoff,
/// so a recovered old brief never becomes the newest again.
pub(crate) async fn ensure_handoff_recorded(
    sessions: &SessionStore,
    session: &SessionId,
    handoff: &str,
    chars: u64,
    continuation: &str,
    now: u64,
) -> Result<bool, String> {
    let existing = sessions
        .recent_events(session, usize::MAX, &["handoff"])
        .await
        .map_err(|error| error.to_string())?;
    if existing.iter().any(
        |event| matches!(event, SessionEvent::Handoff(recorded) if recorded.handoff_id == handoff),
    ) {
        return Ok(false);
    }
    record_handoff(sessions, session, handoff, chars, continuation, now).await?;
    Ok(true)
}
