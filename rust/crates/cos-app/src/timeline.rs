//! One chat's events as the timeline holds them: the newest page when the chat opens, then each
//! live delta merged in, as `loadDetail` and `mergeDetailDelta` in `src/renderer/chat.ts` do.
//! Folding progress rows and placing rounds are the timeline view's work, not this model's.

use cos_types::control_api::{ControlApiEvent, ControlApiEvents};

/// How many events one read takes (`TIMELINE_BATCH_SIZE`).
pub const TIMELINE_BATCH: u32 = 30;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TimelinePage {
    /// In the order they were read: the opening page oldest first, then each delta.
    pub events: Vec<ControlApiEvent>,
    /// Events in the whole session, not only on this page.
    pub total: u64,
    /// The next delta reads from this seq (`detailCursor`).
    pub cursor: u64,
}

impl TimelinePage {
    pub fn opened(first: ControlApiEvents) -> Self {
        Self {
            cursor: first.next_from,
            total: first.total,
            events: first.events,
        }
    }

    /// Merges one delta read from [`Self::cursor`]. A newer revision of a message or tool call
    /// already on the page replaces it in place. A revision of a row older than the page stays
    /// with the page that owns it. Returns whether the read was full, so more may be waiting.
    pub fn merge(&mut self, delta: ControlApiEvents) -> bool {
        let full = delta.events.len() >= TIMELINE_BATCH as usize;
        self.cursor = self.cursor.max(delta.next_from);
        self.total = delta.total;
        let floor = self.events.iter().map(|event| event.position).min();
        for event in delta.events {
            let row = canonical_key(&event).and_then(|key| {
                self.events
                    .iter()
                    .position(|held| canonical_key(held).as_ref() == Some(&key))
            });
            match row {
                Some(row) => self.events[row] = event,
                None if floor.is_some_and(|floor| event.position < floor) => {}
                None => self.events.push(event),
            }
        }
        full
    }
}

/// `canonicalMessageKey`: the identity a revised row keeps across revisions.
fn canonical_key(event: &ControlApiEvent) -> Option<(&str, &str)> {
    match event.kind.as_str() {
        "tool_call" => event
            .tool
            .as_ref()
            .map(|tool| ("tool_call", tool.call_id.as_str())),
        kind @ ("user_message" | "assistant_message") => {
            event.message_id.as_deref().map(|id| (kind, id))
        }
        _ => None,
    }
}
