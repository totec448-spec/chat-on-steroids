//! `readTextFile`: a bounded, streamed read of numbered text lines (`codex/read-backend.ts`).

use std::path::Path;

use cos_fs::{
    BINARY_SNIFF_BYTES, DEFAULT_READ_BYTES, MAX_READ_BYTES, format_bytes, sniff_binary_bytes,
};

use crate::disk::{self, CHUNK_BYTES, Kind, MAX_LINE_COUNT_BYTES};
use crate::failure::Failure;
use crate::js;

/// A single decoded line may not grow past this many UTF-16 units (`MAX_DECODED_LINE_CHARS`).
const MAX_DECODED_LINE_UNITS: usize = 2 * 1024 * 1024;

pub(crate) struct TextRead {
    pub lines: Vec<String>,
    /// The output byte budget stopped the read.
    pub truncated: bool,
    /// At least one line exists after the last line returned.
    pub has_more: bool,
    pub first_line: u64,
    pub last_line: u64,
    pub total_lines: Option<u64>,
}

pub(crate) enum TextError {
    /// The first bytes look binary (`BinaryReadError`); `read` answers with metadata instead.
    Binary,
    Failed(Failure),
}

impl<E: Into<Failure>> From<E> for TextError {
    fn from(error: E) -> Self {
        Self::Failed(error.into())
    }
}

/// WHATWG `TextDecoder` for the three encodings `read` recognizes, in streaming mode. The
/// encoding's byte order mark is dropped at the start of the stream, as the decoder's default
/// does.
enum Decoder {
    Utf8 {
        pending: Vec<u8>,
    },
    Utf16 {
        big_endian: bool,
        odd: Option<u8>,
        high: Option<u16>,
    },
}

impl Decoder {
    fn for_head(head: &[u8]) -> Self {
        match head {
            [0xff, 0xfe, ..] => Self::Utf16 {
                big_endian: false,
                odd: None,
                high: None,
            },
            [0xfe, 0xff, ..] => Self::Utf16 {
                big_endian: true,
                odd: None,
                high: None,
            },
            _ => Self::Utf8 {
                pending: Vec::new(),
            },
        }
    }

    fn decode(&mut self, bytes: &[u8], out: &mut String) {
        match self {
            Self::Utf8 { pending } => {
                pending.extend_from_slice(bytes);
                let mut at = 0;
                loop {
                    match std::str::from_utf8(&pending[at..]) {
                        Ok(text) => {
                            out.push_str(text);
                            at = pending.len();
                            break;
                        }
                        Err(error) => {
                            let valid = at + error.valid_up_to();
                            out.push_str(
                                std::str::from_utf8(&pending[at..valid]).unwrap_or_default(),
                            );
                            match error.error_len() {
                                Some(length) => {
                                    out.push('\u{fffd}');
                                    at = valid + length;
                                }
                                None => {
                                    at = valid;
                                    break;
                                }
                            }
                        }
                    }
                }
                pending.drain(..at);
            }
            Self::Utf16 {
                big_endian,
                odd,
                high,
            } => {
                let mut bytes = bytes.iter().copied();
                loop {
                    let first = match odd.take() {
                        Some(byte) => byte,
                        None => match bytes.next() {
                            Some(byte) => byte,
                            None => break,
                        },
                    };
                    let Some(second) = bytes.next() else {
                        *odd = Some(first);
                        break;
                    };
                    let unit = if *big_endian {
                        u16::from_be_bytes([first, second])
                    } else {
                        u16::from_le_bytes([first, second])
                    };
                    push_unit(unit, high, out);
                }
            }
        }
    }

    /// End of stream: an incomplete sequence becomes one replacement character.
    fn finish(&mut self, out: &mut String) {
        let incomplete = match self {
            Self::Utf8 { pending } => !std::mem::take(pending).is_empty(),
            Self::Utf16 { odd, high, .. } => odd.take().is_some() | high.take().is_some(),
        };
        if incomplete {
            out.push('\u{fffd}');
        }
    }
}

fn push_unit(unit: u16, high: &mut Option<u16>, out: &mut String) {
    match (high.take(), unit) {
        (Some(lead), 0xdc00..=0xdfff) => {
            let code = 0x10000 + ((u32::from(lead) - 0xd800) << 10) + (u32::from(unit) - 0xdc00);
            out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
        }
        (lead, 0xd800..=0xdbff) => {
            if lead.is_some() {
                out.push('\u{fffd}');
            }
            *high = Some(unit);
        }
        (lead, 0xdc00..=0xdfff) => {
            if lead.is_some() {
                out.push('\u{fffd}');
            }
            out.push('\u{fffd}');
        }
        (lead, _) => {
            if lead.is_some() {
                out.push('\u{fffd}');
            }
            out.push(char::from_u32(u32::from(unit)).unwrap_or('\u{fffd}'));
        }
    }
}

/// The line-by-line state of one read.
struct Lines {
    start: u64,
    end: Option<u64>,
    max_bytes: u64,
    count_to_end: bool,
    out: Vec<String>,
    bytes_returned: u64,
    line_no: u64,
    first_line: u64,
    last_line: u64,
    truncated: bool,
    budget_exhausted: bool,
    passed_range: bool,
}

