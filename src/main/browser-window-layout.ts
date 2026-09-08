export interface BrowserWorkArea { x: number; y: number; width: number; height: number }
let workArea: (() => BrowserWorkArea) | null = null;

/** Electron owns display discovery; both native startup and the companion use these bounds. */
export function setBrowserWorkArea(provider: (() => BrowserWorkArea) | null): void { workArea = provider; }
export function currentBrowserWorkArea(): BrowserWorkArea | undefined { return workArea?.(); }
export function browserWindowBounds(area = currentBrowserWorkArea()): { width: number; height: number; left?: number; top?: number } {
  if (!area || ![area.x, area.y, area.width, area.height].every(Number.isFinite) || area.width <= 0 || area.height <= 0)
    return { width: 800, height: 600 };
  // At most 45% of the work area, with a modest cap on large monitors.
  const width = Math.max(1, Math.min(800, Math.floor(area.width * 0.6)));
  const height = Math.max(1, Math.min(600, Math.floor(area.height * 0.75)));
  return { width, height, left: Math.floor(area.x + (area.width - width) / 2), top: Math.floor(area.y + (area.height - height) / 2) };
}
