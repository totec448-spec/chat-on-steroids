import { BrowserWindow, screen } from 'electron';
import type {
  DesktopControlGuardDecision,
  DesktopControlGuardPresenter
} from './desktop-control-guard.js';
import { formatMainText, mainText } from './main-texts.js';

const NOTICE_WIDTH = 420;
const NOTICE_HEIGHT = 210;
const NOTICE_MARGIN = 16;
const openNotices = new Set<BrowserWindow>();

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function noticePosition(): { x: number; y: number } {
  const workArea = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(workArea.x + workArea.width - NOTICE_WIDTH - NOTICE_MARGIN),
    y: Math.round(workArea.y + workArea.height - NOTICE_HEIGHT - NOTICE_MARGIN)
  };
}

function noticeHtml(options: {
  title: string;
  body: string;
  detail?: string;
  countdownSeconds?: number;
  actions: Array<{ id: string; label: string; danger?: boolean }>;
}): string {
  const countdown = options.countdownSeconds
    ? `<div class="countdown" id="countdown" data-seconds="${options.countdownSeconds}">${escapeHtml(
        options.countdownSeconds === 1
          ? mainText('Starting automatically in 1 second.')
          : formatMainText('Starting automatically in {0} seconds.', [options.countdownSeconds])
      )}</div>`
    : '';
  const detail = options.detail
    ? `<div class="detail">${escapeHtml(options.detail)}</div>`
    : '';
  const actions = options.actions.map(action =>
    `<button class="${action.danger ? 'danger' : 'primary'}" data-action="${escapeHtml(action.id)}">${escapeHtml(action.label)}</button>`
  ).join('');
  const pluralTemplate = mainText('Starting automatically in {0} seconds.');
  const singular = mainText('Starting automatically in 1 second.');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <style>
    :root { color-scheme: dark; font-family: "Segoe UI", system-ui, sans-serif; }
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; background: transparent; }
    body {
      color: #f4f4f4; background: #202124; border: 1px solid #4b4f58; border-radius: 12px;
      padding: 18px; box-shadow: 0 12px 36px rgba(0,0,0,.45); overflow: hidden;
    }
    h1 { margin: 0 0 8px; font-size: 17px; font-weight: 650; }
    .body { font-size: 14px; line-height: 1.35; color: #f0f0f0; }
    .detail { margin-top: 6px; font-size: 12px; color: #b9bec8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .countdown { margin-top: 12px; font-size: 13px; color: #cbd7ff; }
    .actions { position: absolute; left: 18px; right: 18px; bottom: 18px; display: flex; justify-content: flex-end; gap: 8px; }
    button {
      min-width: 92px; border: 0; border-radius: 7px; padding: 8px 13px; font: inherit; font-size: 13px;
      cursor: pointer;
    }
    button:focus-visible { outline: 2px solid #9bb6ff; outline-offset: 2px; }
    .primary { color: #111; background: #9bb6ff; }
    .danger { color: #fff; background: #8d3440; }
  </style>
</head>
<body>
  <h1>${escapeHtml(options.title)}</h1>
  <div class="body">${escapeHtml(options.body)}</div>
  ${detail}
  ${countdown}
  <div class="actions">${actions}</div>
  <script>
    const countdown = document.getElementById('countdown');
    if (countdown) {
      let remaining = Number(countdown.dataset.seconds);
      const plural = ${JSON.stringify(pluralTemplate)};
      const singular = ${JSON.stringify(singular)};
      const timer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) { clearInterval(timer); return; }
        countdown.textContent = remaining === 1 ? singular : plural.replace('{0}', String(remaining));
      }, 1000);
    }
    for (const button of document.querySelectorAll('[data-action]')) {
      button.addEventListener('click', () => {
        location.href = 'cos-desktop-guard://' + button.dataset.action;
      });
    }
  </script>
</body>
</html>`;
}

function createNotice(html: string): { notice: BrowserWindow; loaded: Promise<void> } {
  const position = noticePosition();
  const notice = new BrowserWindow({
    ...position,
    width: NOTICE_WIDTH,
    height: NOTICE_HEIGHT,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#202124',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  openNotices.add(notice);
  notice.once('closed', () => openNotices.delete(notice));
  const loaded = notice.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(html)).then(() => {
    if (!notice.isDestroyed()) notice.showInactive();
  });
  return { notice, loaded };
}

export function createDesktopControlGuardPresenter(isQuitting: () => boolean): DesktopControlGuardPresenter {
  return {
    prompt(request) {
      if (isQuitting()) return Promise.reject(new Error('Application is shutting down.'));
      return new Promise<DesktopControlGuardDecision>((resolve, reject) => {
        let done = false;
        let automatic: ReturnType<typeof setTimeout> | null = null;
        const seconds = Math.max(1, Math.ceil(request.countdownMs / 1000));
        const { notice, loaded } = createNotice(noticeHtml({
          title: mainText('Desktop control'),
          body: formatMainText('{0} is about to control your desktop.', [request.label]),
          detail: request.description,
          countdownSeconds: seconds,
          actions: [
            { id: 'allow', label: mainText('Start now') },
            { id: 'stop', label: mainText('Stop'), danger: true }
          ]
        }));
        const settle = (decision: DesktopControlGuardDecision): void => {
          if (done) return;
          done = true;
          if (automatic) clearTimeout(automatic);
          if (!notice.isDestroyed()) notice.close();
          resolve(decision);
        };
        notice.webContents.on('will-navigate', (event, url) => {
          if (!url.startsWith('cos-desktop-guard://')) return;
          event.preventDefault();
          settle(url.endsWith('//stop') ? 'stop' : 'allow');
        });
        void loaded.then(() => {
          if (done) return;
          automatic = setTimeout(() => settle('allow'), request.countdownMs);
          automatic.unref?.();
        }).catch(error => {
          if (done) return;
          done = true;
          if (automatic) clearTimeout(automatic);
          if (!notice.isDestroyed()) notice.destroy();
          reject(new Error('Desktop control notice failed to load: ' + (error instanceof Error ? error.message : String(error))));
        });
        notice.once('closed', () => {
          if (done) return;
          done = true;
          if (automatic) clearTimeout(automatic);
          reject(new Error('Desktop control notice closed before a decision.'));
        });
      });
    },
    blocked(request, allowAgain) {
      if (isQuitting()) return;
      const { notice, loaded } = createNotice(noticeHtml({
        title: mainText('Desktop control stopped'),
        body: formatMainText('{0} cannot send desktop input until you allow it again.', [request.label]),
        detail: request.description,
        actions: [{ id: 'allow-again', label: mainText('Allow again') }]
      }));
      notice.webContents.on('will-navigate', (event, url) => {
        if (url !== 'cos-desktop-guard://allow-again') return;
        event.preventDefault();
        allowAgain();
        if (!notice.isDestroyed()) notice.close();
      });
      void loaded.catch(() => {
        if (!notice.isDestroyed()) notice.destroy();
      });
    }
  };
}
