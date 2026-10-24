//! The native ChatGPT Project a new CoS project gets, created by one page through ChatGPT's own
//! dialog (`projects.ts`, AGENTS.md §9). The link moves `requested → claimed → creating →
//! linked`, or to `failed` before the click and `uncertain` after it. `client` is the page's
//! per-document id: one page claims, arms before its click and reports the id it then shows.
//!
//! The transitions live here. The projects themselves, and `state/projects.json`, belong to the
//! projects owner behind [`ProjectLinks`].

use std::sync::{Arc, Mutex};
use std::time::Duration;

use cos_store::Logger;
use cos_types::bridge::{ProjectCreate, ProjectCreateState};
use cos_types::ids::ChatgptProjectId;
use cos_types::json::JsNumber;
use cos_types::state::{ChatgptProjectLink, LocalProject};
use serde_json::{Value, json};
use tokio::task::JoinHandle;

use crate::ports::BrowserWork;
use crate::text::{self, js_cut, js_len, string};
use crate::{BoxFuture, Clock, random_uuid};

/// A page may hold an unarmed claim this long before the request is offered to another.
pub const PROJECT_CREATE_CLAIM_MS: u64 = 60_000;
/// An armed creation whose id has not come back by then may or may not exist in ChatGPT.
pub const PROJECT_CREATE_ARMED_MS: u64 = 60_000;

/// Picks the project whose link a change applies to.
pub type LinkSelect = Box<dyn Fn(&ChatgptProjectLink, &LocalProject) -> bool + Send>;
/// The next link for that project, or `None` to leave it alone.
pub type LinkChange = Box<dyn FnOnce(&ChatgptProjectLink) -> Option<ChatgptProjectLink> + Send>;

/// The projects owner (`projects.ts`), seen from this handshake.
pub trait ProjectLinks: Send + Sync + 'static {
    fn list(&self) -> BoxFuture<'static, Vec<LocalProject>>;
    /// Applies `change` to the link of the first project with a link that `select` picks,
    /// serialized with every other project write and durable before it returns. The updated
    /// project when the link changed.
    fn update(
        &self,
        select: LinkSelect,
        change: LinkChange,
    ) -> BoxFuture<'static, Option<LocalProject>>;
}

/// No CoS project exists: nothing to create, and every page report is refused.
pub struct NoProjects;

impl ProjectLinks for NoProjects {
    fn list(&self) -> BoxFuture<'static, Vec<LocalProject>> {
        Box::pin(async { Vec::new() })
    }

    fn update(
        &self,
        _select: LinkSelect,
        _change: LinkChange,
    ) -> BoxFuture<'static, Option<LocalProject>> {
        Box::pin(async { None })
    }
}

fn at(updated_at: &JsNumber) -> u64 {
    updated_at.0.max(0.0) as u64
}

fn stamp(now: u64) -> JsNumber {
    JsNumber(now as f64)
}

fn request_id(link: &ChatgptProjectLink) -> Option<&str> {
    use ChatgptProjectLink as L;
    match link {
        L::Requested { request_id, .. }
        | L::Claimed { request_id, .. }
        | L::Creating { request_id, .. }
        | L::Failed { request_id, .. }
        | L::Uncertain { request_id, .. } => Some(request_id),
        L::Linked { .. } => None,
    }
}

fn claim_lapsed(link: &ChatgptProjectLink, now: u64) -> bool {
    matches!(link, ChatgptProjectLink::Claimed { updated_at, .. } if now.saturating_sub(at(updated_at)) >= PROJECT_CREATE_CLAIM_MS)
}

fn for_request(id: &str) -> LinkSelect {
    let id = id.to_owned();
    Box::new(move |link, _| request_id(link) == Some(id.as_str()))
}

/// The creation handshake. Clones share one.
#[derive(Clone)]
pub struct ProjectCreates {
    links: Arc<dyn ProjectLinks>,
    clock: Clock,
    sweep: Arc<Mutex<Option<JoinHandle<()>>>>,
}

impl ProjectCreates {
    pub fn new(links: Arc<dyn ProjectLinks>, clock: Clock) -> Self {
        Self {
            links,
            clock,
            sweep: Arc::new(Mutex::new(None)),
        }
    }

    fn now(&self) -> u64 {
        (self.clock)().0
    }

