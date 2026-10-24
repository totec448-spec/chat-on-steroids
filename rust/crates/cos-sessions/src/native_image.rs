//! An image ChatGPT generated, kept as one canonical row per provider message and asset
//! (`upsertNativeImageEvent` in `src/main/session/store.ts`). The row is metadata first; a
//! preview asset joins it once, and never leaves it. A native image is transcript content
//! only: it never counts as work, completion or a tool call.

use cos_types::ids::SessionId;
use cos_types::json::Record;
use cos_types::session::{
    NativeImageEvent, PreviewError, PreviewStatus, ProviderStatus, SessionEvent,
};

use crate::{SessionStore, blocking, disk, lock, summary};

/// What [`SessionStore::upsert_native_image`] did.
#[derive(Clone, Debug, PartialEq)]
pub struct NativeImageUpserted {
    /// The row as stored now (the previous one when nothing changed).
    pub event: NativeImageEvent,
    pub changed: bool,
    /// `false` when the row belongs to another role or agent, or the user removed its preview.
    /// Only an accepted row may receive preview bytes.
    pub accepted: bool,
}

/// The revision `upsertNativeImageEvent` builds from the stored row and the new observation.
fn merged(previous: Option<&NativeImageEvent>, event: NativeImageEvent) -> NativeImageEvent {
    let asset = previous
        .and_then(|held| held.asset.clone())
        .or(event.asset.clone());
    let preview_error = if previous.and_then(|held| held.preview_error) == Some(PreviewError::Quota)
        && asset.is_none()
    {
        Some(PreviewError::Quota)
    } else {
        event
            .preview_error
            .or(previous.and_then(|held| held.preview_error))
    };
    let preview_status = if asset.is_some() {
        PreviewStatus::Available
    } else if preview_error.is_some() {
        PreviewStatus::Unavailable
    } else {
        event.preview_status
    };
    let mut next = NativeImageEvent {
        provider_channel: previous
            .and_then(|held| held.provider_channel)
            .or(event.provider_channel),
        provider_status: match previous.and_then(|held| held.provider_status) {
            Some(ProviderStatus::FinishedSuccessfully) => {
                Some(ProviderStatus::FinishedSuccessfully)
            }
            held => event.provider_status.or(held),
        },
        width: previous.and_then(|held| held.width).or(event.width),
        height: previous.and_then(|held| held.height).or(event.height),
        asset: None,
        preview_status,
        preview_error,
        ..event
    };
    if let Some(previous) = previous {
        next.base.time = previous.base.time;
        if previous.base.turn_id.is_some() {
            next.base.turn_id.clone_from(&previous.base.turn_id);
        }
        if next.base.agent.is_none() {
            next.base.agent.clone_from(&previous.base.agent);
        }
    }
    if let Some(asset) = asset {
        next.asset = Some(asset);
        next.preview_status = PreviewStatus::Available;
        next.preview_width = previous
            .and_then(|held| held.preview_width)
            .or(next.preview_width);
        next.preview_height = previous
            .and_then(|held| held.preview_height)
            .or(next.preview_height);
        next.preview_error = None;
    }
    next
}

fn unchanged(previous: &NativeImageEvent, next: &NativeImageEvent) -> bool {
    let asset = |event: &NativeImageEvent| {
        event
            .asset
            .as_ref()
            .map(|asset| (asset.id.clone(), asset.mime_type.clone(), asset.bytes))
    };
    previous.base.turn_id == next.base.turn_id
        && previous.base.agent == next.base.agent
        && previous.provider_channel == next.provider_channel
        && previous.provider_status == next.provider_status
        && previous.width == next.width
        && previous.height == next.height
        && previous.preview_width == next.preview_width
        && previous.preview_height == next.preview_height
        && previous.preview_status == next.preview_status
        && previous.preview_error == next.preview_error
        && asset(previous) == asset(next)
}

impl SessionStore {
    /// `upsertNativeImageEvent`: creates or revises the one row of this provider image.
    pub async fn upsert_native_image(
        &self,
        id: &SessionId,
        event: NativeImageEvent,
    ) -> Result<NativeImageUpserted, String> {
        let key = summary::message_key(&SessionEvent::NativeImage(event.clone()))
            .ok_or("Canonical native image requires provider message and asset ids")?;
        let live = self.ensure_open(id).await?;
        let mut writer = live.writer.lock().await;
        self.ensure_messages(id, &mut writer).await?;
        let previous = match writer.messages.as_ref().and_then(|held| held.get(&key)) {
            Some(SessionEvent::NativeImage(previous)) => Some(previous.clone()),
            Some(_) => return Err("Canonical native image identity collision".into()),
            None => None,
        };
        if let Some(previous) = &previous {
            let other_agent = matches!((&previous.base.agent, &event.base.agent),
                (Some(held), Some(next)) if held != next);
            let removed =
                previous.preview_error == Some(PreviewError::Removed) && previous.asset.is_none();
            if previous.provider_role != event.provider_role || other_agent || removed {
                return Ok(NativeImageUpserted {
                    event: previous.clone(),
                    changed: false,
                    accepted: false,
                });
            }
        }
        let mut next = merged(previous.as_ref(), event);
        if let Some(previous) = &previous
            && unchanged(previous, &next)
        {
            return Ok(NativeImageUpserted {
                event: previous.clone(),
                changed: false,
                accepted: true,
            });
        }
        let seq = writer.next_seq;
        next.base.seq = seq;
        next.origin = previous
            .as_ref()
            .map(|held| held.origin.unwrap_or(held.base.seq))
            .or(Some(seq));
        let full = SessionEvent::NativeImage(next.clone());
        let dir = self.dir(id);
        let shard_key = key.clone();
        let stored = full.clone();
        blocking(move || disk::write_canonical_message(&dir, &shard_key, &stored))
            .await
            .and_then(|written| written)
            .map_err(|error| {
                self.logger()
                    .error(&format!("session native image upsert failed: {error}"));
                error.to_string()
            })?;
        writer.next_seq += 1;
        writer.history_seq = seq;
        writer
            .messages
            .get_or_insert_with(Record::new)
            .insert(key, full.clone());
        if previous.is_none() {
            summary::apply(&mut writer.summary, &full);
        }
        *lock(&live.published) = writer.summary.clone();
        self.schedule_meta(id, &live, &mut writer);
        drop(writer);
        let _ = self.inner.appended.send(crate::Appended {
            session: id.clone(),
            seq,
        });
        Ok(NativeImageUpserted {
            event: next,
            changed: true,
            accepted: true,
        })
    }
}
