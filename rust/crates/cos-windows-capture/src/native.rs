//! Win32 screen readback and WGC exact-HWND compositor readback.

use super::{CaptureBackend, MAX_PIXELS, Rect, Surface, error};
use cos_sidecar_runtime::DesktopError;
use image::RgbaImage;
use std::{
    ffi::c_void,
    mem::size_of,
    thread,
    time::{Duration, Instant},
};
use windows::{
    Graphics::{
        Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession},
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
        Imaging::{BitmapAlphaMode, BitmapBufferAccessMode, SoftwareBitmap},
    },
    Win32::{
        Foundation::{HMODULE, HWND, RECT},
        Graphics::{
            Direct3D::D3D_DRIVER_TYPE_HARDWARE,
            Direct3D11::{
                D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION, D3D11CreateDevice,
                ID3D11Device, ID3D11DeviceContext,
            },
            Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute},
            Dxgi::IDXGIDevice,
            Gdi::{
                BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CreateCompatibleDC, CreateDIBSection,
                DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, HBITMAP, HDC, HGDIOBJ, ReleaseDC,
                SRCCOPY, SelectObject,
            },
            GdiPlus::{
                BitmapData, GdipBitmapLockBits, GdipBitmapUnlockBits, GdipCreateBitmapFromScan0,
                GdipDeleteGraphics, GdipDisposeImage, GdipDrawImageRectI,
                GdipGetImageGraphicsContext, GdipSetInterpolationMode, GdipSetPixelOffsetMode,
                GdiplusShutdown, GdiplusStartup, GdiplusStartupInput, GpBitmap, GpGraphics,
                GpImage, ImageLockModeRead, InterpolationModeHighQualityBicubic,
                PixelOffsetModeHighQuality, Status,
            },
        },
        System::WinRT::{
            Direct3D11::CreateDirect3D11DeviceFromDXGIDevice,
            Graphics::Capture::IGraphicsCaptureItemInterop, IMemoryBufferByteAccess,
            RO_INIT_MULTITHREADED, RO_INIT_SINGLETHREADED, RoInitialize, RoUninitialize,
        },
        UI::{
            HiDpi::{
                DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
                SetThreadDpiAwarenessContext,
            },
            WindowsAndMessaging::{
                GA_ROOT, GUITHREADINFO, GW_OWNER, GetAncestor, GetClassNameW, GetForegroundWindow,
                GetGUIThreadInfo, GetSystemMetrics, GetWindow, GetWindowRect,
                GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, SM_CXSCREEN,
                SM_CXVIRTUALSCREEN, SM_CYSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
                SM_YVIRTUALSCREEN,
            },
        },
    },
    core::{Interface, factory},
};

pub(super) struct WindowsCapture;

fn failure(message: &'static str) -> DesktopError {
    error("CAPTURE_FAILED", message)
}

fn winrt<T>(result: windows::core::Result<T>, context: &'static str) -> Result<T, DesktopError> {
    result.map_err(|_| failure(context))
}

fn hwnd(handle: i64) -> HWND {
    HWND(handle as isize as *mut c_void)
}

struct DpiGuard(DPI_AWARENESS_CONTEXT);

impl DpiGuard {
    fn physical() -> Result<Self, DesktopError> {
        // SAFETY: modifies only the calling thread; saved context is restored by Drop.
        let old =
            unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        if old.0.is_null() {
            return Err(error(
                "DPI_AWARENESS_FAILED",
                "cannot establish per-monitor physical coordinates",
            ));
        }
        Ok(Self(old))
    }
}

impl Drop for DpiGuard {
    fn drop(&mut self) {
        // SAFETY: the value came from this thread's successful SetThreadDpiAwarenessContext.
        unsafe { SetThreadDpiAwarenessContext(self.0) };
    }
}

fn rectangle(bounds: RECT) -> Result<Rect, DesktopError> {
    let width = i64::from(bounds.right) - i64::from(bounds.left);
    let height = i64::from(bounds.bottom) - i64::from(bounds.top);
    Rect::geometry(
        bounds.left,
        bounds.top,
        u32::try_from(width).map_err(|_| failure("window has no drawable area"))?,
        u32::try_from(height).map_err(|_| failure("window has no drawable area"))?,
    )
}

