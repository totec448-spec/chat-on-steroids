#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use cos_companion::{Clock, WakeBrowser};
use cos_tools::EpochMs;

/// A clock tests move by hand.
#[derive(Clone)]
pub struct ManualClock(Arc<AtomicU64>);

impl ManualClock {
    pub fn at(ms: u64) -> Self {
        Self(Arc::new(AtomicU64::new(ms)))
    }

    pub fn advance(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }

    pub fn now(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }

    pub fn clock(&self) -> Clock {
        let time = self.0.clone();
        Arc::new(move || EpochMs(time.load(Ordering::SeqCst)))
    }
}

/// Counts `wakeBrowserWork()` calls.
#[derive(Clone, Default)]
pub struct Wakes(Arc<AtomicUsize>);

impl Wakes {
    pub fn wake(&self) -> WakeBrowser {
        let count = self.0.clone();
        Arc::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
        })
    }

    pub fn count(&self) -> usize {
        self.0.load(Ordering::SeqCst)
    }
}

pub fn scratch(prefix: &str) -> PathBuf {
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes).expect("random bytes");
    let name: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let dir = std::env::temp_dir().join(format!("{prefix}-{name}"));
    std::fs::create_dir_all(&dir).expect("a scratch folder");
    dir
}
