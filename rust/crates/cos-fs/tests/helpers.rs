//! Glob matching, line deltas, stray virtual paths and the bounds and image helpers
//! (`search.test.ts`, `session.test.ts`, `sandbox.test.ts`, `fsops.test.ts`).

mod common;

use std::path::Path;

use common::roots;
use cos_fs::{
    FsOpError, Glob, ImageMime, LineDelta, clamp, format_bytes, format_delta, image_mime,
    is_excluded_folder_name, line_delta, sniff_binary_bytes, stray_virtual_path,
    validate_image_structure,
};

#[test]
fn glob_star_stays_within_one_segment() {
    let glob = Glob::new("*.ts", false);
    assert!(glob.is_match("index.ts"));
    assert!(!glob.is_match("src/index.ts"));
}

#[test]
fn glob_double_star_slash_spans_zero_or_more_segments() {
    let glob = Glob::new("**/*.ts", false);
    assert!(glob.is_match("index.ts"));
    assert!(glob.is_match("src/index.ts"));
    assert!(glob.is_match("src/deep/nested.ts"));
    assert!(!glob.is_match("src/index.js"));
    let bare = Glob::new("src/**", false);
    assert!(bare.is_match("src/a/b.txt"));
    assert!(!bare.is_match("lib/a.txt"));
}

#[test]
fn glob_question_mark_is_one_character_and_literals_are_literal() {
    let glob = Glob::new("a?c.txt", false);
    assert!(glob.is_match("abc.txt"));
    assert!(!glob.is_match("ac.txt"));
    assert!(!glob.is_match("a/c.txt"));
    let literal = Glob::new("a+b(c).txt", false);
    assert!(literal.is_match("a+b(c).txt"));
    assert!(!literal.is_match("aab(c).txt"));
    assert!(Glob::new("[x]{1}$", true).is_match("[x]{1}$"));
}

#[test]
fn glob_honours_case_sensitivity() {
    assert!(Glob::new("*.TS", false).is_match("index.ts"));
    assert!(!Glob::new("*.TS", true).is_match("index.ts"));
}

/// JavaScript's non-Unicode regex: `?` is one UTF-16 unit, `**` stops at a line break, and case
/// folding never maps a non-ASCII character onto ASCII.
#[test]
fn glob_follows_javascript_regex_units_and_folding() {
    assert!(Glob::new("??.txt", true).is_match("\u{1f600}.txt"));
    assert!(!Glob::new("?.txt", true).is_match("\u{1f600}.txt"));
    assert!(!Glob::new("**", true).is_match("a\nb"));
    assert!(Glob::new("*", true).is_match("a\nb"));
    assert!(!Glob::new("k", false).is_match("\u{212a}"));
    assert!(Glob::new("\u{e9}", false).is_match("\u{c9}"));
}

#[test]
fn line_delta_counts_insertions_deletions_and_replacements() {
    let exact = |added, removed| LineDelta {
        added,
        removed,
        approximate: false,
    };
    assert_eq!(line_delta("a\nb\n", "a\nnew\nb\n"), exact(1, 0));
    assert_eq!(line_delta("a\nb\nc\n", "a\nc\n"), exact(0, 1));
    assert_eq!(line_delta("a\nb\nc\n", "a\nB\nc\n"), exact(1, 1));
    assert_eq!(line_delta("same\n", "same\n"), exact(0, 0));
    assert_eq!(line_delta("", "one\ntwo\n"), exact(2, 0));
    assert_eq!(line_delta("a\nb\nc\nd\ne", "a\nc\nb\nd\ne"), exact(1, 1));
}

#[test]
fn line_delta_is_exact_for_sparse_edits_in_large_files() {
    let before: Vec<String> = (0..4000).map(|i| format!("line {i}")).collect();
    let mut after = before.clone();
    after[10] = "changed ten".to_owned();
    after[3500] = "changed thirty-five hundred".to_owned();
    assert_eq!(
        line_delta(&before.join("\n"), &after.join("\n")),
        LineDelta {
            added: 2,
            removed: 2,
            approximate: false
        }
    );
    let before: Vec<String> = (0..3200).map(|i| format!("line {i}")).collect();
    let mut after = before.clone();
    after[5] = "changed five".to_owned();
    after[3000] = "changed three thousand".to_owned();
    assert_eq!(
        line_delta(
            &format!("{}\r\n", before.join("\r\n")),
            &format!("{}\n", after.join("\n"))
        ),
        LineDelta {
            added: 2,
            removed: 2,
            approximate: false
        }
    );
}