fn outer(handle: i64) -> Result<Rect, DesktopError> {
    let window = hwnd(handle);
    // SAFETY: IsWindow and GetWindowRect accept arbitrary handles, and write to a live RECT.
    if unsafe { !IsWindow(Some(window)).as_bool() } {
        return Err(error(
            "WINDOW_NOT_FOUND",
            format!(
                "window {handle} is no longer open, so there is nothing to capture. Call list_windows for the current windows."
            ),
        ));
    }
    let mut rect = RECT::default();
    winrt(
        unsafe { GetWindowRect(window, &mut rect) },
        "window rectangle unavailable",
    )?;
    rectangle(rect)
}

fn drawable(handle: i64) -> Result<Rect, DesktopError> {
    let window = hwnd(handle);
    // SAFETY: Win32 tests arbitrary HWND values; DWM fills the initialized output RECT.
    if unsafe { !IsWindow(Some(window)).as_bool() || IsIconic(window).as_bool() } {
        return Err(failure("target window is closed or minimized"));
    }
    let mut rect = RECT::default();
    winrt(
        unsafe {
            DwmGetWindowAttribute(
                window,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                (&raw mut rect).cast::<c_void>(),
                size_of::<RECT>() as u32,
            )
        },
        "DWM drawable bounds unavailable",
    )?;
    let drawable = rectangle(rect)?;
    drawable.bounded()?;
    Ok(drawable)
}

fn owned_by(mut candidate: HWND, target: HWND) -> bool {
    // SAFETY: these Win32 queries do not dereference the HWND; an invalid handle returns null.
    unsafe {
        let root = GetAncestor(candidate, GA_ROOT);
        if !root.0.is_null() {
            candidate = root;
        }
        for _ in 0..16 {
            if candidate.0.is_null() {
                return false;
            }
            if candidate == target {
                return true;
            }
            candidate = match GetWindow(candidate, GW_OWNER) {
                Ok(next) => next,
                Err(_) => return false,
            };
        }
    }
    false
}

