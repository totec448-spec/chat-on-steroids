/** User-facing 100% is the previous 130% size; IPC exposes relative zoom only. */
export const UI_BASE_ZOOM = 1.3;

export interface DisplayWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MainWindowLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  useContentSize: false;
  resizable: true;
  maximizable: true;
}

const MIN_WIDTH = 640;
const MIN_HEIGHT = 480;

/**
 * BrowserWindow bounds and Electron screen work areas are both expressed in DIPs. Keep the
 * outer window inside that work area: using content-size bounds would add the Windows frame
 * on top and can put controls below the taskbar on scaled/small displays.
 */
export function windowLayoutForWorkArea(workArea: DisplayWorkArea): MainWindowLayout {
  const areaWidth = Math.max(1, Math.floor(workArea.width));
  const areaHeight = Math.max(1, Math.floor(workArea.height));
  const width = areaWidth;
  const height = areaHeight;

  return {
    x: Math.round(workArea.x),
    y: Math.round(workArea.y),
    width,
    height,
    minWidth: Math.min(MIN_WIDTH, width),
    minHeight: Math.min(MIN_HEIGHT, height),
    useContentSize: false,
    resizable: true,
    maximizable: true
  };
}
