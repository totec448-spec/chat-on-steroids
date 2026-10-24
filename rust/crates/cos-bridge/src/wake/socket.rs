//! One wake socket after its upgrade: authenticate within 5 s, then answer `ping` with `pong`.

use std::sync::Arc;
use std::time::Duration;

use cos_types::bridge::{ExtensionWakeFrame, WAKE_AUTH_DEADLINE_MS, WakeSignal};
use hyper::upgrade::Upgraded;
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::frame::{self, Decoder, Message};
use super::{Admitted, Hub};
use crate::pairing::Pairing;

/// How the socket ends.
enum End {
    /// `terminate()`: the connection drops at once.
    Terminate,
    /// The client sent a close frame; the echo is written before the connection closes.
    Closed,
}

pub(crate) async fn serve(
    hub: Arc<Hub>,
    pairing: Arc<Pairing>,
    upgraded: Upgraded,
    admitted: Admitted,
) {
    let Admitted {
        id,
        generation,
        outbox,
        mut outgoing,
        mut kill,
    } = admitted;
    let (mut reader, mut writer) = tokio::io::split(TokioIo::new(upgraded));
    let mut writing = tokio::spawn(async move {
        while let Some(frame) = outgoing.recv().await {
            if writer.write_all(&frame).await.is_err() {
                return;
            }
        }
        let _ = writer.shutdown().await;
    });
    let deadline = tokio::time::sleep(Duration::from_millis(WAKE_AUTH_DEADLINE_MS));
    tokio::pin!(deadline);
    let mut decoder = Decoder::default();
    let mut authorized = false;
    let end = 'socket: loop {
        tokio::select! {
            _ = &mut kill => break 'socket End::Terminate,
            _ = &mut deadline, if !authorized => break 'socket End::Terminate,
            read = reader.read_buf(decoder.buffer()) => {
                if !matches!(read, Ok(read) if read > 0) {
                    break 'socket End::Terminate;
                }
                loop {
                    let message = match decoder.next() {
                        Ok(Some(message)) => message,
                        Ok(None) => break,
                        Err(_) => break 'socket End::Terminate,
                    };
                    match message {
                        Message::Binary => break 'socket End::Terminate,
                        Message::Close(code) => {
                            let _ = outbox.try_send(frame::close(code));
                            break 'socket End::Closed;
                        }
                        Message::Ping(payload) => {
                            let _ = outbox.try_send(frame::pong(&payload));
                        }
                        Message::Pong => {}
                        Message::Text(text) => match ExtensionWakeFrame::parse(&text, authorized) {
                            Some(ExtensionWakeFrame::Pong) => hub.pong(id),
                            Some(ExtensionWakeFrame::Authenticate(token)) => {
                                if !pairing.wake_token_matches(&token).await
                                    || !hub.authorize(id, generation)
                                {
                                    break 'socket End::Terminate;
                                }
                                authorized = true;
                                // Reconnection always reads current work.
                                let _ = outbox.try_send(frame::text(WakeSignal::Wake.as_str()));
                            }
                            None => break 'socket End::Terminate,
                        },
                    }
                }
            }
        }
    };
    hub.leave(id);
    drop(outbox);
    match end {
        End::Terminate => writing.abort(),
        End::Closed => {
            if tokio::time::timeout(Duration::from_secs(1), &mut writing)
                .await
                .is_err()
            {
                writing.abort();
            }
        }
    }
}