fn related(candidate: i64, owner: i64) -> bool {
    let window = hwnd(candidate);
    let target = hwnd(owner);
    // SAFETY: Win32 validates the HWNDs. We compare exact root/owner ancestry or
    // native menu thread ownership, never infer ownership from a shared PID alone.
    unsafe {
        if window == target
            || !IsWindow(Some(target)).as_bool()
            || !IsWindowVisible(window).as_bool()
            || IsIconic(window).as_bool()
        {
            return false;
        }
        if owned_by(window, target) {
            return true;
        }
        let mut class = [0u16; 256];
        let count = GetClassNameW(window, &mut class);
        if count <= 0 || class[..count as usize] != "#32768".encode_utf16().collect::<Vec<_>>() {
            return false;
        }
        let mut owner_pid = 0u32;
        let mut window_pid = 0u32;
        let owner_tid = GetWindowThreadProcessId(target, Some(&mut owner_pid));
        let window_tid = GetWindowThreadProcessId(window, Some(&mut window_pid));
        if owner_tid == 0 || owner_tid != window_tid || owner_pid != window_pid {
            return false;
        }
        let mut gui = GUITHREADINFO {
            cbSize: size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        GetGUIThreadInfo(owner_tid, &mut gui).is_ok()
            && !gui.hwndMenuOwner.0.is_null()
            && owned_by(gui.hwndMenuOwner, target)
    }
}

struct GdiGuard {
    screen: HDC,
    memory: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
}

impl Drop for GdiGuard {
    fn drop(&mut self) {
        // SAFETY: restores the original bitmap before deleting the owned DIB/DCs;
        // ReleaseDC matches the desktop GetDC performed in visible_capture.
        unsafe {
            if !self.previous.0.is_null() {
                SelectObject(self.memory, self.previous);
            }
            if !self.bitmap.0.is_null() {
                let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
            }
            if !self.memory.0.is_null() {
                let _ = DeleteDC(self.memory);
            }
            if !self.screen.0.is_null() {
                let _ = ReleaseDC(None, self.screen);
            }
        }
    }
}

fn visible_capture(region: Rect) -> Result<Surface, DesktopError> {
    let width = i32::try_from(region.width).map_err(|_| failure("invalid screen width"))?;
    let height = i32::try_from(region.height).map_err(|_| failure("invalid screen height"))?;
    let pixels = u64::from(region.width) * u64::from(region.height);
    if pixels == 0 || pixels > MAX_PIXELS {
        return Err(failure("screen pixel limit exceeded"));
    }
    // SAFETY: all GDI handles are acquired for this call and released by GdiGuard.
    // A top-down 32-bit BI_RGB DIB has four bytes per pixel and no row padding.
    unsafe {
        let screen = GetDC(None);
        if screen.0.is_null() {
            return Err(failure("screen DC unavailable"));
        }
        let mut resources = GdiGuard {
            screen,
            memory: HDC::default(),
            bitmap: HBITMAP::default(),
            previous: HGDIOBJ::default(),
        };
        resources.memory = CreateCompatibleDC(Some(screen));
        if resources.memory.0.is_null() {
            return Err(failure("capture memory DC unavailable"));
        }
        let header = BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let info = BITMAPINFO {
            bmiHeader: header,
            ..Default::default()
        };
        let mut data = std::ptr::null_mut();
        resources.bitmap = winrt(
            CreateDIBSection(Some(screen), &info, DIB_RGB_COLORS, &mut data, None, 0),
            "capture DIB allocation failed",
        )?;
        if data.is_null() {
            return Err(failure("capture DIB has no pixel buffer"));
        }
        resources.previous = SelectObject(resources.memory, HGDIOBJ(resources.bitmap.0));
        if resources.previous.0.is_null() {
            return Err(failure("cannot select capture bitmap"));
        }
        winrt(
            BitBlt(
                resources.memory,
                0,
                0,
                width,
                height,
                Some(screen),
                region.x,
                region.y,
                SRCCOPY,
            ),
            "screen copy failed",
        )?;
        let length = usize::try_from(pixels * 4).map_err(|_| failure("image too large"))?;
        // SAFETY: CreateDIBSection allocated width*height*4 mapped bytes; GDI
        // owns that memory until resources is dropped after to_vec().
        let bytes = std::slice::from_raw_parts(data.cast::<u8>(), length).to_vec();
        Ok(Surface {
            pool_width: region.width,
            pool_height: region.height,
            content_width: region.width,
            content_height: region.height,
            row_stride: region.width as usize * 4,
            bytes,
        })
    }
}

struct WgcGuard {
    pool: Direct3D11CaptureFramePool,
    session: windows::Graphics::Capture::GraphicsCaptureSession,
}

impl Drop for WgcGuard {
    fn drop(&mut self) {
        // WinRT close stops callbacks and releases its graphics resources even on
        // timeout/early error. The COM interface owners themselves use RAII.
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

struct WinRtApartment;
impl WinRtApartment {
    fn ensure() -> Result<Self, DesktopError> {
        // SAFETY: initializes WinRT on the calling thread; a thread already
        // using STA can use its compatible initialization. Drop balances the
        // one successful initialization.
        unsafe {
            if RoInitialize(RO_INIT_MULTITHREADED).is_ok()
                || RoInitialize(RO_INIT_SINGLETHREADED).is_ok()
            {
                Ok(Self)
            } else {
                Err(failure("cannot initialize the Windows capture apartment"))
            }
        }
    }
}
impl Drop for WinRtApartment {
    fn drop(&mut self) {
        // SAFETY: balances the successful RoInitialize on this same thread.
        unsafe { RoUninitialize() };
    }
}

fn wgc_capture(handle: i64, expected: Rect) -> Result<Surface, DesktopError> {
    let _apartment = WinRtApartment::ensure()?;
    if !winrt(
        GraphicsCaptureSession::IsSupported(),
        "WGC support check failed",
    )? {
        return Err(failure("Windows.Graphics.Capture is unavailable"));
    }
    let started = Instant::now();
    let interop = winrt(
        factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>(),
        "WGC HWND activation factory unavailable",
    )?;
    // SAFETY: the capture item targets precisely the caller-provided HWND; the
    // interop method validates it and owns the resulting WinRT interface.
    let item: GraphicsCaptureItem = winrt(
        unsafe { interop.CreateForWindow(hwnd(handle)) },
        "WGC refused target window",
    )?;
    let size = winrt(item.Size(), "WGC item size unavailable")?;
    let pool_width = u32::try_from(size.Width).map_err(|_| failure("invalid WGC pool width"))?;
    let pool_height = u32::try_from(size.Height).map_err(|_| failure("invalid WGC pool height"))?;
    if pool_width == 0
        || pool_height == 0
        || u64::from(pool_width) * u64::from(pool_height) > MAX_PIXELS
    {
        return Err(failure("capture dimensions exceed the pixel limit"));
    }

    let mut d3d_device: Option<ID3D11Device> = None;
    let mut d3d_context: Option<ID3D11DeviceContext> = None;
    // SAFETY: Windows COM output pointers are initialized Options, and D3D11
    // maintains their reference counts; graphics support requires BGRA surfaces.
    winrt(
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut d3d_device),
                None,
                Some(&mut d3d_context),
            )
        },
        "could not create WGC Direct3D device",
    )?;
    let device = d3d_device.ok_or_else(|| failure("Direct3D device missing"))?;
    let dxgi: IDXGIDevice = winrt(device.cast(), "Direct3D DXGI device unavailable")?;
    // SAFETY: dxgi is a live COM interface validated by cast; the WinRT projection
    // holds its own COM reference.
    let projected = winrt(
        unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) },
        "could not project Direct3D device into WinRT",
    )?;
    let direct: IDirect3DDevice = winrt(projected.cast(), "WinRT D3D interface unavailable")?;
    let pool = winrt(
        Direct3D11CaptureFramePool::CreateFreeThreaded(
            &direct,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            1,
            size,
        ),
        "could not allocate WGC frame pool",
    )?;
    let session = winrt(pool.CreateCaptureSession(&item), "WGC session unavailable")?;
    let resources = WgcGuard { pool, session };
    // The optional GraphicsCaptureSession3 interface is absent on older Windows
    // builds. When present, disable the yellow border BEFORE capture starts.
    let _ = resources.session.SetIsBorderRequired(false);
    winrt(
        resources.session.StartCapture(),
        "could not start WGC capture",
    )?;
    let frame = loop {
        if started.elapsed() >= Duration::from_millis(3000) {
            return Err(failure("no Windows.Graphics.Capture frame arrived"));
        }
        if let Ok(frame) = resources.pool.TryGetNextFrame() {
            break frame;
        }
        thread::sleep(Duration::from_millis(5));
    };
    let content = winrt(frame.ContentSize(), "WGC frame content size missing")?;
    let content_width =
        u32::try_from(content.Width).map_err(|_| error("STALE_FRAME", "negative frame width"))?;
    let content_height =
        u32::try_from(content.Height).map_err(|_| error("STALE_FRAME", "negative frame height"))?;
    super::validate_content(
        pool_width,
        pool_height,
        content_width,
        content_height,
        expected,
    )?;
    // Window geometry can move while the GPU is delivering the frame.
    if drawable(handle)? != expected {
        return Err(error(
            "STALE_FRAME",
            "window geometry changed during capture",
        ));
    }
    let surface = winrt(frame.Surface(), "WGC frame surface unavailable")?;
    let operation = winrt(
        SoftwareBitmap::CreateCopyWithAlphaFromSurfaceAsync(&surface, BitmapAlphaMode::Ignore),
        "WGC GPU readback failed",
    )?;
    loop {
        let status = winrt(operation.Status(), "GPU readback status unavailable")?;
        // WinRT AsyncStatus::Started is 0. The type comes from windows-future.
        if status.0 != 0 {
            break;
        }
        if started.elapsed() >= Duration::from_millis(3000) {
            let _ = operation.Cancel();
            return Err(failure("GPU readback timed out"));
        }
        thread::sleep(Duration::from_millis(5));
    }
    let bitmap = winrt(operation.GetResults(), "GPU readback did not complete")?;
    if winrt(bitmap.PixelWidth(), "GPU bitmap width unavailable")? != size.Width
        || winrt(bitmap.PixelHeight(), "GPU bitmap height unavailable")? != size.Height
    {
        return Err(error("STALE_FRAME", "copied surface dimensions changed"));
    }
    let locked = winrt(
        bitmap.LockBuffer(BitmapBufferAccessMode::Read),
        "WGC bitmap lock failed",
    )?;
    let plane = winrt(
        locked.GetPlaneDescription(0),
        "WGC bitmap stride unavailable",
    )?;
    let stride = usize::try_from(plane.Stride)
        .map_err(|_| error("STALE_FRAME", "invalid GPU row stride"))?;
    let start = usize::try_from(plane.StartIndex)
        .map_err(|_| error("STALE_FRAME", "invalid GPU plane offset"))?;
    let allocation_size = stride
        .checked_mul(pool_height as usize)
        .ok_or_else(|| error("STALE_FRAME", "GPU buffer size overflow"))?;
    let row_bytes = pool_width as usize * 4;
    let final_row = start
        .checked_add(stride * (pool_height as usize - 1))
        .and_then(|index| index.checked_add(row_bytes))
        .ok_or_else(|| error("STALE_FRAME", "GPU surface plane offset overflow"))?;
    if stride < row_bytes || allocation_size > MAX_PIXELS as usize * 16 {
        return Err(error("STALE_FRAME", "GPU bitmap allocation is invalid"));
    }
    // CopyToBuffer may compact rows independently of LockBuffer's plane stride.
    // Read the actual locked plane through IMemoryBufferByteAccess instead,
    // preserving the GPU's real StartIndex and Stride.
    let reference = winrt(locked.CreateReference(), "GPU bitmap reference unavailable")?;
    let access: IMemoryBufferByteAccess =
        winrt(reference.cast(), "GPU bitmap byte access unavailable")?;
    let mut pointer = std::ptr::null_mut();
    let mut capacity = 0u32;
    // SAFETY: IMemoryBufferByteAccess returns the address and allocation
    // capacity for this reference, valid while locked/reference remain alive.
    winrt(
        unsafe { access.GetBuffer(&mut pointer, &mut capacity) },
        "GPU bitmap mapped memory unavailable",
    )?;
    if pointer.is_null() || final_row > capacity as usize {
        return Err(error(
            "STALE_FRAME",
            "GPU plane extends beyond its allocation",
        ));
    }
    let mut bytes = vec![0u8; allocation_size];
    for row in 0..pool_height as usize {
        let source = start + row * stride;
        let destination = row * stride;
        // SAFETY: final_row <= capacity, start+row*stride+row_bytes
        // is within it for each row. The reference keeps the bytes mapped.
        let src = unsafe { std::slice::from_raw_parts(pointer.add(source), row_bytes) };
        bytes[destination..destination + row_bytes].copy_from_slice(src);
    }
    let _ = reference.Close();
    let _ = locked.Close();
    let _ = bitmap.Close();
    let _ = frame.Close();
    Ok(Surface {
        pool_width,
        pool_height,
        content_width,
        content_height,
        row_stride: stride,
        bytes,
    })
}

