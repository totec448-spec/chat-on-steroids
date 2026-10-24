//! The part of RFC 6455 the wake socket uses: the opening handshake key, client frames of at
//! most [`WAKE_MAX_PAYLOAD`] bytes, and short unmasked server frames. No extension is ever
//! negotiated (`perMessageDeflate: false`), so every reserved bit must be clear.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use bytes::{Buf, BytesMut};
use cos_types::bridge::WAKE_MAX_PAYLOAD;

const ACCEPT_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const CONTINUATION: u8 = 0x0;
const TEXT: u8 = 0x1;
const BINARY: u8 = 0x2;
const CLOSE: u8 = 0x8;
const PING: u8 = 0x9;
const PONG: u8 = 0xA;

/// `Sec-WebSocket-Accept` for a client's `Sec-WebSocket-Key`.
pub(crate) fn accept_key(key: &str) -> String {
    let mut sha1 = sha1_smol::Sha1::new();
    sha1.update(key.as_bytes());
    sha1.update(ACCEPT_GUID.as_bytes());
    STANDARD.encode(sha1.digest().bytes())
}

/// A whole message from the client.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Message {
    Text(String),
    Binary,
    Ping(Vec<u8>),
    Pong,
    /// The close code the client sent, if any.
    Close(Option<u16>),
}

/// A frame or message the socket is closed for. The `ws` server sends a close code first; the
/// wake socket ends the connection, which the extension treats the same way.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Violation {
    /// Over [`WAKE_MAX_PAYLOAD`] (1009).
    TooLarge,
    /// Unmasked, reserved bits, an unknown opcode or a broken fragment sequence (1002).
    Protocol,
    /// A text message that is not UTF-8 (1007).
    NotText,
}

/// Reads messages out of the bytes received so far. Cancel-safe: the caller appends to
/// [`Decoder::buffer`] with `read_buf` and calls [`Decoder::next`] until it returns `None`.
#[derive(Default)]
pub(crate) struct Decoder {
    buffer: BytesMut,
    /// The opcode and payload of a fragmented message so far.
    fragments: Option<(u8, Vec<u8>)>,
}

impl Decoder {
    pub(crate) fn buffer(&mut self) -> &mut BytesMut {
        &mut self.buffer
    }

    pub(crate) fn next(&mut self) -> Result<Option<Message>, Violation> {
        loop {
            let Some((fin, opcode, payload)) = self.frame()? else {
                return Ok(None);
            };
            if opcode >= CLOSE {
                if !fin || payload.len() > 125 {
                    return Err(Violation::Protocol);
                }
                return Ok(Some(match opcode {
                    CLOSE => Message::Close(
                        (payload.len() >= 2).then(|| u16::from_be_bytes([payload[0], payload[1]])),
                    ),
                    PING => Message::Ping(payload),
                    PONG => Message::Pong,
                    _ => return Err(Violation::Protocol),
                }));
            }
            let (opcode, payload) = match (opcode, self.fragments.take()) {
                (TEXT | BINARY, None) => (opcode, payload),
                (CONTINUATION, Some((first, mut gathered))) => {
                    gathered.extend_from_slice(&payload);
                    (first, gathered)
                }
                _ => return Err(Violation::Protocol),
            };
            if payload.len() > WAKE_MAX_PAYLOAD {
                return Err(Violation::TooLarge);
            }
            if !fin {
                self.fragments = Some((opcode, payload));
                continue;
            }
            return match opcode {
                TEXT => String::from_utf8(payload)
                    .map(|text| Some(Message::Text(text)))
                    .map_err(|_| Violation::NotText),
                _ => Ok(Some(Message::Binary)),
            };
        }
    }

    /// One whole frame, unmasked, or `None` until enough bytes have arrived.
    fn frame(&mut self) -> Result<Option<(bool, u8, Vec<u8>)>, Violation> {
        let bytes = &self.buffer[..];
        if bytes.len() < 2 {
            return Ok(None);
        }
        let (fin, reserved, opcode) = (bytes[0] & 0x80 != 0, bytes[0] & 0x70, bytes[0] & 0x0F);
        let masked = bytes[1] & 0x80 != 0;
        if reserved != 0
            || !masked
            || !matches!(opcode, CONTINUATION | TEXT | BINARY | CLOSE | PING | PONG)
        {
            return Err(Violation::Protocol);
        }
        let (length, header) = match bytes[1] & 0x7F {
            126 => {
                let Some(extended) = bytes.get(2..4) else {
                    return Ok(None);
                };
                (
                    usize::from(u16::from_be_bytes([extended[0], extended[1]])),
                    4,
                )
            }
            127 => return Err(Violation::TooLarge),
            short => (usize::from(short), 2),
        };
        if length > WAKE_MAX_PAYLOAD {
            return Err(Violation::TooLarge);
        }
        if bytes.len() < header + 4 + length {
            return Ok(None);
        }
        let mask = [
            bytes[header],
            bytes[header + 1],
            bytes[header + 2],
            bytes[header + 3],
        ];
        let payload: Vec<u8> = bytes[header + 4..header + 4 + length]
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ mask[index % 4])
            .collect();
        self.buffer.advance(header + 4 + length);
        Ok(Some((fin, opcode, payload)))
    }
}

