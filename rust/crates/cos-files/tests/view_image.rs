//! `view_image` through the kernel, with the cases of `test/codex-view-image-parity.test.ts`:
//! nothing that does not decode to pixels may reach the model as an image.

mod support;

use std::fs;
use std::io::Cursor;

use serde_json::{Value, json};
use support::{Served, decode_base64};

const PIXEL: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const INVALID: &str = "unable to process image: invalid or unsupported image data";

async fn view(served: &Served, name: &str, bytes: &[u8]) -> Value {
    fs::write(served.dirs.project.join(name), bytes).expect("image written");
    served
        .call("view_image", json!({ "path": format!("/project/{name}") }))
        .await
        .expect("view_image is listed")
}

fn refusal(result: &Value) -> Option<&str> {
    (result["isError"] == true).then(|| result["content"][0]["text"].as_str().unwrap_or_default())
}

fn crc32(data: &[u8]) -> u32 {
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
    !crc
}

/// The 1x1 PNG's chunks, each as (type, data).
fn chunks(png: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    let mut at = 8;
    while at + 12 <= png.len() {
        let length = u32::from_be_bytes(png[at..at + 4].try_into().expect("length")) as usize;
        let kind = String::from_utf8_lossy(&png[at + 4..at + 8]).into_owned();
        out.push((kind, png[at + 8..at + 8 + length].to_vec()));
        at += 12 + length;
    }
    out
}

fn assemble(parts: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut out = decode_base64(PIXEL)[..8].to_vec();
    for (kind, data) in parts {
        out.extend((data.len() as u32).to_be_bytes());
        let typed: Vec<u8> = kind.bytes().chain(data.iter().copied()).collect();
        out.extend(&typed);
        out.extend(crc32(&typed).to_be_bytes());
    }
    out
}

fn png_with(edit: impl Fn(&str, &mut Vec<u8>) -> bool) -> Vec<u8> {
    let parts: Vec<(String, Vec<u8>)> = chunks(&decode_base64(PIXEL))
        .into_iter()
        .filter_map(|(kind, mut data)| edit(&kind, &mut data).then_some((kind, data)))
        .collect();
    assemble(&parts)
}

fn jpeg() -> Vec<u8> {
    let image = image::RgbImage::from_pixel(8, 6, image::Rgb([0xd2, 0x37, 0x61]));
    let mut out = Cursor::new(Vec::new());
    image
        .write_to(&mut out, image::ImageFormat::Jpeg)
        .expect("jpeg encodes");
    out.into_inner()
}

#[tokio::test]
async fn returns_a_decodable_image_as_native_image_content() {
    let served = Served::variant("base");
    let bytes = decode_base64(PIXEL);
    let result = view(&served, "pixel.png", &bytes).await;
    assert_eq!(result["content"][0]["type"], "image");
    assert_eq!(result["content"][0]["mimeType"], "image/png");
    assert_eq!(
        decode_base64(result["content"][0]["data"].as_str().expect("data")),
        bytes
    );
}

#[tokio::test]
async fn accepts_a_jpeg_with_trailing_bytes_unchanged() {
    let served = Served::variant("base");
    for tail in [&b"\n"[..], b"\r\n", b"\0trailing bytes"] {
        let bytes = [jpeg(), tail.to_vec()].concat();
        let result = view(&served, "trailing.jpg", &bytes).await;
        assert_eq!(refusal(&result), None, "tail {tail:?}");
        assert_eq!(result["content"][0]["mimeType"], "image/jpeg");
        assert_eq!(
            decode_base64(result["content"][0]["data"].as_str().expect("data")),
            bytes
        );
    }
}