impl CaptureBackend for WindowsCapture {
    fn screen(&self) -> Result<(Rect, Rect), DesktopError> {
        let _dpi = DpiGuard::physical()?;
        // SAFETY: GetSystemMetrics has no external pointers and returns physical
        // desktop coordinates under the thread's PMv2 DPI context.
        unsafe {
            let virtual_screen = Rect::geometry(
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                u32::try_from(GetSystemMetrics(SM_CXVIRTUALSCREEN))
                    .map_err(|_| failure("invalid virtual desktop width"))?,
                u32::try_from(GetSystemMetrics(SM_CYVIRTUALSCREEN))
                    .map_err(|_| failure("invalid virtual desktop height"))?,
            )?;
            let primary = Rect::geometry(
                0,
                0,
                u32::try_from(GetSystemMetrics(SM_CXSCREEN))
                    .map_err(|_| failure("invalid primary width"))?,
                u32::try_from(GetSystemMetrics(SM_CYSCREEN))
                    .map_err(|_| failure("invalid primary height"))?,
            )?;
            Ok((virtual_screen, primary))
        }
    }
    fn outer_window(&self, handle: i64) -> Result<Rect, DesktopError> {
        let _dpi = DpiGuard::physical()?;
        outer(handle)
    }
    fn drawable_window(&self, handle: i64) -> Result<Rect, DesktopError> {
        let _dpi = DpiGuard::physical()?;
        drawable(handle)
    }
    fn is_focused(&self, handle: i64) -> bool {
        // SAFETY: compares opaque native handles, without activation.
        unsafe { GetForegroundWindow() == hwnd(handle) }
    }
    fn is_related(&self, handle: i64, owner: i64) -> bool {
        related(handle, owner)
    }
    fn capture_window(&self, handle: i64, drawable: Rect) -> Result<Surface, DesktopError> {
        let _dpi = DpiGuard::physical()?;
        wgc_capture(handle, drawable)
    }
    fn capture_screen(&self, region: Rect) -> Result<Surface, DesktopError> {
        let _dpi = DpiGuard::physical()?;
        visible_capture(region)
    }
}

