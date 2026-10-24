//! The tray status dot of `src/main/tray-image.ts` (`trayRgba` for Windows and Linux): green
//! while running, grey otherwise, 16 logical pixels with an anti-aliased edge.

const LOGICAL_SIZE: u32 = 16;

/// Square RGBA pixels, `size * size * 4` bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrayImage {
    pub size: u32,
    pub rgba: Vec<u8>,
}

fn edge_coverage(distance: f64, radius: f64) -> f64 {
    (radius + 0.5 - distance).clamp(0., 1.)
}

pub fn tray_rgba(running: bool, scale: u32) -> TrayImage {
    let size = LOGICAL_SIZE * scale;
    let centre = f64::from(size - 1) / 2.;
    let outer_radius = 6.2 * f64::from(scale);
    let [r, g, b] = if running {
        [34, 160, 90]
    } else {
        [130, 130, 138]
    };
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);
    for y in 0..size {
        for x in 0..size {
            let distance = (f64::from(x) - centre).hypot(f64::from(y) - centre);
            // `Buffer` stores `Math.round(alpha * 255)`; alpha is never negative here.
            let alpha = (edge_coverage(distance, outer_radius) * 255.).round() as u8;
            rgba.extend_from_slice(&[r, g, b, alpha]);
        }
    }
    TrayImage { size, rgba }
}
