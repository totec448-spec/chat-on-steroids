// Exercise Pets with isolated userData against the built renderer or the live Vite dev renderer.
// Run after `npm run build`; ELECTRON_RENDERER_URL=http://localhost:5173 also checks dev CSS loading.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const reuseAt = process.argv.indexOf('--reuse');
const reusing = reuseAt >= 0;
const userData = reusing ? path.resolve(process.argv[reuseAt + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'cos-pets-render-'));
if (!reusing) {
  fs.mkdirSync(path.join(userData, 'state'));
  fs.writeFileSync(path.join(userData, 'state', 'pet-library.json'), JSON.stringify({
    version: 1, enabled: ['tur-tur-sahur'], favorites: []
  }));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    roots: [], readOnly: true, capabilities: {},
    tunnel: { kind: 'openai', tunnelId: '', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: false, autoConnect: false, theme: 'dark', autoContinue: false, backgroundChats: false },
    multiAgent: { enabled: false, allowUnattributedCalls: false, recoverAgentTabs: false },
    goal: { enabled: false }
  }));
}
app.setName('CoS Pets Render Probe');
app.setPath('userData', userData);
app.setAppPath(root);
process.env.CLF_BRIDGE_PORTS = '0';

let found = false;
const timeout = setTimeout(() => { console.error(`Pets overlay did not load; userData=${userData}`); app.exit(1); }, 30_000);
// The product prewarms a provider tab before Pets. Keep that unrelated dependency local here.
const provider = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>Pet smoke provider stub</title>');
});
const sessions = new Set();
app.on('web-contents-created', (_event, contents) => {
  const current = contents.session;
  if (sessions.has(current)) return;
  sessions.add(current);
  current.webRequest.onBeforeRequest({ urls: ['https://chatgpt.com/*'] }, (_details, callback) => {
    callback({ redirectURL: `http://127.0.0.1:${provider.address().port}/` });
  });
});
app.on('browser-window-created', (_event, win) => {
  if (win.getTitle() !== 'Pets' || found) return;
  found = true;
  const nativeShapes = [];
  const setShape = win.setShape.bind(win);
  win.setShape = regions => { nativeShapes.push(regions); return setShape(regions); };
  const ignoredMouseCalls = [];
  const setIgnoreMouseEvents = win.setIgnoreMouseEvents.bind(win);
  win.setIgnoreMouseEvents = (ignore, options) => {
    ignoredMouseCalls.push({ ignore, forward: options?.forward === true });
    return setIgnoreMouseEvents(ignore, options);
  };
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const geometry = await win.webContents.executeJavaScript(`(() => {
          const shell = document.querySelector('.pet-shell');
          const body = document.querySelector('.pet-body');
          if (!shell || !body) return null;
          const style = getComputedStyle(body);
          return {
            shell: shell.getBoundingClientRect().toJSON(),
            body: body.getBoundingClientRect().toJSON(),
            backgroundSize: style.backgroundSize,
            backgroundPosition: style.backgroundPosition,
            backgroundImage: style.backgroundImage.slice(0, 100),
            frame: shell.dataset.frame,
            dpr: devicePixelRatio,
            viewport: { width: innerWidth, height: innerHeight }
          };
        })()`);
        assert.ok(geometry, 'The visible overlay must render an enabled pet.');
        assert.equal(win.webContents.getZoomFactor(), 1);
        assert.equal(geometry.body.width, 160);
        assert.equal(geometry.body.height, 160);
        assert.equal(geometry.backgroundSize, '1280px 1920px');
        if (reusing) {
          assert.ok(Math.abs(geometry.shell.x - 333) < 1 && Math.abs(geometry.shell.y - 444) < 1,
            `The pet position must survive a full app restart; got ${geometry.shell.x},${geometry.shell.y}.`);
        }
        const frame = Number(geometry.frame);
        assert.ok(Number.isInteger(frame) && frame >= 0 && frame < 96);
        assert.equal(geometry.backgroundPosition, `${-(frame % 8) * 160}px ${-Math.floor(frame / 8) * 160}px`);
        const png = (await win.webContents.capturePage()).toPNG();
        const shot = path.join(userData, 'pets.png');
        fs.writeFileSync(shot, png);
        const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
        for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
          const offset = (y * info.width + x) * info.channels;
          if (data[offset + 3] < 16) continue;
          minX = Math.min(minX, x); minY = Math.min(minY, y);
          maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
        assert.ok(maxX >= 0, 'The desktop pet must contribute visible pixels.');
        const dpr = geometry.dpr;
        assert.ok(maxX - minX + 1 >= 45 * dpr, 'The pet rendered too narrow.');
        assert.ok(maxY - minY + 1 >= 70 * dpr, 'The pet rendered too short.');
        assert.ok(minX >= geometry.body.left * dpr - 2 && maxX <= geometry.body.right * dpr + 2,
          'The sprite escaped its cell horizontally.');
        assert.ok(minY >= geometry.body.top * dpr - 2 && maxY <= geometry.body.bottom * dpr + 2,
          'The sprite escaped its cell vertically.');
        if (process.platform === 'win32') {
          assert.ok(ignoredMouseCalls.some(call => call.ignore),
            `The idle overlay must be click-through: ${JSON.stringify(ignoredMouseCalls)}`);
          assert.equal(ignoredMouseCalls.some(call => call.ignore && call.forward), false,
            `Windows must not forward ignored mouse movement to a second cursor owner: ${JSON.stringify(ignoredMouseCalls)}`);
          const hoverOwner = BrowserWindow.getAllWindows().find(candidate => candidate !== win && candidate.getTitle() === 'Chat On Steroids');
          assert.ok(hoverOwner, 'The hover regression requires the visible owner behind Pets.');
          await hoverOwner.webContents.executeJavaScript(`(() => {
            clearInterval(window.__petBehindTimer);
            window.__petBehindTicks = 0;
            window.__petBehindTimer = setInterval(() => window.__petBehindTicks++, 50);
          })()`);
          const hoverX = Math.round(geometry.shell.x + geometry.shell.width / 2);
          const hoverY = Math.round(geometry.shell.y + geometry.shell.height / 2);
          win.webContents.sendInputEvent({ type: 'mouseMove', x: 10, y: 10 });
          await new Promise(resolve => setTimeout(resolve, 50));
          assert.equal(win.isFocusable(), false, 'Pointer outside pet content must keep the overlay click-through.');
          const ticksBeforeHover = await hoverOwner.webContents.executeJavaScript('window.__petBehindTicks');
          win.webContents.sendInputEvent({ type: 'mouseMove', x: hoverX, y: hoverY });
          await new Promise(resolve => setTimeout(resolve, 500));
          assert.equal(win.isFocusable(), false, 'Pet interaction must not activate an occluding desktop window.');
          const ticksAfterHover = await hoverOwner.webContents.executeJavaScript('window.__petBehindTicks');
          assert.ok(ticksAfterHover - ticksBeforeHover >= 4,
            `The owner behind an interactive pet must keep running; ticks=${ticksBeforeHover}->${ticksAfterHover}.`);
          win.webContents.sendInputEvent({ type: 'mouseMove', x: 10, y: 10 });
          await new Promise(resolve => setTimeout(resolve, 50));
          assert.equal(win.isFocusable(), false, 'Leaving pet content must restore native click-through.');
        }
        console.log(JSON.stringify({ userData, shot, zoom: win.webContents.getZoomFactor(), geometry,
          alphaBounds: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } }, null, 2));
        win.webContents.send('pet-overlay:snapshot', {
          visible: true, dismissedPetIds: [], level: 'running',
          activities: [{ id: 'task-smoke', title: 'Prime', body: 'Working', level: 'running', sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }],
          theme: 'dark',
          appearance: {
            light: { background: '#f4f4f5', sidebar: '#e9edf2', accent: '#486f9d', contrast: 45 },
            dark: { background: '#181818', sidebar: '#1a2129', accent: '#b0cbed', contrast: 60 },
            font: 'system', fontSize: 14, translucentSidebar: true
          }
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        const task = await win.webContents.executeJavaScript(`(() => {
          const badge = document.querySelector('.pet-badge');
          badge.click();
          return { badgeHidden: badge.hidden, badgeText: badge.textContent,
            trayHidden: document.getElementById('petTray').hidden,
            card: document.querySelector('.pet-card')?.textContent,
            trayRect: document.getElementById('petTray').getBoundingClientRect().toJSON(),
            cardRect: document.querySelector('.pet-card')?.getBoundingClientRect().toJSON() };
        })()`);
        assert.equal(task.badgeHidden, false);
        assert.equal(task.badgeText, '1');
        assert.equal(task.trayHidden, false);
        assert.equal(task.card, 'PrimeWorking');
        assert.ok(task.trayRect.width <= 256 && task.trayRect.height <= 72,
          `A single active task must stay compact: ${JSON.stringify(task.trayRect)}`);
        assert.ok(task.cardRect.height <= 34, `Task rows must remain single-line: ${JSON.stringify(task.cardRect)}`);
        fs.writeFileSync(path.join(userData, 'task-strip.png'), (await win.webContents.capturePage()).toPNG());
        console.log(`task=${JSON.stringify(task)}`);
        win.webContents.send('pet-overlay:snapshot', {
          visible: true, dismissedPetIds: [], level: 'review',
          activities: [{ id: 'task-smoke', title: 'Prime', body: 'Ready for review', level: 'review', sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }],
          theme: 'dark',
          appearance: {
            light: { background: '#f4f4f5', sidebar: '#e9edf2', accent: '#486f9d', contrast: 45 },
            dark: { background: '#181818', sidebar: '#1a2129', accent: '#b0cbed', contrast: 60 },
            font: 'system', fontSize: 14, translucentSidebar: true
          }
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        const reviewBadge = await win.webContents.executeJavaScript(`(() => {
          const shell = document.querySelector('.pet-shell');
          const badge = shell.querySelector('.pet-badge');
          const probe = document.createElement('i');
          probe.style.cssText = 'position:fixed;background:var(--green-wash);color:var(--green);border:1px solid var(--green-line)';
          document.body.append(probe);
          const badgeStyle = getComputedStyle(badge), probeStyle = getComputedStyle(probe);
          const result = { level: shell.dataset.level, background: badgeStyle.backgroundColor, color: badgeStyle.color,
            border: badgeStyle.borderTopColor, expectedBackground: probeStyle.backgroundColor,
            expectedColor: probeStyle.color, expectedBorder: probeStyle.borderTopColor };
          probe.remove();
          return result;
        })()`);
        assert.equal(reviewBadge.level, 'review');
        assert.equal(reviewBadge.background, reviewBadge.expectedBackground,
          `Completed task badge must use the green surface: ${JSON.stringify(reviewBadge)}`);
        assert.equal(reviewBadge.color, reviewBadge.expectedColor);
        assert.equal(reviewBadge.border, reviewBadge.expectedBorder);
        win.webContents.send('pet-overlay:snapshot', {
          visible: true, dismissedPetIds: [], level: 'running',
          activities: Array.from({ length: 8 }, (_, index) => ({
            id: `task-smoke-${index}`, title: `Worker ${index + 1}`, body: 'Working', level: 'running',
            sessionId: `aaaaaaaa-bbbb-cccc-dddd-${String(index).padStart(12, '0')}`
          })),
          theme: 'dark',
          appearance: {
            light: { background: '#f4f4f5', sidebar: '#e9edf2', accent: '#486f9d', contrast: 45 },
            dark: { background: '#181818', sidebar: '#1a2129', accent: '#b0cbed', contrast: 60 },
            font: 'system', fontSize: 14, translucentSidebar: true
          }
        });
        await new Promise(resolve => setTimeout(resolve, 80));
        const taskStack = await win.webContents.executeJavaScript(`(() => {
          const tray = document.getElementById('petTray').getBoundingClientRect();
          const cards = document.getElementById('petCards');
          return { count: cards.children.length, height: tray.height,
            scrollHeight: cards.scrollHeight, clientHeight: cards.clientHeight };
        })()`);
        assert.equal(taskStack.count, 8);
        assert.ok(taskStack.height <= 206, `Many tasks must not grow beyond the compact tray: ${JSON.stringify(taskStack)}`);
        assert.ok(taskStack.scrollHeight > taskStack.clientHeight, `Many tasks must remain reachable by scrolling: ${JSON.stringify(taskStack)}`);
        if (!reusing) {
          // Move the actual PetMachine; pagehide persists its position on normal shutdown.
          win.setIgnoreMouseEvents(false);
          const fromX = Math.round(geometry.shell.x + 80);
          const fromY = Math.round(geometry.shell.y + 80);
          const toX = Math.round(fromX + 333 - geometry.shell.x);
          const toY = Math.round(fromY + 444 - geometry.shell.y);
          win.webContents.sendInputEvent({ type: 'mouseMove', x: fromX, y: fromY });
          win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x: fromX, y: fromY, clickCount: 1 });
          win.webContents.sendInputEvent({ type: 'mouseMove', x: toX, y: toY, movementX: toX - fromX, movementY: toY - fromY });
          win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: toX, y: toY, clickCount: 1 });
          await new Promise(resolve => setTimeout(resolve, 100));
          const moved = await win.webContents.executeJavaScript(`(() => {
            const rect = document.querySelector('.pet-shell').getBoundingClientRect();
            return { x: rect.x, y: rect.y, saved: localStorage.getItem('cos.ui.petDesktop.tur-tur-sahur.v1') };
          })()`);
          assert.ok(Math.abs(moved.x - 333) < 2 && Math.abs(moved.y - 444) < 2,
            `Native pointer drag did not move the pet: ${JSON.stringify(moved)}`);
          console.log(`dragged=${JSON.stringify(moved)}`);
        }
        const owners = BrowserWindow.getAllWindows().filter(candidate => candidate !== win);
        assert.ok(owners.length > 0, 'The desktop overlay needs an independently hosted owner window.');
        const owner = owners.find(candidate => candidate.getTitle() === 'Chat On Steroids') ?? owners[0];
        const titlebar = await owner.webContents.executeJavaScript(`(() => {
          const bar = document.querySelector('.app-topbar');
          const rect = bar?.getBoundingClientRect();
          const point = rect && { x: Math.min(rect.right - 160, Math.max(rect.left + 120, rect.width / 2)), y: rect.top + rect.height / 2 };
          const hit = point && document.elementFromPoint(point.x, point.y);
          return { rect: rect?.toJSON(), region: bar && getComputedStyle(bar).webkitAppRegion,
            hit: hit?.className ?? null, hitRegion: hit && getComputedStyle(hit).webkitAppRegion, point };
        })()`);
        assert.ok(titlebar.rect?.height >= 28, `The titlebar needs a real drag row: ${JSON.stringify(titlebar)}`);
        assert.equal(titlebar.region, 'drag', `The titlebar lost its native drag region: ${JSON.stringify(titlebar)}`);
        assert.ok(String(titlebar.hit).includes('app-topbar'), `The drag point is covered: ${JSON.stringify(titlebar)}`);
        console.log(`titlebar=${JSON.stringify(titlebar)}`);
        for (const owner of owners) if (owner.isVisible()) owner.minimize();
        assert.ok(win.isVisible(), 'Pets must remain visible after the CoS window is minimized.');
        console.log(`ownerMinimized=${owners.some(owner => owner.isMinimized())}; overlayVisible=${win.isVisible()}`);
        const screenBeforeClick = await owner.webContents.executeJavaScript('document.querySelector(".app")?.dataset.screen');
        const clickRect = await win.webContents.executeJavaScript('document.querySelector(".pet-shell").getBoundingClientRect().toJSON()');
        const clickX = Math.round(clickRect.x + clickRect.width / 2);
        const clickY = Math.round(clickRect.y + clickRect.height / 2);
        win.setIgnoreMouseEvents(false);
        win.webContents.sendInputEvent({ type: 'mouseMove', x: clickX, y: clickY });
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x: clickX, y: clickY, clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: clickX, y: clickY, clickCount: 1 });
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(owner.isMinimized(), false, 'A short pet click must restore and focus its CoS owner.');
        assert.equal(await owner.webContents.executeJavaScript('document.querySelector(".app")?.dataset.screen'), screenBeforeClick,
          'A pet click must preserve the current CoS screen.');
        console.log(`petClickRestoredOwner=true; screen=${screenBeforeClick}`);
        const contextMenu = await win.webContents.executeJavaScript(`(() => {
          const shell = document.querySelector('.pet-shell');
          const rect = shell.getBoundingClientRect();
          shell.dispatchEvent(new MouseEvent('contextmenu', {
            clientX: rect.right - 4,
            clientY: rect.bottom - 4,
            bubbles: true
          }));
          const menu = document.querySelector('.pet-menu');
          const menuRect = menu.getBoundingClientRect();
          return {
            labels: [...menu.querySelectorAll('button')].map(button => button.textContent),
            rect: menuRect.toJSON(),
            viewport: { width: innerWidth, height: innerHeight }
          };
        })()`);
        assert.ok(contextMenu.labels.includes('Hide pet'), `The pet context menu must offer Hide pet: ${JSON.stringify(contextMenu)}`);
        assert.ok(contextMenu.rect.left >= 0 && contextMenu.rect.top >= 0
          && contextMenu.rect.right <= contextMenu.viewport.width && contextMenu.rect.bottom <= contextMenu.viewport.height,
        `The expanded pet menu must stay inside the work area: ${JSON.stringify(contextMenu)}`);
        await win.webContents.executeJavaScript(`(() => {
          const hide = [...document.querySelectorAll('.pet-menu button')].find(button => button.textContent === 'Hide pet');
          if (!hide) throw new Error('Hide pet action is missing.');
          hide.click();
        })()`);
        await new Promise(resolve => setTimeout(resolve, 150));
        const hidden = await owner.webContents.executeJavaScript(`Promise.all([
          window.api.petsList(),
          window.api.petsOverlayState()
        ])`);
        assert.equal(hidden[0].ok, true);
        assert.equal(hidden[0].data.pets.find(pet => pet.id === 'tur-tur-sahur')?.enabled, true,
          'Hide pet must leave the clicked library member Active.');
        assert.equal(hidden[1].ok, true);
        assert.equal(hidden[1].data.visible, false);
        assert.equal(hidden[1].data.ready, true);
        assert.equal(hidden[1].data.activeCount, 1,
          'Hiding the final visible pet must keep its enabled membership.');
        assert.equal(win.isVisible(), false, 'The overlay window must hide when all active pets are dismissed.');
        const restored = await owner.webContents.executeJavaScript('window.api.petsSetOverlayVisible(true)');
        assert.equal(restored.ok, true);
        assert.equal(restored.data.visible, true);
        assert.equal(restored.data.activeCount, 1);
        assert.equal(win.isVisible(), true, 'The View visibility command must restore a dismissed active pet.');
        assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".pet-shell").length'), 1);
        const restoredRect = await win.webContents.executeJavaScript('document.querySelector(".pet-shell").getBoundingClientRect().toJSON()');
        assert.ok(Math.abs(restoredRect.x - 333) < 2 && Math.abs(restoredRect.y - 444) < 2,
          `Restoring a dismissed pet must retain its position: ${JSON.stringify(restoredRect)}`);
        console.log(`petContextHide=${JSON.stringify({ menu: contextMenu, hidden: hidden[1].data, restored: restored.data })}`);
        owner.minimize();
        clearTimeout(timeout);
        if (process.argv.includes('--hold')) {
          console.log('Holding the desktop overlay for 20 seconds for compositor inspection.');
          setTimeout(() => { provider.close(); app.quit(); }, 20_000);
        } else {
          provider.close();
          app.quit();
        }
      } catch (error) { console.error(error); app.exit(1); }
    }, 700);
  });
});
provider.listen(0, '127.0.0.1', () => require(path.join(root, 'out/main/index.js')));
