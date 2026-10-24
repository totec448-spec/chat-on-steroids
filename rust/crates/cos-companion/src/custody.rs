//! Which browser a waiting message belongs to, when the extension runs in more than one
//! (`openingHeldElsewhere`, `chatHolders` and `inputHeldElsewhere` in `bridge.ts`). Every browser
//! shares one pairing token, so each pass names its own browser id.
//!
//! A message for a chat goes to the browsers that reported that chat open; one for a new chat
//! goes to the first browser it was handed to. Either claim lapses once its browser has not
//! polled for a minute.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use cos_types::bridge::StatusInput;

use crate::ports::StatusCall;

/// How long a browser keeps work it was handed after it stops polling (`OPENING_CUSTODY_MS`).
const CUSTODY_MS: u64 = 60_000;

#[derive(Default)]
struct Held {
    /// When each browser last polled.
    seen: HashMap<String, u64>,
    /// The chats each browser reported open in its last `POST` pass.
    chats: HashMap<String, HashSet<String>>,
    /// New-chat messages and the browser each was first handed to.
    openings: HashMap<String, String>,
}

impl Held {
    fn polling(&self, browser: &str, now: u64) -> bool {
        self.seen
            .get(browser)
            .is_some_and(|at| now.saturating_sub(*at) < CUSTODY_MS)
    }

    fn holders(&self, conversation: &str, now: u64) -> Vec<&str> {
        self.chats
            .iter()
            .filter(|(browser, chats)| chats.contains(conversation) && self.polling(browser, now))
            .map(|(browser, _)| browser.as_str())
            .collect()
    }

    /// `inputHeldElsewhere`.
    fn elsewhere(&mut self, id: &str, conversation: Option<&str>, browser: &str, now: u64) -> bool {
        if let Some(conversation) = conversation {
            let holders = self.holders(conversation, now);
            if !holders.is_empty() {
                return !holders.contains(&browser);
            }
        }
        if let Some(holder) = self.openings.get(id)
            && holder != browser
            && self.polling(holder, now)
        {
            return true;
        }
        self.openings.insert(id.to_owned(), browser.to_owned());
        false
    }
}

/// The custody of waiting messages across browsers. One per bridge.
#[derive(Default)]
pub struct Custody(Mutex<Held>);

impl Custody {
    /// The messages this pass may take: a pending message another browser holds is left out.
    /// Planner tabs to close always pass. A pass with no browser id (an older extension) is
    /// never told apart from another and takes everything.
    pub fn hand_out(
        &self,
        call: &StatusCall,
        inputs: Vec<StatusInput>,
        now: u64,
    ) -> Vec<StatusInput> {
        let mut held = self.0.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some(browser) = &call.browser {
            held.seen.insert(browser.clone(), now);
            if call.post {
                held.chats.insert(
                    browser.clone(),
                    call.open_conversations.iter().cloned().collect(),
                );
            }
        }
        let pending: HashSet<&str> = inputs
            .iter()
            .filter_map(|input| match input {
                StatusInput::Pending(pending) => Some(pending.id.as_str()),
                StatusInput::Close(_) => None,
            })
            .collect();
        held.openings.retain(|id, _| pending.contains(id.as_str()));
        let Some(browser) = call.browser.as_deref() else {
            return inputs;
        };
        inputs
            .into_iter()
            .filter(|input| match input {
                StatusInput::Pending(pending) => !held.elsewhere(
                    &pending.id,
                    pending.conversation_id.as_deref(),
                    browser,
                    now,
                ),
                StatusInput::Close(_) => true,
            })
            .collect()
    }
}