impl Lines {
    /// Whether the stream should keep going. Past the range it runs on only to count lines.
    fn push(&mut self, line: &str) -> Result<bool, Failure> {
        self.line_no += 1;
        if self.line_no < self.start {
            return Ok(true);
        }
        if self.end.is_some_and(|end| self.line_no > end) {
            self.passed_range = true;
            return Ok(self.count_to_end);
        }
        if self.budget_exhausted {
            return Ok(self.count_to_end);
        }
        let size = line.len() as u64 + 1;
        if self.bytes_returned + size > self.max_bytes {
            // Zero lines and "continue from the same line" would be a retry loop.
            if self.first_line == 0 {
                return Err(Failure::Refused(format!(
                    "Line {} is larger than max_bytes={}. Increase max_bytes (up to {MAX_READ_BYTES}) or use exec_command to transform it.",
                    self.line_no, self.max_bytes
                )));
            }
            self.truncated = true;
            self.budget_exhausted = true;
            return Ok(self.count_to_end);
        }
        if self.first_line == 0 {
            self.first_line = self.line_no;
        }
        self.last_line = self.line_no;
        self.out.push(line.to_owned());
        self.bytes_returned += size;
        Ok(true)
    }
}

fn strip_cr(line: &str) -> &str {
    line.strip_suffix('\r').unwrap_or(line)
}

/// `readTextFile`.
pub(crate) fn read_text_file(
    real: &Path,
    shown: &str,
    start_line: Option<u64>,
    end_line: Option<u64>,
    max_bytes: Option<u64>,
) -> Result<TextRead, TextError> {
    let meta = disk::metadata(real)?;
    if meta.kind != Kind::File {
        return Err(Failure::Refused("Not a file".to_owned()).into());
    }
    let max_bytes = max_bytes
        .unwrap_or(DEFAULT_READ_BYTES)
        .clamp(1, MAX_READ_BYTES);
    let start = start_line.unwrap_or(1).max(1);
    if end_line.is_some_and(|end| end < start) {
        return Err(Failure::Refused(
            "endLine must be greater than or equal to startLine".to_owned(),
        )
        .into());
    }
    let mut lines = Lines {
        start,
        end: end_line,
        max_bytes,
        count_to_end: meta.size <= MAX_LINE_COUNT_BYTES,
        out: Vec::new(),
        bytes_returned: 0,
        line_no: 0,
        first_line: 0,
        last_line: 0,
        truncated: false,
        budget_exhausted: false,
        passed_range: false,
    };

    let (mut file, _) = disk::open_regular_file(real, shown)?;
    let mut buffer = vec![0u8; CHUNK_BYTES];
    let mut decoder: Option<Decoder> = None;
    let mut carry = String::new();
    let mut scanned = 0u64;
    let mut saw_all = true;
    loop {
        let read = disk::read_chunk(&mut file, &mut buffer)?;
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        scanned += read as u64;
        // A file that grew past the count budget since the stat stops claiming a total.
        if scanned > MAX_LINE_COUNT_BYTES {
            lines.count_to_end = false;
        }
        let stream_start = decoder.is_none();
        if stream_start && sniff_binary_bytes(&chunk[..chunk.len().min(BINARY_SNIFF_BYTES)]) {
            return Err(TextError::Binary);
        }
        decoder
            .get_or_insert_with(|| Decoder::for_head(chunk))
            .decode(chunk, &mut carry);
        if stream_start && carry.starts_with('\u{feff}') {
            carry.drain(..'\u{feff}'.len_utf8());
        }
        let mut consumed = 0;
        while let Some(offset) = carry[consumed..].find('\n') {
            let end = consumed + offset;
            let keep_going = lines.push(strip_cr(&carry[consumed..end]))?;
            consumed = end + 1;
            if !keep_going {
                saw_all = false;
                break;
            }
        }
        if !saw_all {
            break;
        }
        carry.drain(..consumed);
        if carry.len() > MAX_DECODED_LINE_UNITS && js::utf16_len(&carry) > MAX_DECODED_LINE_UNITS {
            return Err(Failure::Refused(format!(
                "A line exceeds the safe decoded-line limit ({}). Narrow or transform the file before reading it.",
                format_bytes(MAX_DECODED_LINE_UNITS as u64)
            ))
            .into());
        }
    }
    if saw_all && let Some(decoder) = &mut decoder {
        decoder.finish(&mut carry);
        if !carry.is_empty() && !lines.push(strip_cr(&carry))? {
            saw_all = false;
        }
    }
    if lines.first_line == 0 {
        // An empty file or a range past the end.
        lines.first_line = start;
        lines.last_line = start - 1;
    }
    if let Some(first) = lines.out.first_mut()
        && let Some(stripped) = first.strip_prefix('\u{feff}')
    {
        *first = stripped.to_owned();
    }
    Ok(TextRead {
        has_more: lines.passed_range || lines.truncated,
        truncated: lines.truncated,
        first_line: lines.first_line,
        last_line: lines.last_line,
        total_lines: saw_all.then_some(lines.line_no),
        lines: lines.out,
    })
}
