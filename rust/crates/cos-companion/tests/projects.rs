//! The native Project creation cases of `test/projects.test.ts` and the `/project-create`
//! route cases of `test/bridge.test.ts`, over an in-memory projects owner.

mod support;

use std::sync::{Arc, Mutex};

use cos_companion::StatusCall;
use cos_companion::{BoxFuture, NoBrowserWork, ProjectCreates, ProjectLinks, WorkParts};
use cos_store::Logger;
use cos_types::state::LocalProject;
use serde_json::{Value, json};
use support::ManualClock;

const START: u64 = 1_767_225_600_000;
const NATIVE: &str = "g-p-cccccccccccccccccccccccccccccccc";

/// `state/projects.json` held in memory, with `updateChatgptLink`'s select-then-change.
#[derive(Clone, Default)]
struct Projects(Arc<Mutex<Vec<LocalProject>>>);

impl Projects {
    fn add(&self, name: &str, request: &str) -> String {
        let id = format!(
            "{:08x}-0000-4000-8000-000000000000",
            self.0.lock().expect("lock").len()
        );
        let project: LocalProject = serde_json::from_value(json!({
            "id": id, "name": name, "path": format!("C:/work/{name}"), "createdAt": START,
            "chatgpt": { "state": "requested", "requestId": request, "updatedAt": START }
        }))
        .expect("a project");
        self.0.lock().expect("lock").push(project);
        id
    }

    fn link(&self, id: &str) -> Value {
        let projects = self.0.lock().expect("lock");
        let project = projects
            .iter()
            .find(|project| project.id == id)
            .expect("project");
        serde_json::to_value(&project.chatgpt).expect("link")
    }
}

impl ProjectLinks for Projects {
    fn list(&self) -> BoxFuture<'static, Vec<LocalProject>> {
        let projects = self.0.lock().expect("lock").clone();
        Box::pin(async move { projects })
    }

    fn update(
        &self,
        select: cos_companion::LinkSelect,
        change: cos_companion::LinkChange,
    ) -> BoxFuture<'static, Option<LocalProject>> {
        let store = self.0.clone();
        Box::pin(async move {
            let mut projects = store.lock().expect("lock");
            let project = projects.iter_mut().find(|project| {
                project
                    .chatgpt
                    .as_ref()
                    .is_some_and(|link| select(link, project))
            })?;
            let next = change(project.chatgpt.as_ref()?)?;
            project.chatgpt = Some(next);
            Some(project.clone())
        })
    }
}

struct Fixture {
    projects: Projects,
    creates: ProjectCreates,
    clock: ManualClock,
}

impl Fixture {
    fn new() -> Self {
        let projects = Projects::default();
        let clock = ManualClock::at(START);
        let creates = ProjectCreates::new(Arc::new(projects.clone()), clock.clock());
        Self {
            projects,
            creates,
            clock,
        }
    }

    fn advance(&self, ms: u64) {
        self.clock.advance(ms);
    }
}

const A: &str = "196809ee-97bf-4703-8a49-b66ba331c69b";
const B: &str = "2cb2e25f-dc59-492d-9a75-dbb5dc30d83f";

#[tokio::test]
async fn links_only_the_id_the_creating_page_reports_after_arming_and_only_from_that_page() {
    let f = Fixture::new();
    let project = f.projects.add("first", A);
    assert!(!f.creates.arm(A, "page-a").await, "nothing claimed yet");
    assert!(f.creates.claim(A, "page-a").await);
    assert!(!f.creates.claim(A, "page-b").await);
    assert!(!f.creates.done(A, "page-a", NATIVE).await, "not armed");
    assert!(f.creates.arm(A, "page-a").await);
    assert!(!f.creates.done(A, "page-b", NATIVE).await);
    assert!(!f.creates.done(A, "page-a", "g-p-not-an-id").await);
    assert!(f.creates.done(A, "page-a", NATIVE).await);
    assert_eq!(f.projects.link(&project)["state"], "linked");
    assert_eq!(f.projects.link(&project)["id"], NATIVE);
    assert!(f.creates.pending().await.is_empty());
}

#[tokio::test]
async fn fails_plainly_before_the_click_but_leaves_an_armed_creation_uncertain() {
    let f = Fixture::new();
    let first = f.projects.add("first", A);
    let second = f.projects.add("second", B);
    f.creates.claim(A, "page-a").await;
    assert!(f.creates.fail(A, "page-a", "no dialog").await);
    assert_eq!(f.projects.link(&first)["state"], "failed");
    assert_eq!(f.projects.link(&first)["error"], "no dialog");
    f.creates.claim(B, "page-b").await;
    f.creates.arm(B, "page-b").await;
    f.advance(60_000);
    assert!(f.creates.pending().await.is_empty());
    assert_eq!(f.projects.link(&second)["state"], "uncertain");
    assert_eq!(
        f.projects.link(&second)["error"],
        "ChatGPT did not show the new Project in time"
    );
}

#[tokio::test]
async fn offers_a_claim_that_lapsed_before_its_click_to_another_page() {
    let f = Fixture::new();
    f.projects.add("first", A);
    f.creates.claim(A, "page-a").await;
    assert_eq!(
        serde_json::to_value(&f.creates.pending().await[0]).expect("row")["state"],
        "claimed"
    );
    f.advance(60_000);
    assert_eq!(
        serde_json::to_value(&f.creates.pending().await[0]).expect("row")["state"],
        "requested"
    );
    assert!(!f.creates.arm(A, "page-a").await);
    assert!(f.creates.claim(A, "page-b").await);
}