/// A server frame: final, unmasked, with a payload of at most 125 bytes.
fn server_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let length = payload.len().min(125);
    let mut frame = Vec::with_capacity(2 + length);
    frame.push(0x80 | opcode);
    frame.push(u8::try_from(length).unwrap_or(125));
    frame.extend_from_slice(&payload[..length]);
    frame
}

pub(crate) fn text(text: &str) -> Vec<u8> {
    server_frame(TEXT, text.as_bytes())
}

pub(crate) fn pong(payload: &[u8]) -> Vec<u8> {
    server_frame(PONG, payload)
}

pub(crate) fn close(code: Option<u16>) -> Vec<u8> {
    match code {
        Some(code) => server_frame(CLOSE, &code.to_be_bytes()),
        None => server_frame(CLOSE, &[]),
    }
}

#[cfg(test)]
pub(crate) fn client_frame(fin: bool, opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mask = [0x12, 0x34, 0x56, 0x78];
    let mut frame = vec![if fin { 0x80 } else { 0 } | opcode];
    match payload.len() {
        length @ 0..=125 => frame.push(0x80 | u8::try_from(length).unwrap_or(125)),
        length => {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&u16::try_from(length).unwrap_or(u16::MAX).to_be_bytes());
        }
    }
    frame.extend_from_slice(&mask);
    frame.extend(
        payload
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ mask[index % 4]),
    );
    frame
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(bytes: &[u8]) -> Result<Option<Message>, Violation> {
        let mut decoder = Decoder::default();
        decoder.buffer().extend_from_slice(bytes);
        decoder.next()
    }

    #[test]
    fn the_accept_key_is_the_rfc_example() {
        assert_eq!(
            accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn a_text_message_arrives_whole_even_across_reads_and_fragments() {
        let mut decoder = Decoder::default();
        let frame = client_frame(true, TEXT, b"pong");
        decoder.buffer().extend_from_slice(&frame[..3]);
        assert_eq!(decoder.next(), Ok(None));
        decoder.buffer().extend_from_slice(&frame[3..]);
        assert_eq!(decoder.next(), Ok(Some(Message::Text("pong".into()))));

        let mut split = client_frame(false, TEXT, b"to");
        split.extend(client_frame(true, PING, b"!"));
        split.extend(client_frame(true, CONTINUATION, b"ken"));
        let mut decoder = Decoder::default();
        decoder.buffer().extend_from_slice(&split);
        assert_eq!(decoder.next(), Ok(Some(Message::Ping(b"!".to_vec()))));
        assert_eq!(decoder.next(), Ok(Some(Message::Text("token".into()))));
        assert_eq!(decoder.next(), Ok(None));
    }

    #[test]
    fn a_message_over_512_bytes_is_refused_and_512_is_not() {
        assert!(matches!(
            decode(&client_frame(true, TEXT, &[b'a'; 512])),
            Ok(Some(Message::Text(_)))
        ));
        assert_eq!(
            decode(&client_frame(true, TEXT, &[b'a'; 513])),
            Err(Violation::TooLarge)
        );
        let mut fragments = client_frame(false, TEXT, &[b'a'; 300]);
        fragments.extend(client_frame(true, CONTINUATION, &[b'a'; 300]));
        let mut decoder = Decoder::default();
        decoder.buffer().extend_from_slice(&fragments);
        assert_eq!(decoder.next(), Err(Violation::TooLarge));
    }

    #[test]
    fn unmasked_reserved_and_binary_frames_are_told_apart() {
        assert_eq!(decode(&[0x81, 0x01, b'x']), Err(Violation::Protocol));
        let mut reserved = client_frame(true, TEXT, b"x");
        reserved[0] |= 0x40;
        assert_eq!(decode(&reserved), Err(Violation::Protocol));
        assert_eq!(
            decode(&client_frame(true, BINARY, b"x")),
            Ok(Some(Message::Binary))
        );
        assert_eq!(
            decode(&client_frame(true, TEXT, &[0xFF])),
            Err(Violation::NotText)
        );
        assert_eq!(
            decode(&client_frame(true, CLOSE, &1000u16.to_be_bytes())),
            Ok(Some(Message::Close(Some(1000))))
        );
    }

    #[test]
    fn server_frames_are_final_and_unmasked() {
        assert_eq!(text("wake"), [0x81, 4, b'w', b'a', b'k', b'e']);
        assert_eq!(close(Some(1000)), [0x88, 2, 0x03, 0xE8]);
        assert_eq!(close(None), [0x88, 0]);
        assert_eq!(pong(b"x"), [0x8A, 1, b'x']);
    }
}
