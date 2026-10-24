//! A kernel serving the real file tools over the recorder's fixture project.

#![allow(dead_code, reason = "each test file uses a different part")]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use cos_store::{ConfigStore, Logger, Platform};
use cos_tools::{
    Admission, AdmissionGate, BoxFuture, CallRecord, CallRecorder, GrantEnv, Inbound, Kernel,
    KernelDeps, Phase, SurfaceId, SurfaceTools, Unattributed,
};
use serde_json::Value;
use tokio::sync::watch;

pub const TINY_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

pub fn golden() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../golden")
}

pub fn read_json(path: &Path) -> Value {
    let text =
        fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

pub fn decode_base64(text: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .expect("base64")
}

/// A run folder laid out as `record.mjs` lays it out, removed on drop.
pub struct Dirs {
    pub run: PathBuf,
    pub profile: PathBuf,
    pub project: PathBuf,
    pub second: PathBuf,
}

impl Dirs {
    pub fn new(label: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        let run =
            std::env::temp_dir().join(format!("cos-files-{}-{n}-{label}", std::process::id()));
        let _ = fs::remove_dir_all(&run);
        let run = {
            fs::create_dir_all(&run).expect("run folder");
            cos_fs::canonical(&run).expect("canonical run folder")
        };
        let dirs = Self {
            profile: run.join("profile"),
            project: run.join("project"),
            second: run.join("second"),
            run,
        };
        fs::create_dir_all(dirs.profile.join("skills")).expect("skills folder");
        dirs
    }

    /// `seedProject`: the fixture every variant records against.
    pub fn seed_project(&self) {
        let p = &self.project;
        fs::create_dir_all(p.join("src")).expect("src");
        fs::write(
            p.join("README.md"),
            "# Fixture project\n\nGolden corpus fixture.\n",
        )
        .expect("readme");
        fs::write(p.join("src/greeting.txt"), "hello world\nsecond line\n").expect("greeting");
        fs::write(
            p.join("src/notes.md"),
            "The needle phrase is quartz-lantern.\n",
        )
        .expect("notes");
        fs::write(p.join("src/data.bin"), (0..=255u8).collect::<Vec<u8>>()).expect("data");
        fs::write(p.join("src/pixel.png"), decode_base64(TINY_PNG)).expect("pixel");
        let large: String = (1..=12_000)
            .map(|i| format!("line {i:05} {}\n", "x".repeat(40)))
            .collect();
        fs::write(p.join("src/large.txt"), large).expect("large");
        // What `git init -q` leaves that a listing or a search can see.
        fs::create_dir_all(p.join(".git/refs")).expect("git");
        fs::write(p.join(".git/HEAD"), "ref: refs/heads/main\n").expect("git head");
    }

    pub fn seed_second(&self) {
        fs::create_dir_all(self.second.join("src")).expect("second src");
        fs::write(self.second.join("other.txt"), "second root file\n").expect("other");
    }

    pub fn skills(&self) -> PathBuf {
        self.profile.join("skills")
    }

    pub fn placeholders(&self) -> [(String, &'static str); 3] {
        let native = |path: &Path| path.to_string_lossy().into_owned();
        [
            (native(&self.project), "<PROJECT>"),
            (native(&self.second), "<SECOND>"),
            (native(&self.profile), "<PROFILE>"),
        ]
    }
}

impl Drop for Dirs {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.run);
    }
}

/// The result count each call left for the session summary, in call order.
#[derive(Default)]
pub struct Counts(Mutex<Vec<Option<u64>>>);

impl CallRecorder for Counts {
    fn record<'a>(&'a self, call: CallRecord<'a>) -> BoxFuture<'a, ()> {
        self.0.lock().expect("counts").push(call.notes.count);
        Box::pin(async {})
    }
}

pub struct Served {
    pub kernel: Arc<Kernel>,
    pub dirs: Dirs,
    pub counts: Arc<Counts>,
    _config: watch::Sender<Arc<cos_types::config::Config>>,
    _gate: AdmissionGate,
}

impl Served {
    /// A kernel on a recorded variant's config with this run's folders in place of the
    /// corpus placeholders, serving only the file tools.
    pub fn variant(variant: &str) -> Self {
        let recorded = read_json(&golden().join(variant).join("config.json"));
        Self::with_config(variant, &recorded["config"])
    }

