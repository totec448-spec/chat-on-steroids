//! Small durable JSON files under `<userData>/state`. Port of `src/main/durable.ts`.
//!
//! A write goes to `<name>.json.tmp` and is renamed over `<name>.json`, so a crash leaves the
//! old file or the new one and never a torn one; a leftover temp file is simply overwritten by
//! the next write. Writes to one file are serialized; bursts of background writes coalesce into
//! one after [`WRITE_DELAY`]. Reads return the raw JSON so each ledger's owner can keep its
//! valid rows the way the TypeScript owner does.

use std::fs::{self, File, OpenOptions};
use std::hash::{BuildHasher, RandomState};
use std::io::{self, Write};
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::logger::Logger;

/// How long a background write waits for later writes to coalesce with it.
pub const WRITE_DELAY: Duration = Duration::from_millis(300);
const RETRY_MAX: Duration = Duration::from_millis(5000);

/// The last revision handed out in this process. Revisions are never reused, so one taken from a
/// ledger that has since been replaced never matches the new ledger's revision.
static REVISION: AtomicU64 = AtomicU64::new(0);

fn next_revision() -> u64 {
    REVISION.fetch_add(1, Ordering::Relaxed) + 1
}

/// Writes `bytes` to `tmp`, flushes them to disk, then renames `tmp` over `file`.
pub(crate) fn write_replacing(file: &Path, tmp: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut out = File::create(tmp)?;
    out.write_all(bytes)?;
    out.sync_all()?;
    drop(out);
    fs::rename(tmp, file)
}

#[derive(Debug)]
pub enum DurableError {
    /// Names are 1 to 40 of `a-z`, `0-9` and `-`.
    InvalidName(String),
    /// A strict read found a file it cannot trust. Parser details stay out: they can quote content.
    Unreadable(String),
    Io(io::Error),
    Serialize(serde_json::Error),
}

impl std::fmt::Display for DurableError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidName(name) => write!(f, "Invalid durable state name: {name}"),
            Self::Unreadable(name) => write!(f, "Could not read {name} state"),
            Self::Io(error) => error.fmt(f),
            Self::Serialize(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for DurableError {}

/// The `state` folder. Hands out one [`Durable`] per ledger name.
#[derive(Clone)]
pub struct DurableStore {
    root: PathBuf,
    logger: Logger,
}

impl DurableStore {
    pub fn new(root: impl Into<PathBuf>, logger: Logger) -> Self {
        Self {
            root: root.into(),
            logger,
        }
    }

    /// The ledger `<root>/<name>.json`. Create one per name and share it: the write queue and
    /// the coalescing timer live in the handle.
    pub fn ledger<T: Serialize>(&self, name: &str) -> Result<Durable<T>, DurableError> {
        let valid = (1..=40).contains(&name.len())
            && name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
        if !valid {
            return Err(DurableError::InvalidName(name.to_owned()));
        }
        let file = self.root.join(format!("{name}.json"));
        Ok(Durable {
            inner: Arc::new(Inner {
                name: name.to_owned(),
                tmp: self.root.join(format!("{name}.json.tmp")),
                file,
                root: self.root.clone(),
                logger: self.logger.clone(),
                io: Mutex::new(()),
                slot: Mutex::new(Slot::default()),
                wake: Condvar::new(),
                revision: AtomicU64::new(next_revision()),
            }),
            value: PhantomData,
        })
    }
}

/// One ledger file.
pub struct Durable<T> {
    inner: Arc<Inner>,
    value: PhantomData<fn(&T)>,
}

impl<T> Clone for Durable<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            value: PhantomData,
        }
    }
}

struct Inner {
    name: String,
    file: PathBuf,
    tmp: PathBuf,
    root: PathBuf,
    logger: Logger,
    /// Held across a temp write and its rename: one write per file at a time.
    io: Mutex<()>,
    slot: Mutex<Slot>,
    wake: Condvar,
    revision: AtomicU64,
}

