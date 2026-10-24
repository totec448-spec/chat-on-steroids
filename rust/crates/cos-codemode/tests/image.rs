//! An emitted image passes the check `view_image` applies (`validateImageBytes`): signature,
//! structure and a full decode. A right signature alone is not an image.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use cos_codemode::{Invoke, LIMITS, Options, run};
use cos_tools::{BoxFuture, ToolResult};
use serde_json::Value;

const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const INVALID: &str =
    r#"[{"type":"text","text":"CODE_MODE_OUTPUT_INVALID: image or text could not be validated."}]"#;

struct NoTools;

impl Invoke for NoTools {
    fn invoke(&self, tool: String, _arguments: Value) -> BoxFuture<'static, ToolResult> {
        Box::pin(async move { panic!("{tool} was not expected to run") })
    }
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

/// The fixture PNG with its compressed pixels replaced by bytes that are not zlib, and the
/// chunk checksum fixed, so only a decode can tell.
fn undecodable_png() -> Vec<u8> {
    let mut bytes = STANDARD.decode(PNG).expect("fixture");
    let idat = bytes
        .windows(4)
        .position(|window| window == b"IDAT")
        .expect("IDAT chunk");
    let length = u32::from_be_bytes(bytes[idat - 4..idat].try_into().expect("length")) as usize;
    let data = idat + 4..idat + 4 + length;
    bytes[data.clone()].fill(0xff);
    let crc = crc32(&bytes[idat..data.end]);
    bytes[data.end..data.end + 4].copy_from_slice(&crc.to_be_bytes());
    bytes
}

async fn emit(bytes: &[u8]) -> String {
    let code = format!(
        r#"image("data:image/png;base64,{}")"#,
        STANDARD.encode(bytes)
    );
    let result = run(&code, &[], &NoTools, &LIMITS, Options::default()).await;
    serde_json::to_string(&result.content).expect("serializes")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_image_must_decode_to_pixels() {
    let valid = emit(&STANDARD.decode(PNG).expect("fixture")).await;
    assert!(valid.contains(r#""type":"image""#), "{valid}");

    assert_eq!(
        emit(&undecodable_png()).await,
        INVALID,
        "pixels that do not decode"
    );
    let mut truncated = STANDARD.decode(PNG).expect("fixture");
    truncated.truncate(truncated.len() - 12);
    assert_eq!(
        emit(&truncated).await,
        INVALID,
        "a PNG without its end chunk"
    );
}
