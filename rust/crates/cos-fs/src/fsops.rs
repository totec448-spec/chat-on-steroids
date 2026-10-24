//! Bounds, the binary sniff and image checks the file tools share (`fsops.ts`).

use std::fmt;

/// Default and maximum text payload of one model-visible `read` section.
pub const DEFAULT_READ_BYTES: u64 = 256 * 1024;
pub const MAX_READ_BYTES: u64 = 512 * 1024;
/// Local images returned to the model are capped before base64 expansion.
pub const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
/// Bytes inspected when deciding whether a file is binary.
pub const BINARY_SNIFF_BYTES: usize = 8192;

/// A file operation refused for a reason about the file itself. `Display` is the model text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FsOpError(pub String);

impl fmt::Display for FsOpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for FsOpError {}

/// The binary heuristic: a BOM means text, a NUL means binary, and so does a slice where more
/// than 30% of bytes are control characters other than tab, LF and CR.
pub fn sniff_binary_bytes(slice: &[u8]) -> bool {
    if slice.is_empty() {
        return false;
    }
    if slice.starts_with(&[0xff, 0xfe])
        || slice.starts_with(&[0xfe, 0xff])
        || slice.starts_with(&[0xef, 0xbb, 0xbf])
    {
        return false;
    }
    if slice.contains(&0) {
        return true;
    }
    let suspicious = slice
        .iter()
        .filter(|&&byte| !matches!(byte, 9 | 10 | 13) && (byte < 32 || byte == 127))
        .count();
    suspicious as f64 / slice.len() as f64 > 0.3
}

/// A folder name matches an exclude pattern case-insensitively; a trailing `*` means a prefix.
pub fn is_excluded_folder_name(name: &str, patterns: &[impl AsRef<str>]) -> bool {
    let lower = name.to_lowercase();
    patterns.iter().any(|raw| {
        let pattern = raw.as_ref().to_lowercase();
        match pattern.strip_suffix('*') {
            Some(prefix) => lower.starts_with(prefix),
            None => lower == pattern,
        }
    })
}

/// `512 B`, `2.0 KB`, `5.0 MB`, `1.25 GB`. Rounds half up like `Number.prototype.toFixed`.
pub fn format_bytes(bytes: u64) -> String {
    const KB: u64 = 1024;
    if bytes < KB {
        return format!("{bytes} B");
    }
    let (unit, divisor, digits) = if bytes < KB * KB {
        ("KB", KB, 1)
    } else if bytes < KB * KB * KB {
        ("MB", KB * KB, 1)
    } else {
        ("GB", KB * KB * KB, 2)
    };
    let scale: u128 = if digits == 1 { 10 } else { 100 };
    let divisor = u128::from(divisor);
    let scaled = (u128::from(bytes) * scale * 2 + divisor) / (divisor * 2);
    let whole = scaled / scale;
    let fraction = scaled % scale;
    if digits == 1 {
        format!("{whole}.{fraction} {unit}")
    } else {
        format!("{whole}.{fraction:02} {unit}")
    }
}

/// `clamp`: a non-finite value becomes `min`; others are floored into `[min, max]`.
pub fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if !value.is_finite() {
        return min;
    }
    value.floor().max(min).min(max)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageMime {
    Png,
    Jpeg,
    Gif,
    Webp,
}

impl ImageMime {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
        }
    }
}

/// Node's `ascii` decoding: each byte with its high bit cleared.
fn ascii(bytes: &[u8]) -> String {
    bytes.iter().map(|&byte| char::from(byte & 0x7f)).collect()
}

fn u32_be(data: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]])
}

fn u32_le(data: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]])
}

fn u16_be(data: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([data[at], data[at + 1]])
}

fn u16_le(data: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([data[at], data[at + 1]])
}

/// The image format the signature names, if it is one the tools return.
pub fn image_mime(data: &[u8]) -> Option<ImageMime> {
    if data.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some(ImageMime::Png);
    }
    if data.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some(ImageMime::Jpeg);
    }
    if data.len() >= 6 && matches!(ascii(&data[..6]).as_str(), "GIF87a" | "GIF89a") {
        return Some(ImageMime::Gif);
    }
    if data.len() >= 12 && ascii(&data[..4]) == "RIFF" && ascii(&data[8..12]) == "WEBP" {
        return Some(ImageMime::Webp);
    }
    None
}

fn invalid(kind: &str, detail: &str) -> FsOpError {
    FsOpError(format!("Invalid or corrupt {kind} image: {detail}"))
}

fn png_crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                0xedb8_8320 ^ (crc >> 1)
            } else {
                crc >> 1
            };
        }
    }
    crc ^ 0xffff_ffff
}