    pub fn with_config(label: &str, recorded: &Value) -> Self {
        let dirs = Dirs::new(label);
        dirs.seed_project();
        dirs.seed_second();
        let mut text = serde_json::to_string(recorded).expect("config serializes");
        for (real, placeholder) in dirs.placeholders() {
            text = text.replace(placeholder, &real.replace('\\', "\\\\"));
        }
        let file = dirs.profile.join("config.json");
        fs::write(&file, text).expect("config written");
        let config = ConfigStore::new(file, Platform::Windows, Logger::new()).load("2.1.35");
        let (sender, receiver) = watch::channel(Arc::new(config));
        let (gate, admission) = Admission::channel();
        gate.advance(Phase::Serving);
        let mut tools = SurfaceTools::default();
        for tool in cos_files::tools(cos_files::FileToolsDeps::default()) {
            tools.add(SurfaceId::Core, tool);
        }
        let counts = Arc::new(Counts::default());
        let kernel = Kernel::new(KernelDeps {
            app_version: "2.1.35",
            config: receiver,
            env: GrantEnv {
                skills_dir: dirs.skills(),
                platform: Platform::Windows,
            },
            tools,
            attribution: Arc::new(Unattributed),
            chat_policy: Arc::new(cos_tools::AnyChat),
            recorder: counts.clone(),
            admission,
            logger: Logger::with_clock(|| 0, false),
        });
        Self {
            kernel,
            dirs,
            counts,
            _config: sender,
            _gate: gate,
        }
    }

    /// The count the last recorded call left for the session summary.
    pub fn last_count(&self) -> Option<u64> {
        self.counts
            .0
            .lock()
            .expect("counts")
            .last()
            .copied()
            .flatten()
    }

    /// `tools/call` on Core: the result as JSON, or the `-32602` message.
    pub async fn call(&self, tool: &str, arguments: Value) -> Result<Value, String> {
        match self
            .kernel
            .call(SurfaceId::Core, tool, arguments, Inbound::default())
            .await
        {
            Ok(result) => Ok(serde_json::to_value(result).expect("result serializes")),
            Err(unknown) => Err(format!("Tool {} not found", unknown.0)),
        }
    }

    /// The text parts of a call's result, joined, without the identity notice.
    pub async fn text(&self, tool: &str, arguments: Value) -> (String, bool) {
        let result = self.call(tool, arguments).await.expect("tool is listed");
        let text = result["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|part| part["text"].as_str())
            .filter(|text| !text.starts_with("\n--- Identity notice ---"))
            .collect::<Vec<_>>()
            .join("");
        (text, result["isError"] == true)
    }
}

/// The corpus normalizer's rules for the values a file tool can put in its answer.
pub fn normalize(text: &str, placeholders: &[(String, &'static str)]) -> String {
    let mut out = text.to_owned();
    for (real, placeholder) in placeholders {
        out = out.replace(real.as_str(), placeholder);
        out = out.replace(&real.replace('\\', "/"), placeholder);
    }
    let out = replace_iso_times(&out);
    replace_elapsed(&out)
}

fn replace_iso_times(text: &str) -> String {
    let shape = b"dddd-dd-ddTdd:dd:dd.dddZ";
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < bytes.len() {
        let fits = bytes.len() - at >= shape.len()
            && shape
                .iter()
                .zip(&bytes[at..])
                .all(|(want, got)| match want {
                    b'd' => got.is_ascii_digit(),
                    other => other == got,
                });
        if fits {
            out.push_str("<ISO_TIME>");
            at += shape.len();
        } else {
            let c = text[at..].chars().next().expect("char boundary");
            out.push(c);
            at += c.len_utf8();
        }
    }
    out
}

fn replace_elapsed(text: &str) -> String {
    let marker = "elapsed_ms: ";
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find(marker) {
        out.push_str(&rest[..at + marker.len()]);
        rest = &rest[at + marker.len()..];
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 {
            out.push_str("<DURATION>");
            rest = &rest[digits..];
        }
    }
    out.push_str(rest);
    out
}

/// Replaces the placeholders in recorded arguments with this run's folders.
pub fn denormalize(value: &Value, placeholders: &[(String, &'static str)]) -> Value {
    match value {
        Value::String(text) => {
            let mut out = text.clone();
            for (real, placeholder) in placeholders {
                out = out.replace(placeholder, real);
            }
            Value::String(out)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| denormalize(item, placeholders))
                .collect(),
        ),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, item)| (key.clone(), denormalize(item, placeholders)))
                .collect(),
        ),
        other => other.clone(),
    }
}

pub fn normalize_value(value: &Value, placeholders: &[(String, &'static str)]) -> Value {
    match value {
        Value::String(text) => Value::String(normalize(text, placeholders)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| normalize_value(item, placeholders))
                .collect(),
        ),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, item)| (key.clone(), normalize_value(item, placeholders)))
                .collect(),
        ),
        other => other.clone(),
    }
}
