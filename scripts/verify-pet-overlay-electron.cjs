// Exercise Pets with isolated userData against the built renderer or the live Vite dev renderer.
// Run after `npm run build`; ELECTRON_RENDERER_URL=http://localhost:5173 also checks dev CSS loading.
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const { defaultConfig, merge } = require('./fixtures/app-defaults.cjs');
const reuseAt = process.argv.indexOf('--reuse');
const reusing = reuseAt >= 0;
const userData = reusing ? path.resolve(process.argv[reuseAt + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'cos-pets-render-'));
if (!reusing) {
  fs.mkdirSync(path.join(userData, 'state'));
  fs.writeFileSync(path.join(userData, 'state', 'pet-library.json'), JSON.stringify({
    version: 1, enabled: ['capy'], favorites: []
  }));
  // Start from the app's own defaults so the config is valid and not reset on load.
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(merge(defaultConfig(), {
    readOnly: true,
    ui: { minimizeToTray: false, autoConnect: false, theme: 'dark' },
    multiAgent: { enabled: false, recoverAgentTabs: false },
    goal: { enabled: false }
  })));
}
app.setName('CoS Pets Render Probe');
app.setPath('userData', userData);
app.setAppPath(root);
process.env.CLF_BRIDGE_PORTS = '0';

// Windows production proximity is owned by screen.getCursorScreenPoint(). Substitute only that
// boundary so this fixture exercises the real sampler -> renderer -> IPC path without moving the
// user's OS cursor. verify-pet-toggle.cjs owns the separate physical-pointer acceptance probe.
let sampledCursor = { x: -1_000_000, y: -1_000_000 };
app.whenReady().then(() => {
  if (process.platform === 'win32') screen.getCursorScreenPoint = () => sampledCursor;
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 2500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await sleep(40);
  }
  throw new Error(`Timed out: ${label}`);
}
async function captureEvidence(win, file, selectors) {
  const layout = await win.webContents.executeJavaScript(`(() => ({
    dpr: devicePixelRatio,
    rects: ${JSON.stringify(selectors)}.map(selector => document.querySelector(selector)?.getBoundingClientRect().toJSON()).filter(Boolean)
  }))()`);
  assert.ok(layout.rects.length === selectors.length, `Evidence elements missing for ${file}: ${JSON.stringify(layout)}`);
  const png = (await win.webContents.capturePage()).toPNG();
  const metadata = await sharp(png).metadata();
  const padding = Math.ceil(24 * layout.dpr);
  const left = Math.max(0, Math.floor(Math.min(...layout.rects.map(rect => rect.left)) * layout.dpr - padding));
  const top = Math.max(0, Math.floor(Math.min(...layout.rects.map(rect => rect.top)) * layout.dpr - padding));
  const right = Math.min(metadata.width, Math.ceil(Math.max(...layout.rects.map(rect => rect.right)) * layout.dpr + padding));
  const bottom = Math.min(metadata.height, Math.ceil(Math.max(...layout.rects.map(rect => rect.bottom)) * layout.dpr + padding));
  const output = await sharp(png).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
  const destination = path.join(userData, file);
  fs.writeFileSync(destination, output);
  return { file: destination, width: right - left, height: bottom - top, bytes: output.length };
}

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
// The overlay's title comes from its page, so it may still be empty when the window is created.
app.on('browser-window-created', (_event, win) => {
  if (win.getTitle() === 'Pets') return attachOverlay(win);
  win.webContents.on('page-title-updated', (_titleEvent, title) => { if (title === 'Pets') attachOverlay(win); });
});
function attachOverlay(win) {
  if (found) return;
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
  // The title can arrive after the load already finished; run the checks either way.
  const whenLoaded = run => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', run) : run());
  whenLoaded(() => {
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
          assert.equal(win.isFocusable(), true,
            'Windows Pets must remain focusable so explicit clicks survive hide/show.');
          const hoverOwner = BrowserWindow.getAllWindows().find(candidate => candidate !== win && candidate.getTitle() === 'Chat On Steroids');
          assert.ok(hoverOwner, 'The hover regression requires the visible owner behind Pets.');
          await hoverOwner.webContents.executeJavaScript(`(() => {
            clearInterval(window.__petBehindTimer);
            window.__petBehindTicks = 0;
            window.__petBehindTimer = setInterval(() => window.__petBehindTicks++, 50);
          })()`);
          const area = win.getContentBounds();
          const outside = { x: area.x - 1000, y: area.y - 1000 };
          sampledCursor = outside;
          assert.equal(ignoredMouseCalls.at(-1)?.ignore, true,
            `The initial outside sampled cursor must observe the overlay in click-through state: ${JSON.stringify(ignoredMouseCalls)}`);
          assert.equal(win.isFocused(), false, 'Showing the focusable overlay must not focus it.');
          const focusedBeforeHover = BrowserWindow.getFocusedWindow();
          const ticksBeforeHover = await hoverOwner.webContents.executeJavaScript('window.__petBehindTicks');
          const hoverRect = await win.webContents.executeJavaScript('document.querySelector(".pet-shell").getBoundingClientRect().toJSON()');
          const hoverX = Math.round(hoverRect.x + hoverRect.width / 2);
          const hoverY = Math.round(hoverRect.y + hoverRect.height / 2);
          const enterStart = ignoredMouseCalls.length;
          const shapeStart = nativeShapes.length;
          const zoom = win.webContents.getZoomFactor();
          sampledCursor = { x: area.x + hoverX * zoom, y: area.y + hoverY * zoom };
          await until(() => ignoredMouseCalls.slice(enterStart).some(call => call.ignore === false),
            'sampled cursor entering pet hit region');
          const interactiveShape = nativeShapes.slice(shapeStart).at(-1);
          assert.ok(Array.isArray(interactiveShape) && interactiveShape.length > 0 && interactiveShape.length <= 1024,
            `Interactive Pets must publish bounded native hit regions: ${JSON.stringify(interactiveShape)}`);
          for (const region of interactiveShape) {
            assert.ok(Number.isInteger(region.x) && Number.isInteger(region.y)
              && Number.isInteger(region.width) && Number.isInteger(region.height)
              && region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0
              && region.x + region.width <= area.width && region.y + region.height <= area.height,
            `Pet hit region escaped the overlay bounds: ${JSON.stringify({ area, region })}`);
          }
          assert.equal(interactiveShape.length === 1
            && interactiveShape[0].x === 0 && interactiveShape[0].y === 0
            && interactiveShape[0].width === area.width && interactiveShape[0].height === area.height, false,
          `Interactive Pets must not expose the full transparent desktop surface: ${JSON.stringify(interactiveShape)}`);
          assert.ok(interactiveShape.some(region => hoverX >= region.x && hoverX < region.x + region.width
            && hoverY >= region.y && hoverY < region.y + region.height),
          `The sampled pet point must be inside a native hit region: ${JSON.stringify({ hoverX, hoverY, interactiveShape })}`);
          await sleep(500);
          assert.equal(win.isFocused(), false, 'Hovering a pet must not focus the overlay.');
          if (focusedBeforeHover) assert.equal(BrowserWindow.getFocusedWindow(), focusedBeforeHover,
            'Hovering a pet must not steal focus from the previously focused window.');
          const ticksAfterHover = await hoverOwner.webContents.executeJavaScript('window.__petBehindTicks');
          assert.ok(ticksAfterHover - ticksBeforeHover >= 4,
            `The owner behind an interactive pet must keep running; ticks=${ticksBeforeHover}->${ticksAfterHover}.`);
          const leaveStart = ignoredMouseCalls.length;
          sampledCursor = outside;
          await until(() => ignoredMouseCalls.slice(leaveStart).some(call => call.ignore === true),
            'sampled cursor leaving pet hit region');
          assert.equal(ignoredMouseCalls.some(call => call.ignore && call.forward), false,
            `Windows must not forward ignored mouse movement to a second cursor owner: ${JSON.stringify(ignoredMouseCalls)}`);
        }
        console.log(JSON.stringify({ userData, shot, zoom: win.webContents.getZoomFactor(), geometry,
          alphaBounds: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } }, null, 2));
        win.webContents.send('pet-overlay:snapshot', {
          visible: true, dismissedPetIds: [], level: 'running',
          activities: [
            { id: 'task-smoke-prime', title: 'Prime', body: 'Implementing badge', level: 'running', sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
            { id: 'task-smoke-worker', title: 'Worker', body: 'Reviewing UI', level: 'running', sessionId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff' }
          ],
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
        assert.equal(task.badgeText, '2');
        assert.equal(task.trayHidden, false);
        assert.equal(task.card, 'PrimeImplementing badge');
        assert.ok(task.trayRect.width <= 256 && task.trayRect.height <= 110,
          `Two active tasks must stay compact: ${JSON.stringify(task.trayRect)}`);
        assert.ok(task.cardRect.height <= 34, `Task rows must remain single-line: ${JSON.stringify(task.cardRect)}`);
        const beforeEvidence = await captureEvidence(win, 'before-pet-attached.png', ['.pet-shell', '#petTray']);
        console.log(`beforeEvidence=${JSON.stringify(beforeEvidence)}; task=${JSON.stringify(task)}`);

        const standaloneOwner = BrowserWindow.getAllWindows().find(candidate => candidate !== win && candidate.getTitle() === 'Chat On Steroids')
          ?? BrowserWindow.getAllWindows().find(candidate => candidate !== win);
        assert.ok(standaloneOwner, 'The standalone preference must be changed through the real owner IPC.');
        const previousLibrary = await standaloneOwner.webContents.executeJavaScript('window.api.petsList()');
        assert.equal(previousLibrary.ok, true);
        assert.equal(previousLibrary.data.standaloneTaskBadge, false,
          'A previous-version v1 library without the optional preference must restore it as Off.');
        const enabledStandalone = await standaloneOwner.webContents.executeJavaScript('window.api.petsSetStandaloneTaskBadge(true)');
        assert.equal(enabledStandalone.ok, true, JSON.stringify(enabledStandalone));
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
        await until(async () => win.webContents.executeJavaScript('!document.getElementById("petStandaloneBadge").hidden'), 'standalone badge visible beside an enabled pet');
        const coexistence = await win.webContents.executeJavaScript(`(() => ({
          petCount: document.querySelectorAll('.pet-shell').length,
          visiblePetBadges: [...document.querySelectorAll('.pet-badge')].filter(badge => !badge.hidden).length,
          standaloneHidden: document.getElementById('petStandaloneBadge').hidden,
          visibleBadgeCount: [...document.querySelectorAll('.pet-badge, #petStandaloneBadge')].filter(badge => !badge.hidden).length
        }))()`);
        assert.deepEqual(coexistence, { petCount: 1, visiblePetBadges: 0, standaloneHidden: false, visibleBadgeCount: 1 });

        const disabledPet = await standaloneOwner.webContents.executeJavaScript('window.api.petsSetEnabled("capy", false)');
        assert.equal(disabledPet.ok, true, JSON.stringify(disabledPet));
        await until(async () => win.webContents.executeJavaScript('document.querySelectorAll(".pet-shell").length === 0'), 'standalone badge without an enabled pet');
        assert.equal(win.isVisible(), true, 'Standalone mode must keep the existing overlay visible without a pet.');
        win.webContents.send('pet-overlay:snapshot', {
          visible: true, dismissedPetIds: [], level: 'running',
          activities: [
            { id: 'task-smoke-prime', title: 'Prime', body: 'Implementing badge', level: 'running', sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
            { id: 'task-smoke-worker', title: 'Worker', body: 'Reviewing UI', level: 'running', sessionId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff' }
          ],
          theme: 'dark',
          appearance: {
            light: { background: '#f4f4f5', sidebar: '#e9edf2', accent: '#486f9d', contrast: 45 },
            dark: { background: '#181818', sidebar: '#1a2129', accent: '#b0cbed', contrast: 60 },
            font: 'system', fontSize: 14, translucentSidebar: true
          }
        });
        await win.webContents.executeJavaScript('document.getElementById("petTrayClose").click()');
        await until(async () => win.webContents.executeJavaScript('document.getElementById("petTray").hidden'), 'close the pet-anchored tray before testing standalone activation');
        const standaloneRect = await win.webContents.executeJavaScript('document.getElementById("petStandaloneBadge").getBoundingClientRect().toJSON()');
        const standaloneX = Math.round(standaloneRect.x + standaloneRect.width / 2);
        const standaloneY = Math.round(standaloneRect.y + standaloneRect.height / 2);
        win.setIgnoreMouseEvents(false);
        win.webContents.sendInputEvent({ type: 'mouseMove', x: standaloneX, y: standaloneY });
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x: standaloneX, y: standaloneY, clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: standaloneX, y: standaloneY, clickCount: 1 });
        await until(async () => win.webContents.executeJavaScript('!document.getElementById("petTray").hidden'), 'standalone badge opens the existing Tasks tray');
        const standaloneTask = await win.webContents.executeJavaScript(`(() => ({
          petCount: document.querySelectorAll('.pet-shell').length,
          badgeHidden: document.getElementById('petStandaloneBadge').hidden,
          badgeText: document.getElementById('petStandaloneBadge').textContent,
          trayHidden: document.getElementById('petTray').hidden,
          card: document.querySelector('.pet-card')?.textContent,
          trayRect: document.getElementById('petTray').getBoundingClientRect().toJSON(),
          cardRect: document.querySelector('.pet-card')?.getBoundingClientRect().toJSON()
        }))()`);
        assert.equal(standaloneTask.petCount, 0);
        assert.equal(standaloneTask.badgeHidden, false);
        assert.equal(standaloneTask.badgeText, '2');
        assert.equal(standaloneTask.trayHidden, false);
        assert.equal(standaloneTask.card, 'PrimeImplementing badge');
        assert.ok(standaloneTask.trayRect.width <= 256 && standaloneTask.trayRect.height <= 110,
          `The standalone tray must remain compact: ${JSON.stringify(standaloneTask.trayRect)}`);
        assert.ok(standaloneTask.cardRect.height <= 34, `Standalone task rows must remain single-line: ${JSON.stringify(standaloneTask.cardRect)}`);
        const afterEvidence = await captureEvidence(win, 'after-standalone-no-pet.png', ['#petStandaloneBadge', '#petTray']);
        console.log(`afterEvidence=${JSON.stringify(afterEvidence)}`);
        await win.webContents.executeJavaScript('document.getElementById("petTrayClose").click()');
        await until(async () => win.webContents.executeJavaScript('document.getElementById("petTray").hidden'), 'close the tray before keyboard activation');
        const keyboardRect = await win.webContents.executeJavaScript('document.getElementById("petStandaloneBadge").getBoundingClientRect().toJSON()');
        const keyboardArea = win.getContentBounds();
        sampledCursor = {
          x: keyboardArea.x + keyboardRect.x + keyboardRect.width / 2,
          y: keyboardArea.y + keyboardRect.y + keyboardRect.height / 2
        };
        win.setIgnoreMouseEvents(false);
        win.focus();
        win.webContents.focus();
        await win.webContents.executeJavaScript(`(() => {
          const badge = document.getElementById('petStandaloneBadge');
          window.__standaloneKeyboardEvents = [];
          for (const type of ['keydown', 'keyup', 'click']) badge.addEventListener(type, event =>
            window.__standaloneKeyboardEvents.push({ type, key: event.key, code: event.code, detail: event.detail }));
          badge.focus();
        })()`);
        await until(async () => win.isFocused() && win.webContents.executeJavaScript('document.hasFocus() && document.activeElement.id === "petStandaloneBadge"'), 'focus the standalone badge for keyboard activation');
        win.webContents.sendInputEvent({ type: 'rawKeyDown', keyCode: 'Enter' });
        win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        console.log(`standaloneKeyboardAfterEnter=${JSON.stringify({ winFocused: win.isFocused(), focusedTitle: BrowserWindow.getFocusedWindow()?.getTitle(), dom: await win.webContents.executeJavaScript('({ hasFocus: document.hasFocus(), active: document.activeElement.id, trayHidden: document.getElementById("petTray").hidden, events: window.__standaloneKeyboardEvents })') })}`);
        await until(async () => win.webContents.executeJavaScript('!document.getElementById("petTray").hidden'), 'Enter activates the standalone badge');
        win.webContents.sendInputEvent({ type: 'rawKeyDown', keyCode: 'Escape' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        await until(async () => win.webContents.executeJavaScript('document.getElementById("petTray").hidden'), 'Escape closes the standalone Tasks tray');
        await win.webContents.executeJavaScript('document.getElementById("petStandaloneBadge").focus()');
        win.webContents.sendInputEvent({ type: 'rawKeyDown', keyCode: 'Space' });
        win.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
        await until(async () => win.webContents.executeJavaScript('!document.getElementById("petTray").hidden'), 'Space activates the standalone badge');
        win.webContents.sendInputEvent({ type: 'rawKeyDown', keyCode: 'Escape' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        await until(async () => win.webContents.executeJavaScript('document.getElementById("petTray").hidden'), 'Escape closes the tray after Space activation');
        console.log('standaloneKeyboard=Enter,Space; Escape closes the tray');

        win.webContents.send('pet-overlay:snapshot', {
          visible: true, dismissedPetIds: [], level: 'idle', activities: [], theme: 'dark',
          appearance: {
            light: { background: '#f4f4f5', sidebar: '#e9edf2', accent: '#486f9d', contrast: 45 },
            dark: { background: '#181818', sidebar: '#1a2129', accent: '#b0cbed', contrast: 60 },
            font: 'system', fontSize: 14, translucentSidebar: true
          }
        });
        await until(async () => win.webContents.executeJavaScript('document.getElementById("petStandaloneBadge").textContent === "0"'), 'zero-task standalone badge');
        const zeroBadgeRect = await win.webContents.executeJavaScript('document.getElementById("petStandaloneBadge").getBoundingClientRect().toJSON()');
        const zeroX = Math.round(zeroBadgeRect.x + zeroBadgeRect.width / 2), zeroY = Math.round(zeroBadgeRect.y + zeroBadgeRect.height / 2);
        win.webContents.sendInputEvent({ type: 'mouseMove', x: zeroX, y: zeroY });
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x: zeroX, y: zeroY, clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: zeroX, y: zeroY, clickCount: 1 });
        await until(async () => win.webContents.executeJavaScript('!document.getElementById("petTray").hidden'), 'zero-task badge opens the existing Tasks tray');
        const zeroTasks = await win.webContents.executeJavaScript(`(() => ({
          badgeHidden: document.getElementById('petStandaloneBadge').hidden,
          badgeText: document.getElementById('petStandaloneBadge').textContent,
          trayCount: document.getElementById('petTrayCount').textContent,
          trayHidden: document.getElementById('petTray').hidden
        }))()`);
        assert.deepEqual(zeroTasks, { badgeHidden: false, badgeText: '0', trayCount: '0 tasks', trayHidden: false });
        await win.webContents.executeJavaScript('document.getElementById("petTrayClose").click()');

        const dragRect = await win.webContents.executeJavaScript('document.getElementById("petStandaloneBadge").getBoundingClientRect().toJSON()');
        const target = await win.webContents.executeJavaScript('({ x: Math.min(333, innerWidth - 34), y: Math.min(444, innerHeight - 34) })');
        const dragFromX = Math.round(dragRect.x + dragRect.width / 2), dragFromY = Math.round(dragRect.y + dragRect.height / 2);
        const dragToX = Math.round(target.x + dragRect.width / 2), dragToY = Math.round(target.y + dragRect.height / 2);
        win.webContents.sendInputEvent({ type: 'mouseMove', x: dragFromX, y: dragFromY });
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x: dragFromX, y: dragFromY, clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseMove', x: dragToX, y: dragToY, movementX: dragToX - dragFromX, movementY: dragToY - dragFromY });
        await until(async () => win.webContents.executeJavaScript('document.getElementById("petStandaloneBadge").dataset.dragging === "true"'), 'standalone drag starts');
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: dragToX, y: dragToY, clickCount: 1 });
        const movedStandalone = await win.webContents.executeJavaScript(`(() => ({
          rect: document.getElementById('petStandaloneBadge').getBoundingClientRect().toJSON(),
          saved: localStorage.getItem('cos.ui.petTaskBadge.v1'),
          trayHidden: document.getElementById('petTray').hidden
        }))()`);
        assert.ok(Math.abs(movedStandalone.rect.x - target.x) < 2 && Math.abs(movedStandalone.rect.y - target.y) < 2,
          `Electron input drag did not move the standalone badge: ${JSON.stringify(movedStandalone)}`);
        assert.deepEqual(JSON.parse(movedStandalone.saved), target, "A completed drag must persist the user's chosen position.");
        assert.equal(movedStandalone.trayHidden, true, 'Dragging must not activate the Tasks tray.');

        if (process.platform === 'win32') {
          standaloneOwner.focus();
          await until(async () => standaloneOwner.isFocused(), 'return focus to the owner before testing idle click-through');
          const outside = { x: -1_000_000, y: -1_000_000 };
          const idleStart = ignoredMouseCalls.length;
          win.setIgnoreMouseEvents(false);
          sampledCursor = outside;
          await until(() => ignoredMouseCalls.slice(idleStart).some(call => call.ignore === true), 'standalone idle click-through');
          assert.equal(win.isFocused(), false, 'An idle standalone badge must not retain window focus.');
          const focusedOwner = BrowserWindow.getFocusedWindow();
          assert.equal(focusedOwner, standaloneOwner, 'The idle overlay must leave focus with the CoS owner.');
          const ticksBefore = await standaloneOwner.webContents.executeJavaScript('window.__petBehindTicks');
          await sleep(300);
          const ticksAfter = await standaloneOwner.webContents.executeJavaScript('window.__petBehindTicks');
          assert.ok(ticksAfter - ticksBefore >= 4, `The owner must remain responsive behind an idle standalone badge: ${ticksBefore}->${ticksAfter}`);
          assert.equal(BrowserWindow.getFocusedWindow(), focusedOwner, 'Idle click-through must not steal foreground focus.');
          console.log(`standaloneIdleClickThrough=${JSON.stringify({ ticksBefore, ticksAfter, focused: !win.isFocused() })}`);
        }

        const restoredPet = await standaloneOwner.webContents.executeJavaScript('window.api.petsSetEnabled("capy", true)');
        assert.equal(restoredPet.ok, true, JSON.stringify(restoredPet));
        const disabledStandalone = await standaloneOwner.webContents.executeJavaScript('window.api.petsSetStandaloneTaskBadge(false)');
        assert.equal(disabledStandalone.ok, true, JSON.stringify(disabledStandalone));
        await until(async () => win.webContents.executeJavaScript('document.querySelectorAll(".pet-shell").length === 1 && document.getElementById("petStandaloneBadge").hidden'), 'restore the original pet-only overlay state');
        console.log(`standalone=${JSON.stringify({ coexistence, standaloneTask, zeroTasks, movedStandalone })}`);

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
        await win.webContents.executeJavaScript('document.querySelector(".pet-badge").click()');
        await until(async () => win.webContents.executeJavaScript('!document.getElementById("petTray").hidden'), 'reopen the pet-anchored tray for the existing stacked-task check');
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
            return { x: rect.x, y: rect.y, saved: localStorage.getItem('cos.ui.petDesktop.capy.v1') };
          })()`);
          assert.ok(Math.abs(moved.x - 333) < 2 && Math.abs(moved.y - 444) < 2,
            `Electron input drag did not move the pet: ${JSON.stringify(moved)}`);
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
        assert.ok(titlebar.rect?.height >= 27.5, // fractional scaling measures 28px as 27.998
          `The titlebar needs a real drag row: ${JSON.stringify(titlebar)}`);
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
        assert.equal(hidden[0].data.pets.find(pet => pet.id === 'capy')?.enabled, true,
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
}
provider.listen(0, '127.0.0.1', () => require(path.join(root, 'out/main/index.js')));