#[tokio::test]
async fn refuses_images_that_do_not_decode() {
    let served = Served::variant("base");
    let full = jpeg();
    let gif_no_frame = [b"GIF89a".as_slice(), &[1, 0, 1, 0, 0, 0, 0, 0x3b]].concat();
    let gif_no_lzw = [
        b"GIF89a".as_slice(),
        &[1, 0, 1, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x3b],
    ]
    .concat();
    let webp = |chunk: &[u8; 4], payload: &[u8]| {
        let mut out = b"RIFF".to_vec();
        out.extend(((payload.len() + 12) as u32).to_le_bytes());
        out.extend(b"WEBP");
        out.extend(chunk);
        out.extend((payload.len() as u32).to_le_bytes());
        out.extend(payload);
        out
    };
    let cases: Vec<(&str, &str, Vec<u8>)> = vec![
        ("truncated JPEG", "a.jpg", full[..full.len() - 2].to_vec()),
        (
            "JPEG cut inside its scan, end marker kept",
            "a2.jpg",
            [&full[..full.len() - 40], &[0xff, 0xd9][..]].concat(),
        ),
        (
            "JPEG without scan data",
            "b.jpg",
            vec![
                0xff, 0xd8, 0xff, 0xc0, 0, 0x0b, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xd9,
            ],
        ),
        (
            "JPEG with a scan header but no entropy data",
            "c.jpg",
            vec![
                0xff, 0xd8, 0xff, 0xc0, 0, 0x0b, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1,
                1, 0, 0, 0x3f, 0, 0xff, 0xd9, b'\n',
            ],
        ),
        (
            "PNG without IDAT",
            "d.png",
            png_with(|kind, _| kind != "IDAT"),
        ),
        (
            "PNG with zeroed deflate and a valid CRC",
            "e.png",
            png_with(|kind, data| {
                if kind == "IDAT" {
                    data.fill(0);
                }
                true
            }),
        ),
        (
            "PNG with a zlib header over garbage deflate",
            "f.png",
            png_with(|kind, data| {
                if kind == "IDAT" {
                    *data = vec![0x78, 0x9c, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
                }
                true
            }),
        ),
        (
            "PNG whose data inflates to too few pixels",
            "g.png",
            png_with(|kind, data| {
                if kind == "IDAT" {
                    *data = vec![0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01];
                }
                true
            }),
        ),
        (
            "PNG geometry over the decode budget",
            "h.png",
            png_with(|kind, data| {
                if kind == "IHDR" {
                    data[..4].copy_from_slice(&8192u32.to_be_bytes());
                    data[4..8].copy_from_slice(&8192u32.to_be_bytes());
                }
                true
            }),
        ),
        ("GIF without an image frame", "i.gif", gif_no_frame),
        ("GIF with a descriptor but no LZW data", "j.gif", gif_no_lzw),
        (
            "WebP with only a VP8X header",
            "k.webp",
            webp(b"VP8X", &[0; 10]),
        ),
        ("WebP with an empty VP8 chunk", "l.webp", webp(b"VP8 ", &[])),
        (
            "WebP with a garbage VP8 payload",
            "m.webp",
            webp(b"VP8 ", &[0; 10]),
        ),
        (
            "WebP with a plausible VP8 prefix",
            "n.webp",
            webp(b"VP8 ", &[0, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0]),
        ),
        ("text named like an image", "o.png", b"hello".to_vec()),
    ];
    for (label, name, bytes) in cases {
        let result = view(&served, name, &bytes).await;
        assert_eq!(refusal(&result), Some(INVALID), "{label}");
    }
}

#[tokio::test]
async fn refuses_a_folder_and_an_oversized_file_with_codex_words() {
    let served = Served::variant("base");
    fs::create_dir_all(served.dirs.project.join("folder.png")).expect("folder");
    let folder = served
        .call("view_image", json!({ "path": "/project/folder.png" }))
        .await
        .expect("listed");
    assert_eq!(
        refusal(&folder),
        Some("image path `/project/folder.png` is not a file")
    );

    let big = fs::File::create(served.dirs.project.join("big.png")).expect("big");
    big.set_len(7 * 1024 * 1024).expect("size");
    let result = served
        .call("view_image", json!({ "path": "/project/big.png" }))
        .await
        .expect("listed");
    assert_eq!(
        refusal(&result),
        Some(
            "unable to read image at `/project/big.png`: image is too large to return (7.0 MB; limit 6.0 MB)"
        )
    );
}