#[test]
fn line_delta_says_when_a_large_rewrite_is_approximate() {
    let before: Vec<String> = (0..4000).map(|i| format!("line {i}")).collect();
    let after: Vec<String> = (0..4000).map(|i| format!("changed {i}")).collect();
    let delta = line_delta(&before.join("\n"), &after.join("\n"));
    assert!(delta.approximate);
    assert_eq!(delta.added, 4000);
    assert_eq!(delta.removed, 4000);
}

#[test]
fn format_delta_matches_the_timeline() {
    assert_eq!(format_delta(18, 4).as_deref(), Some("+18 \u{2212}4"));
    assert_eq!(format_delta(214, 0).as_deref(), Some("+214"));
    assert_eq!(format_delta(0, 83).as_deref(), Some("\u{2212}83"));
    assert_eq!(format_delta(0, 0), None);
}

#[test]
fn stray_virtual_paths_are_found_only_at_token_boundaries() {
    let project = roots(&[("project", Path::new("C:\\work\\approved"))]);
    let cases = [
        (
            "Get-Content /project/sub/nested.txt",
            Some("/project/sub/nested.txt"),
        ),
        ("Get-Content '/project/file.txt'", Some("/project/file.txt")),
        ("/project/a.txt;echo", Some("/project/a.txt")),
        ("https://host/project/file.txt", None),
        ("de/project/file.txt", None),
        ("/not-approved/file.txt", None),
        ("/not-approved/x /project", Some("/project")),
    ];
    for (text, expected) in cases {
        assert_eq!(stray_virtual_path(text, &project), expected, "{text}");
    }
    assert_eq!(stray_virtual_path("cat /project/x", &roots(&[])), None);
}

#[test]
fn stray_virtual_paths_leave_approved_native_posix_spellings_alone() {
    let users = roots(&[("users", Path::new("/Users"))]);
    assert_eq!(stray_virtual_path("test -d /Users", &users), None);
    assert_eq!(stray_virtual_path("os.scandir('/Users')", &users), None);
    assert_eq!(
        stray_virtual_path("cat /Users/example/file.txt", &users),
        None
    );
    assert_eq!(
        stray_virtual_path("cat /users/example/file.txt", &users),
        Some("/users/example/file.txt")
    );
    assert_eq!(
        stray_virtual_path("cat /Users/file.txt /users/file.txt", &users),
        Some("/users/file.txt")
    );
    let cases = [
        ("/User", "/Users/file.txt", "users"),
        ("C:\\Users", "/Users/file.txt", "users"),
        ("/Users/project", "/project/file.txt", "project"),
    ];
    for (folder, path, name) in cases {
        assert_eq!(
            stray_virtual_path(&format!("cat {path}"), &roots(&[(name, Path::new(folder))])),
            Some(path)
        );
    }
}

#[test]
fn sniffs_binary_bytes_like_git() {
    assert!(!sniff_binary_bytes(b"plain text\n"));
    assert!(sniff_binary_bytes(&[0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]));
    assert!(!sniff_binary_bytes(&[0xff, 0xfe, 0x61, 0x00]));
    assert!(!sniff_binary_bytes(&[0xfe, 0xff, 0x00, 0x61]));
    assert!(sniff_binary_bytes(&[0x01; 4096]));
    assert!(!sniff_binary_bytes(b""));
}

#[test]
fn excludes_folders_by_name_or_trailing_star_prefix() {
    let patterns = ["node_modules", ".claude-acct*"];
    assert!(is_excluded_folder_name("Node_Modules", &patterns));
    assert!(is_excluded_folder_name(".claude-acct2", &patterns));
    assert!(!is_excluded_folder_name("node_modules2", &patterns));
    assert!(!is_excluded_folder_name("src", &patterns));
}

#[test]
fn clamps_out_of_range_and_non_finite_numbers() {
    assert_eq!(clamp(5.0, 1.0, 10.0), 5.0);
    assert_eq!(clamp(-3.0, 1.0, 10.0), 1.0);
    assert_eq!(clamp(99.0, 1.0, 10.0), 10.0);
    assert_eq!(clamp(7.9, 1.0, 10.0), 7.0);
    assert_eq!(clamp(f64::NAN, 1.0, 10.0), 1.0);
    assert_eq!(clamp(f64::INFINITY, 1.0, 10.0), 1.0);
}

