//! Monotonic exposure: per surface and per endpoint generation, tools only ever appear.
//!
//! ChatGPT caches a surface's `tools/list`. A tool that disappears under a cached snapshot fails
//! as an unknown tool, so a revoked tool stays listed and its call returns `TOOL_DISABLED`.
//! Exposure resets only when a new endpoint generation starts or a deliberate settings change
//! asks for it (`forgetExposedSurface`).
//!
//! Concurrent requests update this without a lock. Every update is a bitwise OR, a join that
//! commutes, so the order requests arrive in cannot change the result. The `find` decision is
//! made once per generation by compare-and-swap. A request of the previous generation that
//! lands after a reset can only widen the new exposure, which is safe: the live grants still
//! refuse the call.

use std::sync::atomic::{AtomicU8, AtomicU16, Ordering};

use cos_types::config::Capability;

use crate::SurfaceId;
use crate::grants::{CapabilitySet, FeatureSet, Grants};

/// What one surface has listed so far in this generation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Exposed {
    pub capabilities: CapabilitySet,
    pub features: FeatureSet,
    /// `find` instead of the exec pair. Decided from the first grants this surface saw and
    /// then kept, because `capabilities` only widens and could otherwise delete `find`.
    pub find: bool,
}

#[derive(Default)]
struct SurfaceExposure {
    capabilities: AtomicU16,
    features: AtomicU8,
    /// 0 undecided, 1 no `find`, 2 `find`.
    find: AtomicU8,
}

/// The exposure of all three surfaces for the current endpoint generation.
#[derive(Default)]
pub struct Exposure {
    core: SurfaceExposure,
    desktop: SurfaceExposure,
    plugins: SurfaceExposure,
}

impl Exposure {
    fn surface(&self, surface: SurfaceId) -> &SurfaceExposure {
        match surface {
            SurfaceId::Core => &self.core,
            SurfaceId::Desktop => &self.desktop,
            SurfaceId::Plugins => &self.plugins,
        }
    }

    /// Joins `grants` into the surface's exposure and returns the result.
    pub fn observe(&self, surface: SurfaceId, grants: &Grants) -> Exposed {
        let state = self.surface(surface);
        let capabilities = grants.capabilities.bits();
        let features = grants.features.bits();
        let capabilities =
            state.capabilities.fetch_or(capabilities, Ordering::AcqRel) | capabilities;
        let features = state.features.fetch_or(features, Ordering::AcqRel) | features;
        let live = &grants.capabilities;
        let wanted = if !live.contains(Capability::Command) && live.contains(Capability::Search) {
            FIND
        } else {
            NO_FIND
        };
        let find = match state.find.compare_exchange(
            UNDECIDED,
            wanted,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => wanted,
            Err(decided) => decided,
        };
        Exposed {
            capabilities: CapabilitySet::from_bits(capabilities),
            features: FeatureSet::from_bits(features),
            find: find == FIND,
        }
    }

    /// Forgets everything listed so far, for a new generation or a deliberate settings change.
    pub fn reset(&self) {
        for state in [&self.core, &self.desktop, &self.plugins] {
            state.capabilities.store(0, Ordering::Release);
            state.features.store(0, Ordering::Release);
            state.find.store(UNDECIDED, Ordering::Release);
        }
    }
}

const UNDECIDED: u8 = 0;
const NO_FIND: u8 = 1;
const FIND: u8 = 2;
