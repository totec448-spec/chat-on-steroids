# Windows capture Rust unit

Scope: `cos-windows-capture`, called on the desktop thread of `cos-windows-desktop`, in-process. The caller still owns request authorization, frame identity, UI transaction, and helper lifecycle. Public API:

```rust
pub fn capture(
    request: &serde_json::Value,
    forced_window: Option<i64>,
) -> Result<Captured, cos_sidecar_runtime::DesktopError> // Captured { fields, png }
```

The Rust boundary preserves `region`, `image`, `screen`, `focused`, `captureMode`, and `windowGeometry`. It returns the PNG bytes in memory (`Captured::png`); the caller encodes base64. A requested region always samples the visible desktop. A requested HWND uses Windows.Graphics.Capture bound to the exact HWND, with no PrintWindow or visible-screen fallback. WGC frame `ContentSize` must equal unchanged DWM drawable bounds and fit the initial pool. The backend reads the locked actual GPU byte-access plane with its StartIndex and Stride, copies only the top-left validated rows, and rechecks window outer geometry, DWM geometry and exact popup ownership. Outer-window and compositor rectangles remain separate. Both use physical PMv2 DPI observations. GDI screen reads use SRCCOPY, the old CopyFromScreen semantics. Scaling uses native GDI+ HighQualityBicubic; only screen mode sets HighQuality pixel offset, matching the original C# implementation. A streaming-cap `Write` sink enforces the screenshot PNG byte limit during encoding.

Total virtual-desktop topology is kept as observed even when several monitors collectively exceed the per-capture 32M pixel limit; only the actually selected window, primary screen, full virtual screen or region must fit that limit.

## Existing TS/C# regression -> Rust proof

| Existing case / boundary | Rust case or owner |
| --- | --- |
| `windows-capture.test.ts`: frame pool vs ContentSize, bad pool/content bounds, padding and incomplete buffer | `rejects_invalid_content_and_stride_without_leaking_surface_capacity` (includes extra stride padding) |
| `windows-capture.test.ts`: missing window, 32M pixel bound | Native `outer` (`WINDOW_NOT_FOUND`), `drawable` (`CAPTURE_FAILED`), `Rect::new` and `validate_content`; native missing-window check remains for live fixture |
| `computer.test.ts`: actual foreground unchanged by screenshot | Capture has no activation calls; real fixture confirmation requires exclusive live desktop lane |
| `computer.test.ts`: independent top-left/bottom-right UIA marker pixels | `window_background_capture_preserves_outer_and_drawable_geometry` verifies PNG corners against distinct DWM/outer geometry; real UIA/window fixture remains coordinator's integrated lane |
| `computer.test.ts`: crops are visible screen pixels and frame owner cannot be reused | `validates_owner_and_request_and_never_labels_region_as_window`; caller retains frame-generation checking |
| `computer-windows-input.test.ts`: screenshot error must not remove accessible UI | Capture emits named `DesktopError`; desktop exe worker owns dual-channel partial result policy |
| `helper.ts::Capture-Target`: popup ownership / geometry stale after capture | `geometry_or_popup_owner_changing_during_capture_fails_without_writing_pixels` |
| `index.ts::screenshotFromReply`: bounded PNG before base64 | `png_output_enforces_compressed_byte_limit_during_write`, bounded request dimensions |
| Multiple 4K monitors larger than one capture limit | `virtual_display_metadata_may_exceed_one_capture_pixel_budget`: metadata allowed, selected screenshot bounded |
| Old C# `HighQualityBicubic` plus screen `HighQuality` PixelOffsetMode | `gdiplus_bicubic_decoded_pixel_differential`: synthesize 13x9 color PNG, invoke old System.Drawing GDI+ and compare all decoded 7x5 RGBA pixels in BOTH modes. CatmullRom failed this test before native GDI+ implementation. |
| `verify-windows-capture-border.mjs`: border flash suppression | WGC `SetIsBorderRequired(false)` before `StartCapture`; optical proof requires exclusive live Windows fixture lane |
| Owned live WGC capture under occlusion | `tests/native_wgc.rs` opt-in `--ignored` integration probe launches only `tests/wgc_fixture.ps1`'s purple target and cyan occluder; asserts target pixels vs screen pixels, foreground unchanged, unrelated popup owner denied, minimized and closed HWND refusals. The fixture waits for actual owned first paint and occlusion, and the test has bounded fixture response and retirement. Execute only during coordinator-granted exclusive desktop lane. |

## Native dependency provenance

- `windows =0.62.2`: MIT OR Apache-2.0; official Win32 and WinRT bindings for DWM, WGC, GDI/GDI+.
- `image =0.25.10`: MIT OR Apache-2.0; PNG-only features; no image codecs with forbidden licenses.
- `serde_json =1.0.154`: MIT OR Apache-2.0.
- `cos-sidecar-runtime`: repository-owned MIT.
- `xcap =0.9.8` is intentionally not included after inspecting its checked crate source (`.tmp/external-source/xcap-0.9.8`, checksum-verified version). `src/windows/gdi.rs::capture_monitor` uses `BitBlt(..., SRCCOPY)`, matching the legacy `Clf::Capture` and our current GDI screen-copy operation. However its public `Monitor::capture_region` calls `src/windows/capture.rs::capture_monitor`, which requires monitor-relative unsigned x/y and rejects any region crossing one monitor's boundaries. The existing `Capture-Target` accepts arbitrary absolute virtual-desktop regions, including multi-monitor spans and negative desktop origins, in addition to primary and full virtual screen. Reusing the per-monitor xcap API would require reassembling partial monitor images and risks differences at seams and nonrectangular monitor edges. Keeping the direct SRCCOPY path preserves one underlying BitBlt of the exact desktop rectangle without adding transitive dependencies. Its default window capture is GDI, while WGC feature mode still does not provide our strict DWM `ContentSize`/stride/window-geometry checks; window mode stays exact HWND WGC.
- This crate includes `LICENSE`, copied byte-for-byte from the repository's root MIT license, so `cargo-about` may inventory actual license text for this package rather than relying only on SPDX metadata.

Unit run on Windows MSVC Rust 1.99.0: `cargo check -p cos-windows-capture --all-targets`, `cargo clippy -p cos-windows-capture --all-targets -- -D warnings`, `cargo test -p cos-windows-capture`, `cargo fmt -p cos-windows-capture`: all passed (seven unit tests and zero doc tests). Live WGC HWND/cover/border lane and full end-to-end MCP differential are coordinated with the prime and belong to integration.

The native probe compiles under `cargo test -p cos-windows-capture --test native_wgc --no-run`, and its fixture C# `Add-Type` compile check completed without launching windows. Its default ignored status is deliberate; actual runtime WGC proof is pending the exclusive lane. With foundation's explicitly selected license policy `rust-foundation/rust/deny.toml`, `cargo deny check licenses bans sources` passed after adding the exact `=0.1.0` version to the local runtime path dependency (warnings for duplicate upstream transitive versions are nonfatal).