fn validate_png(data: &[u8]) -> Result<(), FsOpError> {
    if data.len() < 33 {
        return Err(invalid("PNG", "file is too short"));
    }
    let mut offset = 8usize;
    let mut first = true;
    while offset + 12 <= data.len() {
        let length = u32_be(data, offset) as usize;
        let type_start = offset + 4;
        let data_start = offset + 8;
        let crc_offset = data_start.saturating_add(length);
        if crc_offset.saturating_add(4) > data.len() {
            return Err(invalid("PNG", "a chunk extends past the end of the file"));
        }
        let kind = ascii(&data[type_start..data_start]);
        if first {
            if kind != "IHDR" || length != 13 {
                return Err(invalid("PNG", "IHDR is missing or malformed"));
            }
            if u32_be(data, data_start) == 0 || u32_be(data, data_start + 4) == 0 {
                return Err(invalid("PNG", "image dimensions are zero"));
            }
            first = false;
        }
        if u32_be(data, crc_offset) != png_crc32(&data[type_start..crc_offset]) {
            return Err(invalid(
                "PNG",
                &format!("CRC check failed for {kind} chunk"),
            ));
        }
        offset = crc_offset + 4;
        if kind == "IEND" {
            if length != 0 {
                return Err(invalid("PNG", "IEND chunk is malformed"));
            }
            return Ok(());
        }
    }
    Err(invalid("PNG", "IEND chunk is missing"))
}

const JPEG_FRAME_MARKERS: [u8; 13] = [
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
];

fn validate_jpeg(data: &[u8]) -> Result<(), FsOpError> {
    // EOI ends the codestream, not necessarily the file: downloads can carry trailing bytes.
    let end = data.windows(2).rposition(|pair| pair == [0xff, 0xd9]);
    let end = match end {
        Some(end) if data.len() >= 8 && end >= 2 => end,
        _ => return Err(invalid("JPEG", "end marker is missing")),
    };
    let mut offset = 2usize;
    let mut saw_frame = false;
    while offset < end {
        while offset < data.len() && data[offset] == 0xff {
            offset += 1;
        }
        if offset >= data.len() {
            break;
        }
        let marker = data[offset];
        offset += 1;
        // Scan data runs until the EOI found above.
        if marker == 0xd9 || marker == 0xda {
            break;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        if offset + 2 > data.len() {
            return Err(invalid("JPEG", "segment length is truncated"));
        }
        let length = usize::from(u16_be(data, offset));
        if length < 2 || offset + length > data.len() {
            return Err(invalid("JPEG", "segment extends past the end of the file"));
        }
        if JPEG_FRAME_MARKERS.contains(&marker) {
            if length < 7 {
                return Err(invalid("JPEG", "frame header is malformed"));
            }
            if u16_be(data, offset + 5) == 0 || u16_be(data, offset + 3) == 0 {
                return Err(invalid("JPEG", "image dimensions are zero"));
            }
            saw_frame = true;
        }
        offset += length;
    }
    if saw_frame {
        Ok(())
    } else {
        Err(invalid("JPEG", "frame header is missing"))
    }
}

fn validate_gif(data: &[u8]) -> Result<(), FsOpError> {
    if data.len() < 14 {
        return Err(invalid("GIF", "file is too short"));
    }
    if u16_le(data, 6) == 0 || u16_le(data, 8) == 0 {
        return Err(invalid("GIF", "image dimensions are zero"));
    }
    if data.last() != Some(&0x3b) {
        return Err(invalid("GIF", "trailer is missing"));
    }
    Ok(())
}

fn validate_webp(data: &[u8]) -> Result<(), FsOpError> {
    if data.len() < 20 {
        return Err(invalid("WebP", "file is too short"));
    }
    if u64::from(u32_le(data, 4)) + 8 != data.len() as u64 {
        return Err(invalid("WebP", "RIFF size does not match the file"));
    }
    let mut offset = 12usize;
    let mut saw_image = false;
    while offset + 8 <= data.len() {
        let kind = ascii(&data[offset..offset + 4]);
        let length = u64::from(u32_le(data, offset + 4));
        let next = offset as u64 + 8 + length + (length & 1);
        if next > data.len() as u64 {
            return Err(invalid("WebP", "a chunk extends past the end of the file"));
        }
        if matches!(kind.as_str(), "VP8 " | "VP8L" | "VP8X") {
            saw_image = true;
        }
        offset = next as usize;
    }
    if saw_image {
        Ok(())
    } else {
        Err(invalid("WebP", "image payload chunk is missing"))
    }
}

/// Structural checks that the bytes are a whole image of `mime`. Pixel decoding is still the
/// caller's job.
pub fn validate_image_structure(data: &[u8], mime: ImageMime) -> Result<(), FsOpError> {
    match mime {
        ImageMime::Png => validate_png(data),
        ImageMime::Jpeg => validate_jpeg(data),
        ImageMime::Gif => validate_gif(data),
        ImageMime::Webp => validate_webp(data),
    }
}
