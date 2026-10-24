//! Where the main window opens: `state/window-bounds.json` (`src/main/window-layout.ts`,
//! `trackNormalWindowBounds` in `src/main/window-lifecycle.ts`). Coordinates are logical pixels,
//! the same units Electron saved as DIPs.

use serde::Serialize;
use serde_json::Value;

/// The durable ledger name the TypeScript app writes.
pub const LEDGER: &str = "window-bounds";

const MIN_WIDTH: i64 = 640;
const MIN_HEIGHT: i64 = 480;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Rect {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

impl Rect {
    fn intersection_area(self, other: Rect) -> i64 {
        let width = (self.x + self.width).min(other.x + other.width) - self.x.max(other.x);
        let height = (self.y + self.height).min(other.y + other.height) - self.y.max(other.y);
        width.max(0) * height.max(0)
    }
}

/// The saved envelope: the normal (restored) rectangle and whether the window was maximized.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Placement {
    pub bounds: Rect,
    pub maximized: bool,
}

/// `finiteWindowBounds`: finite numbers with a positive size, rounded like `Math.round`.
fn rect(value: &Value) -> Option<Rect> {
    let field = |name: &str| {
        value
            .get(name)?
            .as_f64()
            .filter(|number| number.is_finite())
    };
    let (x, y, width, height) = (field("x")?, field("y")?, field("width")?, field("height")?);
    if width <= 0. || height <= 0. {
        return None;
    }
    let round = |number: f64| (number + 0.5).floor() as i64;
    Some(Rect {
        x: round(x),
        y: round(y),
        width: round(width).max(1),
        height: round(height).max(1),
    })
}

/// `finiteWindowPlacement`: the envelope, or a legacy bare rectangle read as a normal window.
pub fn parse(saved: &Value) -> Option<Placement> {
    if let Some(bounds) = rect(saved) {
        return Some(Placement {
            bounds,
            maximized: false,
        });
    }
    let bounds = rect(saved.get("bounds")?)?;
    let maximized = saved.get("maximized")?.as_bool()?;
    Some(Placement { bounds, maximized })
}

/// The window the app opens, and whether it came from the saved placement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
    pub bounds: Rect,
    pub min_width: i64,
    pub min_height: i64,
    /// A first start, or a window last used maximized, opens maximized over `bounds`.
    pub maximized: bool,
    pub restored: bool,
}

fn whole_work_area(area: Rect) -> (Rect, i64, i64) {
    let width = area.width.max(1);
    let height = area.height.max(1);
    (
        Rect {
            x: area.x,
            y: area.y,
            width,
            height,
        },
        MIN_WIDTH.min(width),
        MIN_HEIGHT.min(height),
    )
}

/// `windowLayoutForDisplays`: restore the saved window only while it still overlaps a display,
/// kept wholly inside that display's work area; otherwise fill the primary work area.
pub fn layout(primary: Rect, work_areas: &[Rect], saved: Option<Placement>) -> Layout {
    let fresh = || {
        let (bounds, min_width, min_height) = whole_work_area(primary);
        Layout {
            bounds,
            min_width,
            min_height,
            maximized: true,
            restored: false,
        }
    };
    let Some(saved) = saved else {
        return fresh();
    };
    let mut matched = None;
    let mut matched_area = 0;
    for area in work_areas {
        let overlap = saved.bounds.intersection_area(*area);
        if overlap > matched_area {
            matched = Some(*area);
            matched_area = overlap;
        }
    }
    let Some(area) = matched else {
        return fresh();
    };
    let (area, min_width, min_height) = whole_work_area(area);
    let width = saved.bounds.width.clamp(min_width, area.width);
    let height = saved.bounds.height.clamp(min_height, area.height);
    Layout {
        bounds: Rect {
            x: saved.bounds.x.clamp(area.x, area.x + area.width - width),
            y: saved.bounds.y.clamp(area.y, area.y + area.height - height),
            width,
            height,
        },
        min_width,
        min_height,
        maximized: saved.maximized,
        restored: true,
    }
}