/// `None` removes the file, as `writeDurable*(name, null)` does.
type Bytes = Option<Vec<u8>>;
type Snapshot = Box<dyn FnOnce() -> Result<Bytes, DurableError> + Send>;

enum Payload {
    Ready(Bytes),
    /// Captured once, at the write; a failed write then retries the captured bytes.
    Snapshot(Snapshot),
    Capturing,
}

struct Pending {
    generation: u64,
    payload: Payload,
}

#[derive(Default)]
struct Slot {
    pending: Option<Pending>,
    next_generation: u64,
    due: Option<Instant>,
    retry_attempts: u32,
    timer_running: bool,
}

impl<T: Serialize> Durable<T> {
    pub fn name(&self) -> &str {
        &self.inner.name
    }

    /// `durableRevision(name)`: changes each time a write, a removal or a recovery of this
    /// ledger reaches disk, and only then. A projection built from the file is stale once the
    /// revision it was built at differs.
    pub fn revision(&self) -> u64 {
        self.inner.revision.load(Ordering::Acquire)
    }

    /// `readDurable(name)`: the file's JSON, or `None` when it is missing, unreadable or `null`.
    /// Damage is logged and never stops a start.
    pub fn read(&self) -> Option<Value> {
        match self.load() {
            Loaded::Json(value) => Some(value).filter(|value| !value.is_null()),
            Loaded::Missing | Loaded::NotJson => None,
            // As in TypeScript, only a file-system error is logged; a JSON syntax error is not.
            Loaded::Failed(error) => {
                self.inner.logger.warn(&format!(
                    "could not read {} state: {error}",
                    self.inner.name
                ));
                None
            }
        }
    }

    /// `readDurable(name, { strict: true })`: for authority ledgers, where unreadable state must
    /// not become a fresh grant. Only a missing file reads as `None`.
    pub fn read_strict(&self) -> Result<Option<Value>, DurableError> {
        match self.load() {
            Loaded::Missing => Ok(None),
            Loaded::Json(value) if !value.is_null() => Ok(Some(value)),
            Loaded::Json(_) | Loaded::NotJson | Loaded::Failed(_) => {
                Err(DurableError::Unreadable(self.inner.name.clone()))
            }
        }
    }

    fn load(&self) -> Loaded {
        match fs::read(&self.inner.file) {
            Ok(bytes) => serde_json::from_str(&String::from_utf8_lossy(&bytes))
                .map_or(Loaded::NotJson, Loaded::Json),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Loaded::Missing,
            Err(error) => Loaded::Failed(error),
        }
    }

    /// `writeDurableSoon`: queues `value`; writes in the next [`WRITE_DELAY`] collapse into one.
    pub fn write_soon(&self, value: &T) -> Result<(), DurableError> {
        let bytes = encode(Some(value))?;
        self.queue(Payload::Ready(bytes));
        Ok(())
    }

