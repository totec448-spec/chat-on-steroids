//! The session reads the API makes, as one seam: the session store in the Core, a recorded
//! history in this crate's tests.

use cos_sessions::{Appended, EventQuery, EventsError, ListQuery, SessionStore};
use cos_tools::BoxFuture;
use cos_types::control_api::{ControlApiEvents, ControlApiSessionDetail, ControlApiSessionList};
use cos_types::ids::SessionId;
use tokio::sync::broadcast;

pub(crate) trait Sessions: Send + Sync + 'static {
    fn list(&self, query: ListQuery) -> BoxFuture<'_, ControlApiSessionList>;
    fn detail<'a>(&'a self, id: &'a SessionId) -> BoxFuture<'a, Option<ControlApiSessionDetail>>;
    fn events<'a>(
        &'a self,
        id: &'a SessionId,
        query: EventQuery,
    ) -> BoxFuture<'a, Result<ControlApiEvents, EventsError>>;
    fn appended(&self) -> broadcast::Receiver<Appended>;
}

impl Sessions for SessionStore {
    fn list(&self, query: ListQuery) -> BoxFuture<'_, ControlApiSessionList> {
        Box::pin(SessionStore::list(self, query))
    }

    fn detail<'a>(&'a self, id: &'a SessionId) -> BoxFuture<'a, Option<ControlApiSessionDetail>> {
        Box::pin(SessionStore::detail(self, id))
    }

    fn events<'a>(
        &'a self,
        id: &'a SessionId,
        query: EventQuery,
    ) -> BoxFuture<'a, Result<ControlApiEvents, EventsError>> {
        Box::pin(SessionStore::events(self, id, query))
    }

    fn appended(&self) -> broadcast::Receiver<Appended> {
        SessionStore::appended(self)
    }
}