#[tokio::test]
async fn turns_only_the_exact_linked_project_chatgpt_no_longer_opens_into_a_failure() {
    let f = Fixture::new();
    let project = f.projects.add("first", A);
    f.creates.claim(A, "page").await;
    f.creates.arm(A, "page").await;
    f.creates.done(A, "page", NATIVE).await;
    let other = format!("g-p-{}", "b".repeat(32));
    assert!(!f.creates.gone(&project, &other).await);
    assert!(f.creates.gone(&project, NATIVE).await);
    let link = f.projects.link(&project);
    assert_eq!(link["state"], "failed");
    assert_eq!(link["error"], "ChatGPT no longer opens this Project");
    assert_ne!(link["requestId"], A, "Retry needs a fresh request");
}

#[tokio::test(start_paused = true)]
async fn turns_an_armed_creation_uncertain_on_the_apps_own_clock_with_no_browser_asking() {
    let f = Fixture::new();
    let project = f.projects.add("first", A);
    f.creates.claim(A, "page").await;
    f.creates.arm(A, "page").await;
    f.advance(60_000);
    tokio::time::sleep(std::time::Duration::from_millis(60_100)).await;
    tokio::task::yield_now().await;
    assert_eq!(f.projects.link(&project)["state"], "uncertain");
}

async fn route(f: &Fixture, body: Value) -> (u16, Value) {
    f.creates
        .answer(&body, &NoBrowserWork, &Logger::new())
        .await
}

#[tokio::test]
async fn the_route_lets_only_the_page_that_claimed_and_armed_it_report_the_project_id() {
    let f = Fixture::new();
    let project = f.projects.add("native-route", A);
    let (status, pending) = route(&f, json!({ "action": "pending" })).await;
    assert_eq!(status, 200);
    assert_eq!(
        pending,
        json!({ "requests": [{ "id": A, "projectId": project, "name": "native-route", "state": "requested" }] })
    );
    let create = |body: Value| {
        let mut body = body;
        body["id"] = json!(A);
        route(&f, body)
    };
    assert_eq!(
        create(json!({ "action": "claim", "client": "doc-a" })).await,
        (200, json!({ "ok": true }))
    );
    assert_eq!(
        create(json!({ "action": "arm", "client": "doc-b" })).await,
        (409, json!({ "ok": false }))
    );
    assert_eq!(
        create(json!({ "action": "arm", "client": "doc-a" })).await,
        (200, json!({ "ok": true }))
    );
    assert_eq!(
        create(json!({ "action": "done", "client": "doc-b", "chatgptId": NATIVE })).await,
        (409, json!({ "ok": false }))
    );
    assert_eq!(
        create(json!({ "action": "done", "client": "doc-a", "chatgptId": NATIVE })).await,
        (200, json!({ "ok": true }))
    );
    assert_eq!(
        route(&f, json!({ "action": "pending" })).await.1,
        json!({ "requests": [] })
    );
}

#[tokio::test]
async fn the_route_refuses_a_request_without_a_well_formed_id_or_client() {
    let f = Fixture::new();
    for body in [
        json!({ "action": "claim", "client": "doc" }),
        json!({ "action": "claim", "id": "not-a-request", "client": "doc" }),
        json!({ "action": "claim", "id": A }),
        json!({ "action": "claim", "id": A, "client": "" }),
        json!({ "action": "claim", "id": A, "client": "x".repeat(65) }),
        json!(null),
    ] {
        assert_eq!(
            route(&f, body.clone()).await,
            (400, json!({ "error": "invalid_request" })),
            "{body}"
        );
    }
    assert_eq!(
        route(&f, json!({ "action": "unknown", "id": A, "client": "doc" })).await,
        (409, json!({ "ok": false }))
    );
}

/// The inputs owner knows which project a waiting message opens in.
struct OneInput(String);

impl cos_companion::BrowserWork for OneInput {
    fn status(&self, call: StatusCall) -> BoxFuture<'static, WorkParts> {
        Box::pin(async move { WorkParts::none(&call) })
    }

    fn input_project(&self, input_id: String) -> BoxFuture<'static, Option<String>> {
        let project = self.0.clone();
        Box::pin(async move { (input_id == "input-1").then_some(project) })
    }
}

#[tokio::test]
async fn the_route_marks_a_linked_project_gone_by_the_input_whose_tab_landed_home() {
    let f = Fixture::new();
    let project = f.projects.add("first", A);
    f.creates.claim(A, "page").await;
    f.creates.arm(A, "page").await;
    f.creates.done(A, "page", NATIVE).await;
    let work = OneInput(project.clone());
    let gone = |input: &str| json!({ "action": "gone", "inputId": input, "chatgptId": NATIVE });
    assert_eq!(
        f.creates
            .answer(&gone("input-2"), &work, &Logger::new())
            .await,
        (409, json!({ "ok": false }))
    );
    assert_eq!(
        f.creates
            .answer(&gone("input-1"), &work, &Logger::new())
            .await,
        (200, json!({ "ok": true }))
    );
    assert_eq!(f.projects.link(&project)["state"], "failed");
}