    /// `writeDurableSnapshotSoon`: like [`write_soon`](Self::write_soon), but `snapshot` runs
    /// only when the write happens, so a burst builds one value. It must not call back into this
    /// ledger.
    pub fn write_snapshot_soon(&self, snapshot: impl FnOnce() -> T + Send + 'static)
    where
        T: 'static,
    {
        self.queue(Payload::Snapshot(Box::new(move || {
            encode(Some(&snapshot()))
        })));
    }

    /// Queues removal of the file.
    pub fn remove_soon(&self) {
        self.queue(Payload::Ready(None));
    }

    /// `writeDurableNow`: writes exactly this value before returning, even if a newer queued
    /// value arrives meanwhile. For transaction intent that must land before another commit.
    pub fn write_now(&self, value: &T) -> Result<(), DurableError> {
        self.write_bytes_now(encode(Some(value))?)
    }

    /// Removes the file before returning.
    pub fn remove_now(&self) -> Result<(), DurableError> {
        self.write_bytes_now(None)
    }

    /// `flushDurable` for this ledger: writes whatever is queued now. Called before quitting.
    pub fn flush(&self) -> Result<(), DurableError> {
        self.inner.lock_slot().due = None;
        self.inner.flush_pending()
    }

    /// `recoverDurable`: keeps the current file as `<name>.recovery-<id>.json`, then replaces it.
    /// The owner serializes this with its own validation. A failure is never retried.
    pub fn recover(&self, value: &T) -> Result<(), DurableError> {
        let bytes = encode(Some(value))?.unwrap_or_default();
        {
            let mut slot = self.inner.lock_slot();
            slot.pending = None;
            slot.due = None;
            slot.retry_attempts = 0;
        }
        let inner = &self.inner;
        let _io = inner.io.lock().unwrap_or_else(|poison| poison.into_inner());
        let recover = || -> io::Result<()> {
            // Never replace a directory or follow a link out of the state folder.
            if !fs::symlink_metadata(&inner.file)?.is_file() {
                return Err(io::Error::other("State file is unavailable"));
            }
            let copy = inner
                .root
                .join(format!("{}.recovery-{}.json", inner.name, random_id()));
            io::copy(
                &mut File::open(&inner.file)?,
                &mut OpenOptions::new().write(true).create_new(true).open(copy)?,
            )?;
            write_replacing(&inner.file, &inner.tmp, &bytes)
        };
        recover().map_err(DurableError::Io)?;
        inner.bump_revision();
        Ok(())
    }

    fn queue(&self, payload: Payload) {
        let mut slot = self.inner.lock_slot();
        let generation = slot.next();
        slot.pending = Some(Pending {
            generation,
            payload,
        });
        // The window starts at the first queued write and is not extended by later ones.
        if slot.due.is_none() {
            slot.due = Some(Instant::now() + WRITE_DELAY);
        }
        self.inner.ensure_timer(slot);
    }

    fn write_bytes_now(&self, bytes: Bytes) -> Result<(), DurableError> {
        let generation = {
            let mut slot = self.inner.lock_slot();
            slot.due = None;
            let generation = slot.next();
            slot.pending = Some(Pending {
                generation,
                payload: Payload::Ready(bytes.clone()),
            });
            generation
        };
        let result = {
            let _io = self
                .inner
                .io
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            self.inner.write(&bytes)
        };
        let mut slot = self.inner.lock_slot();
        match result {
            Ok(()) => {
                // A newer generation may have been queued meanwhile; it stays pending.
                if slot
                    .pending
                    .as_ref()
                    .is_some_and(|pending| pending.generation == generation)
                {
                    slot.pending = None;
                    slot.retry_attempts = 0;
                }
                Ok(())
            }
            Err(error) => {
                self.inner.schedule_retry(&mut slot);
                self.inner.ensure_timer(slot);
                Err(error)
            }
        }
    }
}

fn encode<T: Serialize>(value: Option<&T>) -> Result<Bytes, DurableError> {
    match value {
        None => Ok(None),
        Some(value) => match serde_json::to_value(value).map_err(DurableError::Serialize)? {
            Value::Null => Ok(None),
            value => serde_json::to_vec(&value)
                .map(Some)
                .map_err(DurableError::Serialize),
        },
    }
}

enum Loaded {
    Missing,
    Json(Value),
    NotJson,
    Failed(io::Error),
}

impl Slot {
    fn next(&mut self) -> u64 {
        self.next_generation += 1;
        self.next_generation
    }
}

impl Inner {
    fn bump_revision(&self) {
        self.revision.store(next_revision(), Ordering::Release);
    }

    fn lock_slot(&self) -> MutexGuard<'_, Slot> {
        self.slot
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn write(&self, bytes: &Bytes) -> Result<(), DurableError> {
        let result = fs::create_dir_all(&self.root).and_then(|()| match bytes {
            None => match fs::remove_file(&self.file) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                other => other,
            },
            Some(bytes) => write_replacing(&self.file, &self.tmp, bytes),
        });
        if result.is_ok() {
            self.bump_revision();
        }
        result.map_err(|error| {
            self.logger
                .warn(&format!("could not save {} state: {error}", self.name));
            DurableError::Io(error)
        })
    }