/// `toFixed` rounds an exact half up: 1280 B is 1.25 KB, shown as 1.3 KB.
#[test]
fn formats_sizes_like_to_fixed() {
    assert_eq!(format_bytes(512), "512 B");
    assert_eq!(format_bytes(2048), "2.0 KB");
    assert_eq!(format_bytes(1280), "1.3 KB");
    assert_eq!(format_bytes(1_048_575), "1024.0 KB");
    assert_eq!(format_bytes(5 * 1024 * 1024), "5.0 MB");
    assert_eq!(format_bytes(609 * 1024), "609.0 KB");
    assert_eq!(format_bytes(3 * 1024 * 1024 * 1024 / 2), "1.50 GB");
}

const PIXEL_PNG: [u8; 68] = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c,
    0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64, 0xf8, 0x0f, 0x00,
    0x01, 0x05, 0x01, 0x01, 0x27, 0x18, 0xe3, 0x66, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
];

fn pixel_png() -> Vec<u8> {
    PIXEL_PNG.to_vec()
}

#[test]
fn recognizes_and_validates_supported_images() {
    let png = pixel_png();
    assert_eq!(image_mime(&png), Some(ImageMime::Png));
    assert_eq!(validate_image_structure(&png, ImageMime::Png), Ok(()));
    assert_eq!(
        image_mime(&[0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]),
        None
    );
    assert_eq!(image_mime(b"GIF89a....."), Some(ImageMime::Gif));
    assert_eq!(image_mime(b"RIFF\0\0\0\0WEBP"), Some(ImageMime::Webp));
    assert_eq!(image_mime(&[0xff, 0xd8, 0xff, 0xe0]), Some(ImageMime::Jpeg));
}

#[test]
fn refuses_corrupt_images_with_the_recorded_wording() {
    let mut corrupt = pixel_png();
    let index = corrupt.len() - 5;
    corrupt[index] ^= 0xff;
    assert_eq!(
        validate_image_structure(&corrupt, ImageMime::Png),
        Err(FsOpError(
            "Invalid or corrupt PNG image: CRC check failed for IEN; chunk".to_owned()
        ))
    );
    let mut idat = pixel_png();
    idat[45] ^= 0xff;
    assert_eq!(
        validate_image_structure(&idat, ImageMime::Png)
            .unwrap_err()
            .to_string(),
        "Invalid or corrupt PNG image: CRC check failed for IDAT chunk"
    );
    assert_eq!(
        validate_image_structure(&pixel_png()[..50], ImageMime::Png)
            .unwrap_err()
            .to_string(),
        "Invalid or corrupt PNG image: a chunk extends past the end of the file"
    );
    assert_eq!(
        validate_image_structure(&pixel_png()[..40], ImageMime::Png)
            .unwrap_err()
            .to_string(),
        "Invalid or corrupt PNG image: IEND chunk is missing"
    );
    assert_eq!(
        validate_image_structure(&[0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0], ImageMime::Jpeg)
            .unwrap_err()
            .to_string(),
        "Invalid or corrupt JPEG image: end marker is missing"
    );
    let mut gif = b"GIF89a\x01\x00\x01\x00\x00\x00\x00\x00".to_vec();
    assert_eq!(
        validate_image_structure(&gif, ImageMime::Gif)
            .unwrap_err()
            .to_string(),
        "Invalid or corrupt GIF image: trailer is missing"
    );
    gif.push(0x3b);
    assert_eq!(validate_image_structure(&gif, ImageMime::Gif), Ok(()));
    let webp = b"RIFF\x0c\x00\x00\x00WEBPVP8 \x00\x00\x00\x00".to_vec();
    assert_eq!(validate_image_structure(&webp, ImageMime::Webp), Ok(()));
    let mut wrong_size = webp.clone();
    wrong_size[4] = 0x10;
    assert_eq!(
        validate_image_structure(&wrong_size, ImageMime::Webp)
            .unwrap_err()
            .to_string(),
        "Invalid or corrupt WebP image: RIFF size does not match the file"
    );
}

#[test]
fn accepts_a_jpeg_with_a_frame_and_trailing_bytes() {
    let jpeg = [
        0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
        0xff, 0xda, 0x00, 0x02, 0xff, 0xd9, 0x0a,
    ];
    assert_eq!(validate_image_structure(&jpeg, ImageMime::Jpeg), Ok(()));
    let mut zero = jpeg;
    zero[7] = 0;
    zero[8] = 0;
    assert_eq!(
        validate_image_structure(&zero, ImageMime::Jpeg)
            .unwrap_err()
            .to_string(),
        "Invalid or corrupt JPEG image: image dimensions are zero"
    );
}
