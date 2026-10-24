//! Files staged for a message (`session/input-attachments.ts`): `<userData>/input-attachments/
//! <id>` holds the bytes and `<id>.json` the metadata the outbox row repeats. Staging belongs to
//! the composer; the outbox only checks membership and hands out chunks.

use std::fs::{self, File, FileTimes};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use base64::Engine;
use cos_types::session::InputAttachment;

use crate::args::{MAX_ATTACHMENT_BYTES, uuid, valid_attachment};

/// `ATTACHMENT_CHUNK_BYTES`.
pub const ATTACHMENT_CHUNK_BYTES: u64 = 512 * 1024;

fn file_for(user_data: &Path, id: &str) -> Result<PathBuf, String> {
    if !uuid(id) {
        return Err("Invalid attachment id".into());
    }
    Ok(user_data.join("input-attachments").join(id))
}

/// `validateInputAttachments`: every file is staged, unchanged, and renewed against pruning.
pub(crate) async fn validate(
    user_data: &Path,
    attachments: &[InputAttachment],
) -> Result<(), String> {
    let total: u64 = attachments.iter().map(|file| file.size).sum();
    if attachments.len() > 20 || total > MAX_ATTACHMENT_BYTES {
        return Err("Attach up to 20 files and 512 MB per message".into());
    }
    let user_data = user_data.to_owned();
    let attachments = attachments.to_vec();
    tokio::task::spawn_blocking(move || {
        let changed = || "Attachment is missing or changed; attach it again".to_owned();
        for attachment in &attachments {
            let file = file_for(&user_data, &attachment.id)?;
            let mut meta = file.clone().into_os_string();
            meta.push(".json");
            let stored: InputAttachment = fs::read(&meta)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .filter(valid_attachment)
                .ok_or_else(changed)?;
            let same = stored.id == attachment.id
                && stored.name == attachment.name
                && stored.size == attachment.size
                && stored.mime_type == attachment.mime_type
                && stored.preview == attachment.preview;
            let size = fs::metadata(&file).map_err(|_| changed())?.len();
            if !same || size != attachment.size {
                return Err(changed());
            }
            let now = SystemTime::now();
            if let Ok(handle) = File::options().write(true).open(&file) {
                let _ = handle.set_times(FileTimes::new().set_accessed(now).set_modified(now));
            }
        }
        Ok(())
    })
    .await
    .map_err(|_| "Attachment check failed".to_owned())?
}

/// `readInputAttachmentChunk`: one chunk, base64. The caller has proven the claim.
pub(crate) async fn read_chunk(
    user_data: &Path,
    attachment: &InputAttachment,
    offset: u64,
) -> Result<String, String> {
    if offset > attachment.size || !offset.is_multiple_of(ATTACHMENT_CHUNK_BYTES) {
        return Err("Invalid attachment offset".into());
    }
    let file = file_for(user_data, &attachment.id)?;
    let size = attachment.size;
    tokio::task::spawn_blocking(move || {
        let mut handle = File::open(&file).map_err(|error| error.to_string())?;
        let actual = handle.metadata().map_err(|error| error.to_string())?.len();
        if actual != size {
            return Err("Attachment changed".to_owned());
        }
        let length = usize::try_from(ATTACHMENT_CHUNK_BYTES.min(size - offset))
            .map_err(|_| "Attachment read incomplete".to_owned())?;
        let mut buffer = vec![0u8; length];
        handle
            .seek(SeekFrom::Start(offset))
            .map_err(|error| error.to_string())?;
        handle
            .read_exact(&mut buffer)
            .map_err(|_| "Attachment read incomplete".to_owned())?;
        Ok(base64::engine::general_purpose::STANDARD.encode(buffer))
    })
    .await
    .map_err(|_| "Attachment read failed".to_owned())?
}
