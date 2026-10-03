// Run after npm run build. Production markup/styles in isolated Chromium; no app preload,
// bridge or user profile. Built assets resolve Phosphor fonts exactly as the shipped UI does.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/navigation-motion');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  const html = fs.readFileSync(path.join(root, 'out/renderer/index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'out/renderer/')).href}">`);
  const fixture = path.join(output, 'fixture.html');
  fs.writeFileSync(fixture, html);
  const win = new BrowserWindow({ show: false, width: 1000, height: 850, webPreferences: { sandbox: true } });
  try {
    await win.loadFile(fixture);
    const js = code => win.webContents.executeJavaScript(code);
    await js(`document.fonts.ready;`);
    assert.equal(await js(`document.fonts.check('16px "CoS Phosphor"')`), true);
    await win.webContents.debugger.attach('1.3');
    for (const reduced of [false, true]) {
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }]
      });
      for (const theme of ['dark', 'light']) for (const width of [760, 1200]) {
        win.setSize(width, 850);
        await js(`document.documentElement.dataset.theme = '${theme}';`);
        const names = await js(`(() => {
          const app = document.querySelector('.app');
          const panel = document.querySelector('[data-panel="chat"]');
          const view = document.querySelector('[data-view="settings"]');
          const name = el => getComputedStyle(el).animationName;
          app.dataset.screen = 'settings'; view.hidden = false;
          document.querySelector('#tabs').hidden = false;
          const settings = [name(panel), name(view), name(document.querySelector('#tabs'))];
          app.dataset.screen = 'chat'; view.hidden = true;
          document.querySelector('#tabs').hidden = true;
          const sidebar = [name(document.querySelector('.sidebar-sessions')), name(document.querySelector('#sidebarPrimary'))];
          const popup = document.querySelector('#connectionPopover');
          document.body.append(popup); popup.style.left = '100px'; popup.style.bottom = '40px';
          popup.hidden = false;
          const compact = name(popup);
          // Interrupt a reveal and reopen. No delayed callback may hide the new surface.
          popup.hidden = true; void popup.offsetHeight;
          popup.hidden = false;
          return { settings, sidebar, compact };
        })()`);
        assert.deepEqual(names, reduced
          ? { settings: ['none', 'none', 'none'], sidebar: ['none', 'none'], compact: 'none' }
          : { settings: ['none', 'surface-in', 'sidebar-content-in'], sidebar: ['sidebar-content-in', 'sidebar-content-in'], compact: 'surface-in' });
        await js('Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})))');
        const navigation = await js(`(() => {
          const app = document.querySelector('.app');
          const sidebar = ['.sidebar-sessions', '#sidebarPrimary'].map(s => document.querySelector(s));
          const running = () => sidebar.flatMap(el => el.getAnimations()).filter(a => a.playState !== 'finished').length;
          // Plugins, Skills and Pets share the library screen; none replaces the sidebar.
          const libraryReturns = ['plugins', 'skills', 'pets'].map(page => {
            app.dataset.screen = 'library';
            document.querySelectorAll('.panel').forEach(p => p.classList.toggle('is-active', p.dataset.panel === page));
            void app.offsetHeight;
            const entering = running();
            app.dataset.screen = 'chat';
            document.querySelectorAll('.panel').forEach(p => p.classList.toggle('is-active', p.dataset.panel === 'chat'));
            void app.offsetHeight;
            return [entering, running()];
          });
          app.dataset.screen = 'settings'; void app.offsetHeight;
          app.dataset.screen = 'chat'; void app.offsetHeight;
          const returningFromSettings = running();
          const animations = sidebar.flatMap(el => el.getAnimations());
          app.dataset.screen = 'library'; void app.offsetHeight;
          app.dataset.screen = 'chat'; void app.offsetHeight;
          const uninterrupted = sidebar.flatMap(el => el.getAnimations()).every((a, i) => a === animations[i]);
          return { libraryReturns, returningFromSettings, uninterrupted };
        })()`);
        assert.deepEqual(navigation, {
          libraryReturns: [[0, 0], [0, 0], [0, 0]],
          returningFromSettings: reduced ? 0 : 2,
          uninterrupted: true
        });
        const settled = await js(`(() => {
          const el = document.querySelector('#connectionPopover'), rect = el.getBoundingClientRect();
          const button = document.querySelector('#connectionPopoverToggle'), r = button.getBoundingClientRect();
          return { visible: el.checkVisibility(), transform: getComputedStyle(el).transform,
            overflow: el.scrollWidth > el.clientWidth, inside: rect.x >= 0 && rect.right <= innerWidth,
            hit: button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
        })()`);
        assert.deepEqual(settled, { visible: true, transform: 'none', overflow: false, inside: true, hit: true });
        if (!reduced) fs.writeFileSync(path.join(output, `${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
    console.log('Navigation motion passed: two themes, two widths, reduced motion, library/chat continuity, Settings return and interrupted reopen.');
  } finally { win.destroy(); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
