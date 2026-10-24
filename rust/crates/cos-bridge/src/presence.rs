//! Whether the extension is there, and which build it is (`noteExtensionVersion`,
//! `noteBrowserSeen`, `browserPresent` in `bridge.ts`).

use std::sync::{Mutex, PoisonError};

use cos_tools::EpochMs;
use cos_types::bridge::{BRIDGE_PROTOCOL, WakeHost};

use crate::gate::Peer;

/// A sighting counts as presence for this long.
pub(crate) const BROWSER_PRESENT_MS: u64 = 60_000;
/// One announcement per extension version and build in this window.
const ANNOUNCE_MS: u64 = 30 * 60_000;
const ANNOUNCED_KEPT: usize = 16;

/// A line for the Activity log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Line {
    Info(String),
    Warn(String),
}

#[derive(Default)]
pub(crate) struct Presence(Mutex<Seen>);

#[derive(Default)]
struct Seen {
    /// The last authenticated request or pairing.
    last_seen_at: Option<EpochMs>,
    /// The last request from the CoS browser's own copy.
    cos_seen_at: Option<EpochMs>,
    extension_version: Option<String>,
    /// Version and build announced, oldest first.
    announced: Vec<(String, EpochMs)>,
    protocol_warned: bool,
}

/// What status reads of presence at one instant.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Sighting {
    pub(crate) last_seen_at: Option<EpochMs>,
    pub(crate) extension_version: Option<String>,
    pub(crate) recent: bool,
    pub(crate) cos_recent: bool,
    /// When one of the two presences above runs out, if one is running.
    pub(crate) next_expiry: Option<EpochMs>,
}

impl Presence {
    /// Every request, before its route: records the version and says once per build which
    /// extension connected. Even an incompatible peer is recorded, so its version shows.
    pub(crate) fn note_version(
        &self,
        peer: &Peer,
        now: EpochMs,
        shipped: Option<&str>,
        app_version: &str,
    ) -> Vec<Line> {
        let mut seen = self.lock();
        let mut lines = Vec::new();
        if let Some(version) = &peer.version {
            seen.extension_version = Some(version.clone());
            let key = format!(
                "{version}\u{0}{}",
                peer.build.as_deref().unwrap_or_default()
            );
            let fresh = seen.announced.iter().any(|(announced, at)| {
                *announced == key && now.0.saturating_sub(at.0) < ANNOUNCE_MS
            });
            if !fresh {
                seen.announced.retain(|(announced, _)| *announced != key);
                seen.announced.push((key, now));
                if seen.announced.len() > ANNOUNCED_KEPT {
                    seen.announced.remove(0);
                }
                let build = peer
                    .build
                    .as_deref()
                    .map(|build| format!(" (build {build})"))
                    .unwrap_or_default();
                lines.push(Line::Info(format!(
                    "bridge: browser extension {version} connected{build}"
                )));
                if let (Some(shipped), Some(running)) = (shipped, peer.build.as_deref())
                    && shipped != running
                {
                    lines.push(Line::Info(format!(
                        "bridge: the browser is running extension build {running}, but this app ships {shipped}. \
                         It updates itself once no chat is busy. If it stays on the old build, Chrome loaded it from a \
                         different folder: load the CoS extension folder again at chrome://extensions."
                    )));
                }
            }
        }
        if let Some(protocol) = peer.protocol
            && !seen.protocol_warned
            && !peer.compatible()
        {
            seen.protocol_warned = true;
            lines.push(Line::Warn(format!(
                "bridge: the browser extension speaks protocol {protocol} but this app speaks {BRIDGE_PROTOCOL}. \
                 Reload the extension from the folder shipped with app {app_version}."
            )));
        }
        lines
    }

    /// An authenticated request or a pairing: the extension is here now.
    pub(crate) fn note_seen(&self, peer: &Peer, now: EpochMs) {
        let mut seen = self.lock();
        seen.last_seen_at = Some(now);
        if peer.host == Some(WakeHost::Cos) {
            seen.cos_seen_at = Some(now);
        }
    }