    /// `pendingProjectCreates()`: Projects still to create, and those in progress so the browser
    /// keeps their tab. A lapsed claim is offered again as `requested`.
    pub async fn pending(&self) -> Vec<ProjectCreate> {
        self.expire_armed().await;
        let now = self.now();
        self.links
            .list()
            .await
            .into_iter()
            .filter(|project| project.ungrouped != Some(true))
            .filter_map(|project| {
                let link = project.chatgpt.as_ref()?;
                let state = match link {
                    ChatgptProjectLink::Requested { .. } => ProjectCreateState::Requested,
                    ChatgptProjectLink::Claimed { .. } if claim_lapsed(link, now) => {
                        ProjectCreateState::Requested
                    }
                    ChatgptProjectLink::Claimed { .. } => ProjectCreateState::Claimed,
                    ChatgptProjectLink::Creating { .. } => ProjectCreateState::Creating,
                    _ => return None,
                };
                Some(ProjectCreate {
                    id: request_id(link)?.to_owned(),
                    project_id: project.id.clone(),
                    name: project.name.clone(),
                    state,
                })
            })
            .collect()
    }

    /// `expireArmedProjectCreates()`: an armed creation that outlived its window turns
    /// `uncertain`, never back into a request: its click may have created a Project whose id was
    /// lost, and only the person may ask again. Keeps a timer for the next one.
    pub fn expire_armed(&self) -> BoxFuture<'static, ()> {
        let owner = self.clone();
        Box::pin(async move { owner.expire_armed_now().await })
    }

    async fn expire_armed_now(&self) {
        let now = self.now();
        let mut next: Option<u64> = None;
        for project in self.links.list().await {
            let Some(ChatgptProjectLink::Creating {
                request_id,
                updated_at,
                ..
            }) = project.chatgpt
            else {
                continue;
            };
            let armed_at = at(&updated_at);
            if now.saturating_sub(armed_at) >= PROJECT_CREATE_ARMED_MS {
                // Only the very arm this pass saw: a newer one has its own window.
                self.change(
                    for_request(&request_id),
                    move |current: &ChatgptProjectLink, now: u64| match current {
                        ChatgptProjectLink::Creating {
                            request_id,
                            updated_at,
                            ..
                        } if at(updated_at) == armed_at => Some(ChatgptProjectLink::Uncertain {
                            request_id: request_id.clone(),
                            error: "ChatGPT did not show the new Project in time".to_owned(),
                            updated_at: stamp(now),
                        }),
                        _ => None,
                    },
                )
                .await;
            } else {
                let due = armed_at + PROJECT_CREATE_ARMED_MS;
                next = Some(next.map_or(due, |next| next.min(due)));
            }
        }
        let mut sweep = self
            .sweep
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(previous) = sweep.take() {
            previous.abort();
        }
        if let (Some(due), Ok(runtime)) = (next, tokio::runtime::Handle::try_current()) {
            let owner = self.clone();
            let delay = Duration::from_millis(due.saturating_sub(now) + 50);
            *sweep = Some(runtime.spawn(async move {
                tokio::time::sleep(delay).await;
                owner.expire_armed().await;
            }));
        }
    }

    /// Applies `change` at the moment the projects owner runs it, as `updateChatgptLink` reads
    /// `Date.now()` inside its queued write.
    async fn change(
        &self,
        select: LinkSelect,
        change: impl FnOnce(&ChatgptProjectLink, u64) -> Option<ChatgptProjectLink> + Send + 'static,
    ) -> bool {
        let clock = self.clock.clone();
        self.links
            .update(select, Box::new(move |link| change(link, clock().0)))
            .await
            .is_some()
    }

    /// One page takes the request before touching ChatGPT; nothing exists remotely yet.
    pub async fn claim(&self, id: &str, owner: &str) -> bool {
        let (request, owner) = (id.to_owned(), owner.to_owned());
        self.change(
            for_request(id),
            move |link: &ChatgptProjectLink, now: u64| {
                let takes = match link {
                    ChatgptProjectLink::Requested { .. } => true,
                    ChatgptProjectLink::Claimed { owner: holder, .. } => {
                        *holder == owner || claim_lapsed(link, now)
                    }
                    _ => false,
                };
                takes.then(|| ChatgptProjectLink::Claimed {
                    request_id: request,
                    owner,
                    updated_at: stamp(now),
                })
            },
        )
        .await
    }

    /// Written before the click that creates the Project: from here it may exist without the
    /// app knowing its id.
    pub async fn arm(&self, id: &str, owner: &str) -> bool {
        let (request, owner) = (id.to_owned(), owner.to_owned());
        let armed = self
            .change(
                for_request(id),
                move |link: &ChatgptProjectLink, now: u64| match link {
                    ChatgptProjectLink::Claimed { owner: holder, .. }
                        if *holder == owner && !claim_lapsed(link, now) =>
                    {
                        Some(ChatgptProjectLink::Creating {
                            request_id: request,
                            owner,
                            updated_at: stamp(now),
                        })
                    }
                    _ => None,
                },
            )
            .await;
        if armed {
            self.expire_armed().await;
        }
        armed
    }

    /// The id ChatGPT showed on the new Project's own page, from the page that created it.
    pub async fn done(&self, id: &str, owner: &str, chatgpt_id: &str) -> bool {
        let Ok(chatgpt_id) = ChatgptProjectId::parse(chatgpt_id) else {
            return false;
        };
        let owner = owner.to_owned();
        self.change(
            for_request(id),
            move |link: &ChatgptProjectLink, now: u64| match link {
                ChatgptProjectLink::Creating { owner: holder, .. } if *holder == owner => {
                    Some(ChatgptProjectLink::Linked {
                        id: chatgpt_id,
                        updated_at: stamp(now),
                    })
                }
                _ => None,
            },
        )
        .await
    }

    /// Before the click nothing was created and the request failed; after it, it is uncertain.
    pub async fn fail(&self, id: &str, owner: &str, error: &str) -> bool {
        let why = Some(js_cut(error, 500))
            .filter(|why| !why.is_empty())
            .unwrap_or_else(|| "unknown error".to_owned());
        let (request, owner) = (id.to_owned(), owner.to_owned());
        self.change(
            for_request(id),
            move |link: &ChatgptProjectLink, now: u64| match link {
                ChatgptProjectLink::Claimed { owner: holder, .. } if *holder == owner => {
                    Some(ChatgptProjectLink::Failed {
                        request_id: request,
                        error: why,
                        updated_at: stamp(now),
                    })
                }
                ChatgptProjectLink::Creating { owner: holder, .. } if *holder == owner => {
                    Some(ChatgptProjectLink::Uncertain {
                        request_id: request,
                        error: why,
                        updated_at: stamp(now),
                    })
                }
                _ => None,
            },
        )
        .await
    }

    /// `markProjectGone`: ChatGPT no longer opens a linked Project. The link fails, so Retry
    /// creates a new one; nothing is recreated on its own.
    pub async fn gone(&self, project_id: &str, chatgpt_id: &str) -> bool {
        let (project_id, chatgpt_id) = (project_id.to_owned(), chatgpt_id.to_owned());
        self.change(
            Box::new(move |link, project| {
                project.id == project_id
                    && matches!(link, ChatgptProjectLink::Linked { id, .. } if id.as_str() == chatgpt_id)
            }),
            |_: &ChatgptProjectLink, now: u64| {
                Some(ChatgptProjectLink::Failed {
                    request_id: random_uuid(),
                    error: "ChatGPT no longer opens this Project".to_owned(),
                    updated_at: stamp(now),
                })
            },
        )
        .await
    }
}