const PIXEL_FORMAT_32BPP_ARGB: i32 = 0x26200A;

fn gdiplus_status(value: Status, message: &'static str) -> Result<(), DesktopError> {
    if value.0 == 0 {
        Ok(())
    } else {
        Err(error("CAPTURE_FAILED", message))
    }
}

struct GdiPlusSession(usize);
impl GdiPlusSession {
    fn start() -> Result<Self, DesktopError> {
        let mut token = 0;
        let input = GdiplusStartupInput {
            GdiplusVersion: 1,
            ..Default::default()
        };
        // SAFETY: Startup writes an opaque token to initialized memory. Drop
        // shuts it down after the graphics and bitmap owners have been dropped.
        gdiplus_status(
            unsafe { GdiplusStartup(&mut token, &input, std::ptr::null_mut()) },
            "GDI+ scaling initialization failed",
        )?;
        Ok(Self(token))
    }
}
impl Drop for GdiPlusSession {
    fn drop(&mut self) {
        // SAFETY: token belongs to this successful GdiplusStartup call.
        unsafe { GdiplusShutdown(self.0) };
    }
}

struct GdiPlusBitmap(*mut GpBitmap);
impl Drop for GdiPlusBitmap {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: DisposeImage releases the bitmap created by GDI+.
            let _ = unsafe { GdipDisposeImage(self.0.cast::<GpImage>()) };
        }
    }
}
struct GdiPlusGraphics(*mut GpGraphics);
impl Drop for GdiPlusGraphics {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: graphics was allocated by GetImageGraphicsContext.
            let _ = unsafe { GdipDeleteGraphics(self.0) };
        }
    }
}

