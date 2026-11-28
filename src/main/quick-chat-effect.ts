import { BrowserWindow, screen } from 'electron';
import type { WindowInfo } from './computer/index.js';

// A passive, short-lived compositor surface. It has no preload, network, user
// content, input handling or connection to the chat renderer.
const markup = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent} .frame{position:absolute;inset:3px;border:2px solid #9db9ff;border-radius:11px;overflow:hidden;box-shadow:inset 0 0 22px #668fff55,0 0 12px #668fff99;opacity:0;animation:pulse 920ms ease-out both;animation-play-state:paused}
.frame::before{content:'';position:absolute;inset:-65%;background:linear-gradient(125deg,transparent 40%,#7e9bff16 47%,#9dcaff55 49.5%,#e5f5ff88 50%,#c3a7ff30 51%,transparent 60%);transform:translate(-36%,-36%);animation:sweep 920ms cubic-bezier(.24,.55,.48,1) both;animation-play-state:inherit}.frame::after{content:'';position:absolute;inset:0;border-radius:inherit;border:1px solid #d8edff;animation:trace 920ms ease-out both;animation-play-state:inherit} .spark{position:absolute;width:5px;height:5px;border-radius:50%;background:#e1edff;box-shadow:0 0 10px #8cb4ff;animation:spark 920ms ease-out both;animation-play-state:paused}.a{left:8px;top:8px;--x:14px;--y:14px}.b{right:8px;bottom:8px;--x:-14px;--y:-14px}html.playing .frame,html.playing .spark{animation-play-state:running}
@keyframes pulse{0%{opacity:0;transform:scale(.994)}15%{opacity:.95;transform:scale(1)}65%{opacity:.7}100%{opacity:0;transform:scale(1)}}@keyframes sweep{to{transform:translate(36%,36%)}}@keyframes trace{0%{opacity:0}20%{opacity:.9}100%{opacity:0}}@keyframes spark{0%{opacity:0}20%{opacity:1}100%{opacity:0;transform:translate(var(--x),var(--y)) scale(.3)}}@media(prefers-reduced-motion:reduce){.frame,.frame::before,.frame::after,.spark{animation:none}.frame{opacity:.65}.frame::before,.spark{display:none}}
</style></head><body><div class="frame"></div><div class="spark a"></div><div class="spark b"></div></body></html>`;

export function createQuickChatEffect() {
  let overlay: BrowserWindow | null = null;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    revision++;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    overlay = null;
  };
  const show = async (source: WindowInfo | null, exclude?: Electron.Rectangle) => {
    clear();
    if (!source) return;
    const epoch = revision;
    const rect = { x: source.x, y: source.y, width: source.width, height: source.height };
    const dip = process.platform === 'win32' ? screen.screenToDipRect(null, rect) : rect;
    const display = screen.getDisplayMatching(dip).bounds;
    const x = Math.max(dip.x, display.x), y = Math.max(dip.y, display.y);
    const width = Math.min(dip.x + dip.width, display.x + display.width) - x;
    const height = Math.min(dip.y + dip.height, display.y + display.height) - y;
    if (width < 32 || height < 32) return;
    // The passive scan must never paint over the Quick Chat panel itself.
    let html = markup;
    if (exclude) {
      const l = Math.max(0, exclude.x - x - 2), t = Math.max(0, exclude.y - y - 2);
      const r = Math.min(width, exclude.x + exclude.width - x + 2), b = Math.min(height, exclude.y + exclude.height - y + 2);
      if (l < r && t < b) {
        if (l === 0 && t === 0 && r === width && b === height) return;
        const polygon = `polygon(evenodd, 0 0, ${width}px 0, ${width}px ${height}px, 0 ${height}px, 0 0, ${l}px ${t}px, ${r}px ${t}px, ${r}px ${b}px, ${l}px ${b}px, ${l}px ${t}px, 0 0)`;
        html = markup.replace('<body>', `<body style="clip-path:${polygon}">`);
      }
    }
    const owner = new BrowserWindow({ x, y, width, height, show: false, frame: false, transparent: true,
      focusable: false, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true,
      hasShadow: false, fullscreenable: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    overlay = owner;
    owner.setIgnoreMouseEvents(true);
    owner.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    owner.webContents.on('will-navigate', event => event.preventDefault());
    try {
      await owner.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      if (epoch !== revision || owner.isDestroyed()) return;
      owner.showInactive();
      timer = setTimeout(clear, 1050);
      await owner.webContents.executeJavaScript("document.documentElement.classList.add('playing')");
    } catch { if (epoch === revision) clear(); }
  };
  return { show, clear };
}