impl ProjectCreates {
    /// `POST /project-create`: a status and a body. `gone` names the waiting message whose new
    /// chat landed on ChatGPT's home; the inputs owner says which project it opens in.
    pub async fn answer(
        &self,
        raw: &Value,
        work: &dyn BrowserWork,
        logger: &Logger,
    ) -> (u16, Value) {
        let empty = serde_json::Map::new();
        let body = raw.as_object().unwrap_or(&empty);
        let field = |key: &str| string(body.get(key));
        let accepted = |ok: bool| (if ok { 200 } else { 409 }, json!({ "ok": ok }));
        match field("action") {
            Some("pending") => return (200, json!({ "requests": self.pending().await })),
            Some("gone") => {
                let project = match field("inputId") {
                    Some(input) => work.input_project(input.to_owned()).await,
                    None => None,
                };
                let ok = match (project, field("chatgptId")) {
                    (Some(project), Some(chatgpt)) => self.gone(&project, chatgpt).await,
                    _ => false,
                };
                if ok {
                    logger.warn("bridge: ChatGPT no longer opens a linked native Project; its project shows Retry");
                }
                return accepted(ok);
            }
            _ => {}
        }
        let client = field("client").filter(|client| (1..=64).contains(&js_len(client)));
        let (Some(id), Some(client)) = (text::request_id(body.get("id")), client) else {
            return (400, json!({ "error": "invalid_request" }));
        };
        let error = field("error");
        let ok = match (field("action"), field("chatgptId"), error) {
            (Some("claim"), _, _) => self.claim(id, client).await,
            (Some("arm"), _, _) => self.arm(id, client).await,
            (Some("done"), Some(chatgpt), _) => self.done(id, client, chatgpt).await,
            (Some("fail"), _, Some(error)) => self.fail(id, client, error).await,
            _ => false,
        };
        if ok {
            match (field("action"), error) {
                (Some("done"), _) => {
                    logger.info("bridge: created the native ChatGPT Project for a new CoS project")
                }
                (Some("fail"), Some(error)) => logger.warn(&format!(
                    "bridge: native ChatGPT Project creation failed — {}",
                    js_cut(error, 200)
                )),
                _ => {}
            }
        }
        accepted(ok)
    }
}