/// The original Windows System.Drawing screenshot code uses GDI+
/// HighQualityBicubic, including the partial edge alpha produced during
/// interpolation. Screen mode also enables HighQuality pixel offset.
pub(super) fn scale_image(
    source: &RgbaImage,
    target_width: u32,
    target_height: u32,
    screen_mode: bool,
) -> Result<RgbaImage, DesktopError> {
    let width =
        i32::try_from(source.width()).map_err(|_| failure("image width exceeds GDI+ limits"))?;
    let height =
        i32::try_from(source.height()).map_err(|_| failure("image height exceeds GDI+ limits"))?;
    let output_width =
        i32::try_from(target_width).map_err(|_| failure("scaled width exceeds GDI+ limits"))?;
    let output_height =
        i32::try_from(target_height).map_err(|_| failure("scaled height exceeds GDI+ limits"))?;
    let mut bgra = source.clone().into_raw();
    for pixel in bgra.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
    }
    let _startup = GdiPlusSession::start()?;
    let mut source_bitmap = GdiPlusBitmap(std::ptr::null_mut());
    // SAFETY: bgra stays alive and immobile until the last operation on this
    // bitmap completes, and its stride is exactly source.width*4.
    gdiplus_status(
        unsafe {
            GdipCreateBitmapFromScan0(
                width,
                height,
                width * 4,
                PIXEL_FORMAT_32BPP_ARGB,
                Some(bgra.as_ptr()),
                &mut source_bitmap.0,
            )
        },
        "GDI+ could not create source bitmap",
    )?;
    let mut output_bitmap = GdiPlusBitmap(std::ptr::null_mut());
    // SAFETY: GDI+ allocates its own output pixel buffer with these dimensions.
    gdiplus_status(
        unsafe {
            GdipCreateBitmapFromScan0(
                output_width,
                output_height,
                0,
                PIXEL_FORMAT_32BPP_ARGB,
                None,
                &mut output_bitmap.0,
            )
        },
        "GDI+ could not create destination bitmap",
    )?;
    let mut graphics = GdiPlusGraphics(std::ptr::null_mut());
    // SAFETY: destination bitmap stays alive through graphics lifetime.
    gdiplus_status(
        unsafe { GdipGetImageGraphicsContext(output_bitmap.0.cast::<GpImage>(), &mut graphics.0) },
        "GDI+ graphics context unavailable",
    )?;
    gdiplus_status(
        unsafe { GdipSetInterpolationMode(graphics.0, InterpolationModeHighQualityBicubic) },
        "GDI+ interpolation mode unavailable",
    )?;
    if screen_mode {
        // SAFETY: graphics is valid; uses the original screen resampler's mode.
        gdiplus_status(
            unsafe { GdipSetPixelOffsetMode(graphics.0, PixelOffsetModeHighQuality) },
            "GDI+ pixel offset mode unavailable",
        )?;
    }
    // SAFETY: source/destination are live GDI+ bitmaps, and checked dimensions
    // fit the allocated output.
    gdiplus_status(
        unsafe {
            GdipDrawImageRectI(
                graphics.0,
                source_bitmap.0.cast::<GpImage>(),
                0,
                0,
                output_width,
                output_height,
            )
        },
        "GDI+ image interpolation failed",
    )?;
    // Flush graphics before reading the bitmap.
    drop(graphics);
    let mut locked = BitmapData::default();
    // SAFETY: null rectangle locks the complete allocated bitmap, read-only.
    gdiplus_status(
        unsafe {
            GdipBitmapLockBits(
                output_bitmap.0,
                std::ptr::null(),
                ImageLockModeRead.0 as u32,
                PIXEL_FORMAT_32BPP_ARGB,
                &mut locked,
            )
        },
        "GDI+ cannot lock scaled pixels",
    )?;
    let pixels_result = (|| {
        let row_bytes = target_width as usize * 4;
        let stride = locked.Stride.unsigned_abs() as usize;
        if locked.Scan0.is_null() || stride < row_bytes {
            return Err(error("CAPTURE_FAILED", "GDI+ scaled stride is invalid"));
        }
        let byte_length = u64::from(target_width) * u64::from(target_height) * 4;
        if byte_length > MAX_PIXELS * 4 {
            return Err(error("CAPTURE_FAILED", "scaled image exceeds pixel bound"));
        }
        let mut rgba = vec![0u8; byte_length as usize];
        for row in 0..target_height as usize {
            let offset = row * stride;
            // SAFETY: LockBits maps abs(stride)*height bytes. With negative
            // pitch Scan0 points to the first logical row, and subtracting
            // each pitch reaches the next logical row within that map.
            let src_row = unsafe {
                if locked.Stride >= 0 {
                    (locked.Scan0 as *const u8).add(offset)
                } else {
                    (locked.Scan0 as *const u8).sub(offset)
                }
            };
            let to = &mut rgba[row * row_bytes..(row + 1) * row_bytes];
            // SAFETY: row_bytes <= abs(stride) and bitmap is locked for read.
            to.copy_from_slice(unsafe { std::slice::from_raw_parts(src_row, row_bytes) });
        }
        for pixel in rgba.as_chunks_mut::<4>().0 {
            pixel.swap(0, 2);
        }
        RgbaImage::from_raw(target_width, target_height, rgba)
            .ok_or_else(|| error("CAPTURE_FAILED", "GDI+ pixel dimensions are invalid"))
    })();
    // SAFETY: pairs with successful LockBits above, even on conversion error.
    gdiplus_status(
        unsafe { GdipBitmapUnlockBits(output_bitmap.0, &mut locked) },
        "GDI+ scaled bitmap unlock failed",
    )?;
    pixels_result
}
