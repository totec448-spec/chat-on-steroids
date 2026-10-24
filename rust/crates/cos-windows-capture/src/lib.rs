//! Windows desktop screenshot service for the in-process desktop tools.
//!
//! A window image comes exclusively from WGC bound to the requested HWND; a
//! region or desktop image comes from the visible display. These are different
//! authorities: visible pixels must never be returned as a named-window frame.

mod native;

use cos_sidecar_runtime::DesktopError;
use image::{ColorType, ImageEncoder, RgbaImage, codecs::png::PngEncoder};
use serde_json::{Value, json};
use std::io::{self, Write};

const MAX_PIXELS: u64 = 32_000_000;
const MAX_PNG_BYTES: usize = ((8 * 1024 * 1024 - 64 * 1024) * 3) / 4;

/// The encoder writes through this limit, so a high-entropy capture cannot
/// accumulate an arbitrarily large compressed PNG before we reject it.
struct BoundedPng {
    bytes: Vec<u8>,
    exceeded: bool,
}

impl BoundedPng {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            exceeded: false,
        }
    }
}

impl Write for BoundedPng {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self
            .bytes
            .len()
            .checked_add(buf.len())
            .is_none_or(|n| n > MAX_PNG_BYTES)
        {
            self.exceeded = true;
            return Err(io::Error::other("encoded screenshot exceeds byte limit"));
        }
        self.bytes.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn error(code: &'static str, message: impl Into<String>) -> DesktopError {
    DesktopError::new(code, message)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl Rect {
    fn geometry(x: i32, y: i32, width: u32, height: u32) -> Result<Self, DesktopError> {
        if width == 0
            || height == 0
            || i64::from(x) + i64::from(width) > i64::from(i32::MAX)
            || i64::from(y) + i64::from(height) > i64::from(i32::MAX)
        {
            return Err(error(
                "CAPTURE_FAILED",
                "capture rectangle exceeds pixel or coordinate bounds",
            ));
        }
        Ok(Self {
            x,
            y,
            width,
            height,
        })
    }

    fn new(x: i32, y: i32, width: u32, height: u32) -> Result<Self, DesktopError> {
        let rect = Self::geometry(x, y, width, height)?;
        rect.bounded()?;
        Ok(rect)
    }

    fn bounded(self) -> Result<(), DesktopError> {
        if u64::from(self.width) * u64::from(self.height) > MAX_PIXELS {
            return Err(error(
                "CAPTURE_FAILED",
                "capture dimensions exceed the pixel limit",
            ));
        }
        Ok(())
    }

    fn json(self) -> Value {
        json!({"x":self.x, "y":self.y, "width":self.width, "height":self.height})
    }
}

#[derive(Debug)]
struct Surface {
    pool_width: u32,
    pool_height: u32,
    content_width: u32,
    content_height: u32,
    row_stride: usize,
    bytes: Vec<u8>,
}

fn validate_content(
    pool_width: u32,
    pool_height: u32,
    content_width: u32,
    content_height: u32,
    expected: Rect,
) -> Result<(), DesktopError> {
    let pool_pixels = u64::from(pool_width) * u64::from(pool_height);
    if pool_width == 0 || pool_height == 0 || pool_pixels > MAX_PIXELS {
        return Err(error(
            "CAPTURE_FAILED",
            "capture dimensions exceed the pixel limit",
        ));
    }
    if content_width != expected.width
        || content_height != expected.height
        || content_width > pool_width
        || content_height > pool_height
    {
        return Err(error(
            "STALE_FRAME",
            "frame content and DWM bounds disagree",
        ));
    }
    Ok(())
}

/// Copies valid top-left WGC content, skipping the allocation's right/bottom
/// padding. The row pitch is the actual surface stride, never the content width.
fn copy_content(surface: Surface, expected: Rect) -> Result<Vec<u8>, DesktopError> {
    validate_content(
        surface.pool_width,
        surface.pool_height,
        surface.content_width,
        surface.content_height,
        expected,
    )?;
    let pool_row_bytes = usize::try_from(surface.pool_width)
        .ok()
        .and_then(|width| width.checked_mul(4))
        .ok_or_else(|| error("STALE_FRAME", "surface row size overflow"))?;
    let row_bytes = usize::try_from(expected.width)
        .ok()
        .and_then(|width| width.checked_mul(4))
        .ok_or_else(|| error("STALE_FRAME", "content row size overflow"))?;
    let rows = usize::try_from(surface.pool_height)
        .map_err(|_| error("STALE_FRAME", "surface height overflow"))?;
    if surface.row_stride < pool_row_bytes
        || rows.checked_mul(surface.row_stride) != Some(surface.bytes.len())
    {
        return Err(error(
            "STALE_FRAME",
            "copied surface byte count or stride changed",
        ));
    }
    let length = usize::try_from(expected.height)
        .ok()
        .and_then(|height| height.checked_mul(row_bytes))
        .ok_or_else(|| error("STALE_FRAME", "content size overflow"))?;
    let mut content = vec![0; length];
    for row in 0..expected.height as usize {
        let from = row * surface.row_stride;
        let to = row * row_bytes;
        content[to..to + row_bytes].copy_from_slice(&surface.bytes[from..from + row_bytes]);
    }
    // Windows surfaces are BGRA; PNG encoder expects RGBA.
    for pixel in content.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
        pixel[3] = 255; // WGC capture uses BitmapAlphaMode.Ignore.
    }
    Ok(content)
}

trait CaptureBackend {
    fn screen(&self) -> Result<(Rect, Rect), DesktopError>;
    fn outer_window(&self, hwnd: i64) -> Result<Rect, DesktopError>;
    fn drawable_window(&self, hwnd: i64) -> Result<Rect, DesktopError>;
    fn is_focused(&self, hwnd: i64) -> bool;
    fn is_related(&self, hwnd: i64, owner: i64) -> bool;
    fn capture_window(&self, hwnd: i64, drawable: Rect) -> Result<Surface, DesktopError>;
    fn capture_screen(&self, rect: Rect) -> Result<Surface, DesktopError>;
}

fn integer(value: &Value, name: &str) -> Result<i64, DesktopError> {
    value
        .as_i64()
        .ok_or_else(|| error("BAD_REQUEST", format!("{name} must be an integer")))
}

fn coordinate(value: &Value, name: &str) -> Result<i32, DesktopError> {
    i32::try_from(integer(value, name)?)
        .map_err(|_| error("BAD_REQUEST", format!("{name} is out of range")))
}

fn dimensions(value: &Value, name: &str) -> Result<u32, DesktopError> {
    u32::try_from(integer(value, name)?)
        .map_err(|_| {
            error(
                "BAD_REQUEST",
                format!("{name} must be a positive bounded integer"),
            )
        })
        .and_then(|value| {
            if value == 0 {
                Err(error("BAD_REQUEST", format!("{name} must be positive")))
            } else {
                Ok(value)
            }
        })
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a Value, DesktopError> {
    value
        .get(name)
        .ok_or_else(|| error("BAD_REQUEST", format!("missing {name}")))
}

fn requested_region(value: &Value) -> Result<Rect, DesktopError> {
    if !value.is_object() {
        return Err(error("BAD_REQUEST", "region must be an object"));
    }
    Rect::new(
        coordinate(field(value, "x")?, "region.x")?,
        coordinate(field(value, "y")?, "region.y")?,
        dimensions(field(value, "width")?, "region.width")?,
        dimensions(field(value, "height")?, "region.height")?,
    )
}

fn optional_handle(value: Option<&Value>, name: &str) -> Result<Option<i64>, DesktopError> {
    value
        .map(|value| {
            let handle = integer(value, name)?;
            if handle <= 0 {
                return Err(error(
                    "BAD_REQUEST",
                    format!("{name} must be a positive window id"),
                ));
            }
            Ok(handle)
        })
        .transpose()
}

fn capture_with(
    request: &Value,
    forced_window: Option<i64>,
    backend: &impl CaptureBackend,
) -> Result<Captured, DesktopError> {
    if !request.is_object() {
        return Err(error("BAD_REQUEST", "capture request must be an object"));
    }
    let max_width = match request.get("maxWidth") {
        None | Some(Value::Null) => 0,
        Some(v) => {
            let width = integer(v, "maxWidth")?;
            if !(0..=2560).contains(&width) {
                return Err(error("BAD_REQUEST", "maxWidth is out of range"));
            }
            width as u32
        }
    };
    let full = match request.get("full") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        _ => return Err(error("BAD_REQUEST", "full must be a boolean")),
    };
    let requested_window = if forced_window.is_some() {
        None
    } else {
        optional_handle(request.get("id"), "id")?
    };
    let handle = forced_window.or(requested_window);
    if forced_window.is_some_and(|handle| handle <= 0) {
        return Err(error("BAD_REQUEST", "forced window id must be positive"));
    }
    let owner = optional_handle(request.get("ownerWindow"), "ownerWindow")?;
    let region = request
        .get("region")
        .filter(|r| !r.is_null())
        .map(requested_region)
        .transpose()?;
    let (virtual_screen, primary_screen) = backend.screen()?;
    let mut outer = None;
    let mut focused = None;
    let (image_region, surface, mode) = if let Some(crop) = region {
        // Source frame crops are display pixels, even if an id is also present.
        let surface = backend.capture_screen(crop)?;
        (crop, surface, "screen")
    } else if let Some(hwnd) = handle {
        let initial_outer = backend.outer_window(hwnd)?;
        outer = Some(initial_outer);
        focused = Some(backend.is_focused(hwnd));
        if let Some(owner) = owner
            && !backend.is_related(hwnd, owner)
        {
            return Err(error(
                "RELATED_WINDOW_GONE",
                "popup no longer belongs to the observed window",
            ));
        }
        let drawable = backend.drawable_window(hwnd)?;
        let surface = backend.capture_window(hwnd, drawable)?;
        // A capture is stale if either the compositor or outer-window geometry
        // changed. Recheck popup owner after capture, never infer it by process.
        if backend.outer_window(hwnd)? != initial_outer
            || backend.drawable_window(hwnd)? != drawable
        {
            return Err(error(
                "STALE_FRAME",
                "window geometry changed during capture",
            ));
        }
        if let Some(owner) = owner
            && !backend.is_related(hwnd, owner)
        {
            return Err(error(
                "RELATED_WINDOW_GONE",
                "popup ownership changed during capture",
            ));
        }
        (drawable, surface, "window")
    } else {
        let capture = if full { virtual_screen } else { primary_screen };
        capture.bounded()?;
        (capture, backend.capture_screen(capture)?, "screen")
    };
    let pixels = copy_content(surface, image_region)?;
    let bitmap = RgbaImage::from_raw(image_region.width, image_region.height, pixels)
        .ok_or_else(|| error("STALE_FRAME", "invalid content pixel dimensions"))?;
    let width = if max_width > 0 {
        max_width.min(image_region.width)
    } else {
        image_region.width
    };
    let height = if width == image_region.width {
        image_region.height
    } else {
        ((f64::from(image_region.height) * f64::from(width) / f64::from(image_region.width)).round()
            as u32)
            .max(1)
    };
    let output = if width == image_region.width {
        bitmap
    } else {
        native::scale_image(&bitmap, width, height, mode == "screen")?
    };
    let mut encoded = BoundedPng::new();
    let result = PngEncoder::new(&mut encoded).write_image(
        output.as_raw(),
        width,
        height,
        ColorType::Rgba8.into(),
    );
    if encoded.exceeded {
        return Err(error(
            "SCREENSHOT_TOO_LARGE",
            "encoded PNG exceeds the screenshot byte limit",
        ));
    }
    result.map_err(|_| error("CAPTURE_FAILED", "PNG encoding failed"))?;
    if encoded.bytes.is_empty() {
        return Err(error(
            "CAPTURE_FAILED",
            "PNG encoder produced an empty image",
        ));
    }
    if let Some(hwnd) = handle.filter(|_| mode == "window") {
        let initial_outer =
            outer.ok_or_else(|| error("STALE_FRAME", "window metadata was lost during capture"))?;
        if backend.outer_window(hwnd)? != initial_outer
            || backend.drawable_window(hwnd)? != image_region
        {
            return Err(error(
                "STALE_FRAME",
                "window geometry changed during PNG encoding",
            ));
        }
        if let Some(owner) = owner
            && !backend.is_related(hwnd, owner)
        {
            return Err(error(
                "RELATED_WINDOW_GONE",
                "popup ownership changed during PNG encoding",
            ));
        }
    }
    Ok(Captured {
        fields: json!({
            "region": image_region.json(),
            "image": {"width": width, "height": height},
            "screen": virtual_screen.json(),
            "focused": focused,
            "captureMode": mode,
            "windowGeometry": outer.map(Rect::json),
        }),
        png: encoded.bytes,
    })
}

/// One encoded screenshot and the geometry it was taken against.
#[derive(Debug)]
pub struct Captured {
    /// `region`, `image`, `screen`, `focused`, `captureMode` and `windowGeometry`.
    pub fields: Value,
    /// The PNG, already within the screenshot byte limit.
    pub png: Vec<u8>,
}

/// Captures the exact requested HWND, or the visible desktop when no window is
/// selected.
pub fn capture(request: &Value, forced_window: Option<i64>) -> Result<Captured, DesktopError> {
    capture_with(request, forced_window, &native::WindowsCapture)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct Fake {
        outer: Cell<Rect>,
        drawable: Rect,
        owner_valid: Cell<bool>,
        surface: Cell<bool>,
        shift_after_capture: Cell<bool>,
        revoke_owner_after_capture: Cell<bool>,
    }
    impl Fake {
        fn new() -> Self {
            Self {
                outer: Cell::new(Rect::new(100, 200, 5, 4).unwrap()),
                drawable: Rect::new(110, 210, 2, 2).unwrap(),
                owner_valid: Cell::new(true),
                surface: Cell::new(true),
                shift_after_capture: Cell::new(false),
                revoke_owner_after_capture: Cell::new(false),
            }
        }
        fn pixels(&self, content: Rect) -> Surface {
            let mut bytes = vec![213; 4 * 3 * 4];
            for y in 0..2_usize {
                for x in 0..2_usize {
                    let i = (y * 4 + x) * 4;
                    bytes[i..i + 4].copy_from_slice(&[
                        30 + x as u8,
                        20 + y as u8,
                        10 + x as u8 + y as u8,
                        255,
                    ]);
                }
            }
            Surface {
                pool_width: 4,
                pool_height: 3,
                content_width: content.width,
                content_height: content.height,
                row_stride: 16,
                bytes,
            }
        }
    }
    impl CaptureBackend for Fake {
        fn screen(&self) -> Result<(Rect, Rect), DesktopError> {
            Ok((Rect::new(-100, 0, 800, 600)?, Rect::new(0, 0, 640, 480)?))
        }
        fn outer_window(&self, _: i64) -> Result<Rect, DesktopError> {
            Ok(self.outer.get())
        }
        fn drawable_window(&self, _: i64) -> Result<Rect, DesktopError> {
            Ok(self.drawable)
        }
        fn is_focused(&self, _: i64) -> bool {
            false
        }
        fn is_related(&self, _: i64, _: i64) -> bool {
            self.owner_valid.get()
        }
        fn capture_window(&self, _: i64, content: Rect) -> Result<Surface, DesktopError> {
            if self.surface.get() {
                if self.shift_after_capture.get() {
                    self.outer.set(Rect::new(101, 200, 5, 4)?);
                }
                if self.revoke_owner_after_capture.get() {
                    self.owner_valid.set(false);
                }
                Ok(self.pixels(content))
            } else {
                Err(error("CAPTURE_FAILED", "refused"))
            }
        }
        fn capture_screen(&self, rect: Rect) -> Result<Surface, DesktopError> {
            Ok(Surface {
                pool_width: rect.width,
                pool_height: rect.height,
                content_width: rect.width,
                content_height: rect.height,
                row_stride: rect.width as usize * 4,
                bytes: vec![42; rect.width as usize * rect.height as usize * 4],
            })
        }
    }

    #[test]
    fn rejects_invalid_content_and_stride_without_leaking_surface_capacity() {
        let fake = Fake::new();
        let expected = fake.drawable;
        let png = copy_content(fake.pixels(expected), expected).unwrap();
        assert_eq!(png.len(), 16);
        assert_eq!(&png[0..4], &[10, 20, 30, 255]);
        assert_eq!(&png[4..8], &[11, 20, 31, 255]);
        assert_eq!(&png[8..12], &[11, 21, 30, 255]);
        assert_eq!(&png[12..16], &[12, 21, 31, 255]);
        for (pool, content, expected_code) in [
            ((0, 3), (2, 2), "CAPTURE_FAILED"),
            ((40_000, 40_000), (2, 2), "CAPTURE_FAILED"),
            ((1, 3), (2, 2), "STALE_FRAME"),
            ((4, 3), (1, 2), "STALE_FRAME"),
            ((4, 3), (3, 2), "STALE_FRAME"),
            ((4, 3), (2, 1), "STALE_FRAME"),
        ] {
            let err = validate_content(pool.0, pool.1, content.0, content.1, expected).unwrap_err();
            assert_eq!(err.code, expected_code);
        }
        let mut invalid = fake.pixels(expected);
        invalid.row_stride = 8;
        assert_eq!(
            copy_content(invalid, expected).unwrap_err().code,
            "STALE_FRAME"
        );
        let mut incomplete = fake.pixels(expected);
        incomplete.bytes.pop();
        assert_eq!(
            copy_content(incomplete, expected).unwrap_err().code,
            "STALE_FRAME"
        );
        let mut padded = fake.pixels(expected);
        let mut rows = vec![213; 60];
        for y in 0..3 {
            rows[y * 20..y * 20 + 16].copy_from_slice(&padded.bytes[y * 16..(y + 1) * 16]);
        }
        padded.row_stride = 20;
        padded.bytes = rows;
        assert_eq!(copy_content(padded, expected).unwrap(), png);
    }

    #[test]
    fn virtual_display_metadata_may_exceed_one_capture_pixel_budget() {
        // Four 4K monitors can exceed 32M in total while capturing a small
        // window or primary monitor. Only the selected target is bounded.
        let virtual_display = Rect::geometry(-3840, 0, 7680, 4320).unwrap();
        assert_eq!(virtual_display.width, 7680);
        assert_eq!(
            virtual_display.bounded().unwrap_err().code,
            "CAPTURE_FAILED"
        );
        assert!(Rect::new(0, 0, 1920, 1080).unwrap().bounded().is_ok());
    }

    #[test]
    fn window_background_capture_preserves_outer_and_drawable_geometry() {
        let fake = Fake::new();
        let captured = capture_with(
            &json!({"id":42,"ownerWindow":43,"maxWidth":320}),
            None,
            &fake,
        )
        .unwrap();
        let result = &captured.fields;
        assert_eq!(result["captureMode"], "window");
        assert_eq!(result["focused"], false);
        assert_eq!(
            result["region"],
            json!({"x":110,"y":210,"width":2,"height":2})
        );
        assert_eq!(
            result["windowGeometry"],
            json!({"x":100,"y":200,"width":5,"height":4})
        );
        assert_eq!(result["image"], json!({"width":2,"height":2}));
        let bitmap = image::load_from_memory(&captured.png).unwrap().into_rgba8();
        assert_eq!(bitmap.get_pixel(0, 0).0, [10, 20, 30, 255]);
        assert_eq!(bitmap.get_pixel(1, 1).0, [12, 21, 31, 255]);
    }

    #[test]
    fn validates_owner_and_request_and_never_labels_region_as_window() {
        let fake = Fake::new();
        fake.owner_valid.set(false);
        let missing = capture_with(&json!({"id":42,"ownerWindow":43}), None, &fake).unwrap_err();
        assert_eq!(missing.code, "RELATED_WINDOW_GONE");
        let invalid = capture_with(&json!({"id":"42"}), None, &fake).unwrap_err();
        assert_eq!(invalid.code, "BAD_REQUEST");
        let invalid = capture_with(
            &json!({"region":{"x":0,"y":0,"width":32000,"height":32000}}),
            None,
            &fake,
        )
        .unwrap_err();
        assert_eq!(invalid.code, "CAPTURE_FAILED");
        let invalid = capture_with(&json!({"maxWidth":2561}), None, &fake).unwrap_err();
        assert_eq!(invalid.code, "BAD_REQUEST");
        let result = capture_with(
            &json!({"id":42,"region":{"x":-1,"y":-2,"width":2,"height":2}}),
            None,
            &fake,
        )
        .unwrap()
        .fields;
        assert_eq!(result["captureMode"], "screen");
        assert_eq!(result["windowGeometry"], Value::Null);
    }

    #[test]
    fn geometry_or_popup_owner_changing_during_capture_returns_no_pixels() {
        let fake = Fake::new();
        fake.shift_after_capture.set(true);
        let request = json!({"id":42, "ownerWindow":43});
        assert_eq!(
            capture_with(&request, None, &fake).unwrap_err().code,
            "STALE_FRAME"
        );
        let fake = Fake::new();
        fake.revoke_owner_after_capture.set(true);
        assert_eq!(
            capture_with(&request, None, &fake).unwrap_err().code,
            "RELATED_WINDOW_GONE"
        );
    }

    #[test]
    fn png_output_enforces_compressed_byte_limit_during_write() {
        let mut encoded = BoundedPng::new();
        let almost_full = vec![99; MAX_PNG_BYTES - 3];
        encoded.write_all(&almost_full).unwrap();
        assert_eq!(encoded.bytes.len(), MAX_PNG_BYTES - 3);
        assert!(encoded.write_all(&[1, 2, 3, 4]).is_err());
        assert!(encoded.exceeded);
        assert_eq!(encoded.bytes.len(), MAX_PNG_BYTES - 3);
    }

    /// This characterization runs the old GDI+ resampler on a synthetic fixture.
    /// It never reads a real desktop surface or personal window.
    #[test]
    fn gdiplus_bicubic_decoded_pixel_differential() {
        use std::process::Command;
        let directory = std::env::temp_dir().join(format!(
            "cos-capture-gdiplus-fixture-{}",
            std::process::id(),
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let original = directory.join("input.png");
        let scaled = directory.join("reference.png");
        let mut fixture = RgbaImage::new(13, 9);
        for (x, y, pixel) in fixture.enumerate_pixels_mut() {
            *pixel = image::Rgba([
                ((x * 21 + y * 17) % 256) as u8,
                ((x * 3 + y * 31) % 256) as u8,
                ((x * 19 + y * 7) % 256) as u8,
                255,
            ]);
        }
        fixture.save(&original).unwrap();
        let reference_script =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/gdiplus_reference.ps1");
        for screen_mode in [false, true] {
            let mut command = Command::new("powershell.exe");
            command
                .args(["-NoProfile", "-NonInteractive", "-File"])
                .arg(&reference_script)
                .arg(&original)
                .arg(&scaled)
                .args(["7", "5"]);
            if screen_mode {
                command.arg("-ScreenMode");
            }
            let status = command.status().unwrap();
            assert!(status.success());
            let old = image::open(&scaled).unwrap().into_rgba8();
            let current = native::scale_image(&fixture, 7, 5, screen_mode).unwrap();
            let differing: Vec<_> = old
                .pixels()
                .zip(current.pixels())
                .enumerate()
                .filter_map(|(index, (a, b))| {
                    if a != b {
                        Some((index, a.0, b.0))
                    } else {
                        None
                    }
                })
                .collect();
            assert!(
                differing.is_empty(),
                "GDI+ screen_mode={screen_mode} pixel differences: {:?}",
                differing
            );
        }
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