    /// Writes the newest pending generation, if any.
    fn flush_pending(&self) -> Result<(), DurableError> {
        let _io = self.io.lock().unwrap_or_else(|poison| poison.into_inner());
        let (generation, payload) = {
            let mut slot = self.lock_slot();
            let Some(pending) = slot.pending.as_mut() else {
                return Ok(());
            };
            (
                pending.generation,
                std::mem::replace(&mut pending.payload, Payload::Capturing),
            )
        };
        let bytes = match payload {
            Payload::Ready(bytes) => Ok(bytes),
            Payload::Snapshot(snapshot) => snapshot(),
            Payload::Capturing => unreachable!("only the writer holding the io lock captures"),
        };
        let mut slot = self.lock_slot();
        let bytes = match bytes {
            Ok(bytes) => bytes,
            Err(error) => {
                if slot
                    .pending
                    .as_ref()
                    .is_some_and(|pending| pending.generation == generation)
                {
                    slot.pending = None;
                }
                return Err(error);
            }
        };
        if let Some(pending) = slot
            .pending
            .as_mut()
            .filter(|pending| pending.generation == generation)
        {
            pending.payload = Payload::Ready(bytes.clone());
        }
        drop(slot);
        let result = self.write(&bytes);
        let mut slot = self.lock_slot();
        match &result {
            Ok(()) => {
                if slot
                    .pending
                    .as_ref()
                    .is_some_and(|pending| pending.generation == generation)
                {
                    slot.pending = None;
                    slot.retry_attempts = 0;
                }
            }
            Err(_) => self.schedule_retry(&mut slot),
        }
        result
    }

    fn schedule_retry(&self, slot: &mut Slot) {
        if slot.pending.is_none() || slot.due.is_some() {
            return;
        }
        slot.retry_attempts += 1;
        let delay = WRITE_DELAY * 2u32.pow(slot.retry_attempts.min(4));
        slot.due = Some(Instant::now() + delay.min(RETRY_MAX));
    }

    fn ensure_timer(self: &Arc<Self>, mut slot: MutexGuard<'_, Slot>) {
        if slot.timer_running {
            self.wake.notify_all();
            return;
        }
        slot.timer_running = true;
        drop(slot);
        let weak = Arc::downgrade(self);
        let spawned = thread::Builder::new()
            .name(format!("durable-{}", self.name))
            .spawn(move || timer(weak));
        if spawned.is_err() {
            self.lock_slot().timer_running = false;
        }
    }
}

/// Sleeps until the slot is due, flushes, and exits once nothing is due.
fn timer(weak: Weak<Inner>) {
    loop {
        let Some(inner) = weak.upgrade() else { return };
        let mut slot = inner.lock_slot();
        let Some(due) = slot.due else {
            slot.timer_running = false;
            return;
        };
        let now = Instant::now();
        if now < due {
            let (guard, _) = inner
                .wake
                .wait_timeout(slot, due - now)
                .unwrap_or_else(|poison| poison.into_inner());
            drop(guard);
            continue;
        }
        slot.due = None;
        drop(slot);
        // A failure is logged and rescheduled inside.
        let _ = inner.flush_pending();
    }
}

/// A random version 4 UUID string, for recovery copies.
fn random_id() -> String {
    let high = RandomState::new().hash_one(Instant::now());
    let low = RandomState::new().hash_one(std::process::id());
    let bits =
        (u128::from(high) << 64 | u128::from(low)) & !(0xf000u128 << 64) | (0x4000u128 << 64);
    let bits = bits & !(0xc000_0000_0000_0000u128) | 0x8000_0000_0000_0000u128;
    let hex = format!("{bits:032x}");
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}
