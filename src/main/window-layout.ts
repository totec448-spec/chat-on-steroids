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

const PREFERRED_WIDTH = 1080;
const PREFERRED_HEIGHT = 700;
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
  const width = Math.min(PREFERRED_WIDTH, areaWidth);
  const height = Math.min(PREFERRED_HEIGHT, areaHeight);

  return {
    x: Math.round(workArea.x + (areaWidth - width) / 2),
    y: Math.round(workArea.y + (areaHeight - height) / 2),
    width,
    height,
    minWidth: Math.min(MIN_WIDTH, width),
    minHeight: Math.min(MIN_HEIGHT, height),
    useContentSize: false,
    resizable: true,
    maximizable: true
  };
}
