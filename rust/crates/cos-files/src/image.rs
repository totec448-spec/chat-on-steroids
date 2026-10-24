//! `view_image`'s loader (`codex/view-image.ts`), shared with `read` for image paths.

use std::path::Path;

use base64::Engine as _;
use cos_fs::{ImageMime, MAX_VIEW_IMAGE_BYTES, format_bytes, validate_image_bytes};

use crate::disk::{self, Kind};
use crate::js;

pub(crate) const INVALID_IMAGE: &str = "unable to process image: invalid or unsupported image data";

pub(crate) struct ViewedImage {
    pub mime: ImageMime,
    pub base64: String,
    pub bytes: u64,
}

/// `viewImage`. `Err` is the message the model reads (`ViewImageError`).
pub(crate) fn view_image(real: &Path, shown: &str) -> Result<ViewedImage, String> {
    let meta = disk::metadata(real).map_err(|error| {
        format!(
            "unable to locate image at `{shown}`: {}",
            js::node_error_message(&error, "lstat", Some(shown))
        )
    })?;
    if meta.kind != Kind::File {
        return Err(format!("image path `{shown}` is not a file"));
    }
    if meta.size > MAX_VIEW_IMAGE_BYTES {
        return Err(format!(
            "unable to read image at `{shown}`: image is too large to return ({}; limit {})",
            format_bytes(meta.size),
            format_bytes(MAX_VIEW_IMAGE_BYTES)
        ));
    }
    let data = read_bounded(real, shown, MAX_VIEW_IMAGE_BYTES)
        .map_err(|message| format!("unable to read image at `{shown}`: {message}"))?;
    let mime = validate_image_bytes(&data).ok_or_else(|| INVALID_IMAGE.to_owned())?;
    Ok(ViewedImage {
        mime,
        bytes: data.len() as u64,
        base64: base64::engine::general_purpose::STANDARD.encode(&data),
    })
}

/// `readFile(path, limit)`: the limit holds on the opened handle too, so a file that grew after
/// the stat is refused rather than read past the budget.
fn read_bounded(real: &Path, shown: &str, limit: u64) -> Result<Vec<u8>, String> {
    let too_large = || format!("file is too large to read: limit is {limit} bytes");
    let (mut file, size) = disk::open_regular_file(real, shown).map_err(|error| {
        if error.kind() == std::io::ErrorKind::InvalidInput {
            error.to_string()
        } else {
            js::node_error_message(&error, "open", Some(shown))
        }
    })?;
    if size > limit {
        return Err(too_large());
    }
    let mut data = Vec::with_capacity(usize::try_from(size).unwrap_or_default());
    let mut buffer = vec![0u8; disk::CHUNK_BYTES];
    loop {
        let read = disk::read_chunk(&mut file, &mut buffer)
            .map_err(|error| js::node_error_message(&error, "read", None))?;
        if read == 0 {
            return Ok(data);
        }
        data.extend_from_slice(&buffer[..read]);
        if data.len() as u64 > limit {
            return Err(too_large());
        }
    }
}
