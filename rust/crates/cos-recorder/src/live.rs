//! What `/status` tells the extension about the chats a page is reporting in this process
//! (`liveConversations` in `session/recorder.ts`). Read only.

use cos_types::bridge::LiveConversation;

use crate::{Recorder, lock};

impl Recorder {
    /// Every chat a page reported in this process, ordered by conversation id. TypeScript lists
    /// them in first-report order; the extension reads them as a set.
    pub fn live_conversations(&self) -> Vec<LiveConversation> {
        let live = lock(&self.inner.live);
        let mut conversations: Vec<LiveConversation> = live
            .iter()
            .map(|(conversation, entry)| entry.wire(conversation))
            .collect();
        conversations.sort_by(|a, b| a.conversation_id.cmp(&b.conversation_id));
        conversations
    }
}

impl Recorder {
    /// `rebindConversation`: the in-memory half of a Compact & Resume commit, after the session
    /// already says chat `to` on disk. Chat B is a different page, so its live state starts
    /// empty; chat A's entry is dropped so a stale tab on A no longer writes into the session.
    pub fn rebind_conversation(&self, session: &cos_types::ids::SessionId, from: &str, to: &str) {
        let mut live = lock(&self.inner.live);
        if live
            .get(from)
            .is_some_and(|entry| &entry.session_id == session)
        {
            live.remove(from);
        }
        live.insert(
            to.to_owned(),
            crate::observe::LiveConversation::fresh(session.clone()),
        );
    }
}
