//! `validateImageBytes` (`codex/view-image.ts`): the one check an image passes before any tool
//! returns it to the model, whether `view_image` read it from disk or a code-mode script
//! emitted it. An image the consumer cannot decode breaks the ChatGPT message stream, so
//! anything short of pixels fails.

use std::io::Cursor;

use image::codecs::gif::GifDecoder;
use image::codecs::png::PngDecoder;
use image::codecs::webp::WebPDecoder;
use image::{DynamicImage, ImageDecoder, Limits};
use zune_core::bytestream::ZCursor;
use zune_core::options::DecoderOptions;

use crate::fsops::{ImageMime, MAX_IMAGE_BYTES, image_mime, validate_image_structure};

/// The raw bytes whose base64, plus ordinary result metadata, fits an 8 MiB MCP envelope.
pub const MAX_VIEW_IMAGE_BYTES: u64 = {
    let wire = (8 * 1024 * 1024 - 64 * 1024) * 3 / 4;
    if MAX_IMAGE_BYTES < wire {
        MAX_IMAGE_BYTES
    } else {
        wire
    }
};

/// Decoded pixels are bounded apart from the compressed size, so a small file cannot expand
/// without limit. At most four 8-bit channels, so this also bounds the decoded bytes at 64 MiB.
const MAX_DECODED_PIXELS: u64 = 16 * 1024 * 1024;

/// The size, the signature, the framing, then a full decode. `None` for anything that is not
/// a PNG, JPEG, GIF or WebP that decodes to pixels within the budgets. The decode is CPU work;
/// run it on a blocking thread.
pub fn validate_image_bytes(data: &[u8]) -> Option<ImageMime> {
    if data.len() as u64 > MAX_VIEW_IMAGE_BYTES {
        return None;
    }
    let mime = image_mime(data)?;
    validate_image_structure(data, mime).ok()?;
    decodes_to_pixels(data, mime).then_some(mime)
}

fn within_pixel_budget((width, height): (u32, u32)) -> bool {
    width > 0 && height > 0 && u64::from(width) * u64::from(height) <= MAX_DECODED_PIXELS
}

fn decodes_to_pixels(data: &[u8], mime: ImageMime) -> bool {
    match mime {
        ImageMime::Jpeg => decodes_jpeg(data),
        ImageMime::Png => PngDecoder::new(Cursor::new(data)).is_ok_and(decode_all),
        ImageMime::Gif => GifDecoder::new(Cursor::new(data)).is_ok_and(decode_all),
        ImageMime::Webp => WebPDecoder::new(Cursor::new(data)).is_ok_and(decode_all),
    }
}

fn decode_all(mut decoder: impl ImageDecoder) -> bool {
    if !within_pixel_budget(decoder.dimensions()) {
        return false;
    }
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_DECODED_PIXELS * 4 * 2 * 2);
    decoder.set_limits(limits).is_ok() && DynamicImage::from_decoder(decoder).is_ok()
}

/// JPEG decodes in strict mode, the counterpart of libvips with `failOn: 'warning'`: a decoder
/// warning is a refusal, never pixels filled in.
fn decodes_jpeg(data: &[u8]) -> bool {
    let options = DecoderOptions::default().set_strict_mode(true);
    let mut decoder = zune_jpeg::JpegDecoder::new_with_options(ZCursor::new(data), options);
    if decoder.decode_headers().is_err() {
        return false;
    }
    let Some(info) = decoder.info() else {
        return false;
    };
    within_pixel_budget((u32::from(info.width), u32::from(info.height))) && decoder.decode().is_ok()
}
