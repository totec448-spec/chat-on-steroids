//! Route families: each Track 2 unit answers its own routes from its own file, and the router
//! is a table keyed by path, so a new family adds entries instead of a branch.

use std::collections::HashMap;
use std::sync::Arc;

use bytes::Bytes;
use cos_tools::EpochMs;
use http::Method;
use hyper::body::Incoming;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::gate::Peer;
use crate::limits::{self, BodyRefusal};

pub type BoxFuture<T> = cos_http::BoxFuture<T>;

/// Which methods a route answers. `Any` is how `bridge.ts` matches `/hello`, `/status`,
/// `/activity` and `/cos-browser/sign-in`, which test the path only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Methods {
    Get,
    Post,
    Any,
}

impl Methods {
    fn admits(self, method: &Method) -> bool {
        match self {
            Self::Get => method == Method::GET,
            Self::Post => method == Method::POST,
            Self::Any => true,
        }
    }

    fn overlaps(self, other: Self) -> bool {
        self == other || self == Self::Any || other == Self::Any
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Route {
    pub methods: Methods,
    pub path: &'static str,
}

impl Route {
    pub const fn get(path: &'static str) -> Self {
        Self {
            methods: Methods::Get,
            path,
        }
    }

    pub const fn post(path: &'static str) -> Self {
        Self {
            methods: Methods::Post,
            path,
        }
    }

    pub const fn any(path: &'static str) -> Self {
        Self {
            methods: Methods::Any,
            path,
        }
    }
}

/// One unit's routes. The transport has already checked the Origin, the bearer token, the
/// protocol, the rate limit and the startup fence, so a family answers its own refusals only.
pub trait Family: Send + Sync + 'static {
    /// The exact routes this family answers. No two families may share one.
    fn routes(&self) -> &'static [Route];
    fn serve(self: Arc<Self>, exchange: Exchange) -> BoxFuture<Reply>;
}

/// Every family the bridge serves.
pub struct Routes {
    by_path: HashMap<&'static str, Vec<(Methods, usize)>>,
    families: Vec<Arc<dyn Family>>,
}

impl Routes {
    /// The routes E2.1 serves itself: `POST /extension/update`.
    pub fn new(extension: crate::ExtensionFolder, logger: cos_store::Logger) -> Self {
        Self {
            by_path: HashMap::new(),
            families: Vec::new(),
        }
        .family(Arc::new(crate::families::extension::ExtensionUpdate::new(
            extension, logger,
        )))
    }

    /// Adds a family. Panics when one of its routes is already taken: two owners for one route
    /// is a wiring mistake the Core's startup test catches.
    pub fn family(mut self, family: Arc<dyn Family>) -> Self {
        let index = self.families.len();
        for route in family.routes() {
            let taken = self.by_path.entry(route.path).or_default();
            assert!(
                !taken
                    .iter()
                    .any(|(methods, _)| methods.overlaps(route.methods)),
                "two bridge families claim {:?} {}",
                route.methods,
                route.path
            );
            taken.push((route.methods, index));
        }
        self.families.push(family);
        self
    }

    pub(crate) fn find(&self, method: &Method, path: &str) -> Option<Arc<dyn Family>> {
        let (_, index) = self
            .by_path
            .get(path)?
            .iter()
            .find(|(methods, _)| methods.admits(method))?;
        self.families.get(*index).cloned()
    }
}

/// One routed request, as a family sees it.
pub struct Exchange {
    pub(crate) method: Method,
    pub(crate) path: String,
    pub(crate) query: Vec<(String, String)>,
    pub(crate) peer: Peer,
    pub(crate) received_at: EpochMs,
    pub(crate) body: Option<Incoming>,
}

impl Exchange {
    pub fn method(&self) -> &Method {
        &self.method
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    /// `url.searchParams.get(name)`: the first value, decoded.
    pub fn query(&self, name: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    pub fn peer(&self) -> &Peer {
        &self.peer
    }

    pub fn received_at(&self) -> EpochMs {
        self.received_at
    }

    /// `readBody(req, limit)`: the JSON body, `{}` when it is empty. The body is read once; a
    /// second call sees an empty one.
    pub async fn json(&mut self, limit: usize) -> Result<Value, BodyRefusal> {
        match self.body.take() {
            Some(body) => limits::read_json(body, limit).await,
            None => Ok(Value::Object(serde_json::Map::new())),
        }
    }

    /// The body as a typed request. A body that is JSON of another shape is `Invalid`.
    pub async fn body<T: DeserializeOwned>(&mut self, limit: usize) -> Result<T, BodyRefusal> {
        let value = self.json(limit).await?;
        serde_json::from_value(value).map_err(|_| BodyRefusal::Invalid)
    }
}

/// A status and a JSON body. The server adds `content-type`, `content-length`,
/// `cache-control: no-store` and CORS.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reply {
    status: u16,
    body: Bytes,
}

impl Reply {
    pub fn json(status: u16, body: &impl Serialize) -> Self {
        match serde_json::to_vec(body) {
            Ok(body) => Self {
                status,
                body: body.into(),
            },
            Err(_) => Self::internal(),
        }
    }

    pub fn ok(body: &impl Serialize) -> Self {
        Self::json(200, body)
    }

    /// `{ "error": word }`.
    pub fn error(status: u16, word: &str) -> Self {
        Self::json(status, &serde_json::json!({ "error": word }))
    }

    /// `500 internal`, what `handle()` answers when a route throws.
    pub fn internal() -> Self {
        Self {
            status: 500,
            body: Bytes::from_static(br#"{"error":"internal"}"#),
        }
    }

    pub fn status(&self) -> u16 {
        self.status
    }

    pub fn body(&self) -> &Bytes {
        &self.body
    }
}