    /// A stopped or moved listener cannot see the extension. The next request proves it again.
    pub(crate) fn forget_sightings(&self) {
        let mut seen = self.lock();
        seen.last_seen_at = None;
        seen.cos_seen_at = None;
    }

    pub(crate) fn sighting(&self, now: EpochMs) -> Sighting {
        let seen = self.lock();
        let live = |at: Option<EpochMs>| {
            at.map(|at| EpochMs(at.0.saturating_add(BROWSER_PRESENT_MS)))
                .filter(|until| until.0 > now.0)
        };
        let (until, cos_until) = (live(seen.last_seen_at), live(seen.cos_seen_at));
        Sighting {
            last_seen_at: seen.last_seen_at,
            extension_version: seen.extension_version.clone(),
            recent: until.is_some(),
            cos_recent: cos_until.is_some(),
            next_expiry: [until, cos_until].into_iter().flatten().min(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Seen> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(version: &str, build: Option<&str>, protocol: Option<i64>) -> Peer {
        Peer {
            version: Some(version.into()),
            build: build.map(str::to_owned),
            protocol,
            ..Peer::default()
        }
    }

    #[test]
    fn each_build_is_announced_once_per_half_hour_and_a_stale_build_is_named() {
        let presence = Presence::default();
        let first = presence.note_version(
            &peer("2.1.35", Some("aaaaaaaaaaaa"), Some(14)),
            EpochMs(1_000),
            Some("bbbbbbbbbbbb"),
            "2.1.35",
        );
        assert_eq!(first.len(), 2);
        assert_eq!(
            first[0],
            Line::Info("bridge: browser extension 2.1.35 connected (build aaaaaaaaaaaa)".into())
        );
        let again = presence.note_version(
            &peer("2.1.35", Some("aaaaaaaaaaaa"), Some(14)),
            EpochMs(1_000 + ANNOUNCE_MS - 1),
            Some("bbbbbbbbbbbb"),
            "2.1.35",
        );
        assert!(again.is_empty());
        let later = presence.note_version(
            &peer("2.1.35", Some("aaaaaaaaaaaa"), Some(14)),
            EpochMs(1_000 + ANNOUNCE_MS),
            None,
            "2.1.35",
        );
        assert_eq!(later.len(), 1);
    }

    #[test]
    fn a_wrong_protocol_is_warned_about_once() {
        let presence = Presence::default();
        let warned =
            presence.note_version(&peer("0.0.1", None, Some(13)), EpochMs(1), None, "2.1.35");
        assert!(
            warned.contains(&Line::Warn(
                "bridge: the browser extension speaks protocol 13 but this app speaks 14. \
             Reload the extension from the folder shipped with app 2.1.35."
                    .into()
            ))
        );
        let quiet =
            presence.note_version(&peer("0.0.2", None, Some(13)), EpochMs(2), None, "2.1.35");
        assert!(quiet.iter().all(|line| matches!(line, Line::Info(_))));
    }

    #[test]
    fn presence_lasts_a_minute_from_the_last_sighting() {
        let presence = Presence::default();
        assert!(!presence.sighting(EpochMs(0)).recent);
        presence.note_seen(&Peer::default(), EpochMs(10_000));
        let now = presence.sighting(EpochMs(10_000 + BROWSER_PRESENT_MS - 1));
        assert!(now.recent && !now.cos_recent);
        assert_eq!(now.next_expiry, Some(EpochMs(10_000 + BROWSER_PRESENT_MS)));
        assert!(
            !presence
                .sighting(EpochMs(10_000 + BROWSER_PRESENT_MS))
                .recent
        );
        presence.forget_sightings();
        assert_eq!(presence.sighting(EpochMs(10_001)).last_seen_at, None);
    }
}
