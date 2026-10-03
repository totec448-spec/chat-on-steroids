// Isolated Chromium layout and hit testing of the production connection popover.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/connection-compact');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { sandbox: true } });
  try {
    const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
    const main = fs.readFileSync(path.join(root, 'src/renderer/main.ts'), 'utf8');
    const relocation = main.match(/document\.body\.append\(\$\('connectionPopover'\)\);/)?.[0];
    assert.ok(relocation, 'Production initialization must escape the sidebar containing block');
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html.replace('</head>', `<style>${css}</style></head>`)));
    await win.webContents.executeJavaScript(`(() => {
      const $ = id => document.getElementById(id);
      ${relocation}
      $('connectionPopover').hidden = false;
    })()`);
    fs.mkdirSync(output, { recursive: true });
    const results = [];
    const states = [
      { name: 'disconnected', title: 'Not connected', action: 'Connect', tone: '', connector: 'bad', browser: 'bad' },
      { name: 'connected', title: 'Connected', action: 'Disconnect', tone: 'is-connected', connector: 'ok', browser: 'ok' },
      { name: 'connecting', title: 'Connecting', action: 'Disconnect', tone: 'is-busy', connector: 'wait', browser: 'wait' },
      { name: 'offline', title: 'No internet', action: 'Disconnect', tone: 'is-offline', connector: 'bad', browser: 'ok' }
    ];
    // Same markup/styles across state, language, theme, sidebar tint, text size and zoom.
    for (const language of ['en', 'pt-BR', 'fr', 'ja']) {
      const catalog = language === 'en' ? {} : JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales', language + '.json'), 'utf8'));
      const t = key => catalog[key] ?? key;
      for (const theme of ['dark', 'light']) for (const zoom of [1.17, 1.5]) for (const state of states) {
        win.webContents.setZoomFactor(zoom);
        const fixture = { ...state, title: t(state.title), action: t(state.action), chat: t('ChatGPT'), browserLabel: t('Browser companion'), theme, textScale: zoom === 1.5 ? 1.5 : 1 };
        const result = await win.webContents.executeJavaScript(`(() => {
          const $ = id => document.getElementById(id);
          const fixture = ${JSON.stringify(fixture)};
          document.documentElement.dataset.theme = fixture.theme;
          document.documentElement.dataset.translucentSidebar = 'true';
          document.documentElement.style.setProperty('--sidebar-color', fixture.theme === 'dark' ? '#1a2129' : '#eef4ff');
          document.documentElement.style.setProperty('--text-scale', fixture.textScale);
          const popup = $('connectionPopover');
          popup.className = 'connection-popover scroll ' + fixture.tone;
          popup.style.left = '100px';
          $('connectionPopoverTitle').textContent = fixture.title;
          $('connectionPopoverToggle').textContent = fixture.action;
          const rows = [...popup.querySelectorAll('.connection-popover-row')];
          rows[0].dataset.tone = fixture.connector;
          rows[1].dataset.tone = fixture.browser;
          rows[0].firstElementChild.textContent = fixture.chat;
          rows[1].firstElementChild.textContent = fixture.browserLabel;
          const rect = popup.getBoundingClientRect();
          const style = getComputedStyle(popup);
          const button = $('connectionPopoverToggle');
          const target = button.getBoundingClientRect();
          const clipped = [...popup.querySelectorAll('strong, .connection-popover-row > span:not(.sr-only), button')]
            .filter(el => el.scrollWidth > el.clientWidth).map(el => el.textContent);
          return { width: rect.width, height: rect.height, clipped, blur: style.backdropFilter,
            inside: rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
            buttonHit: button.contains(document.elementFromPoint(target.x + target.width / 2, target.y + target.height / 2)),
            advanced: popup.querySelector('details') !== null,
            subtitle: $('connectionPopoverVerified') !== null,
            buttons: popup.querySelectorAll('button').length,
            x: rect.x, y: rect.y };
        })()`);
        assert.ok(Math.abs(result.width - 160) < 1, JSON.stringify(result));
        assert.equal(result.inside, true, JSON.stringify({ language, theme, zoom, ...result }));
        assert.deepEqual(result.clipped, []);
        assert.equal(result.buttonHit, true);
        assert.equal(result.advanced, false);
        assert.equal(result.subtitle, false);
        assert.equal(result.buttons, 1);
        assert.equal(result.blur, 'blur(22px) saturate(1.25)');
        results.push({ language, theme, zoom, state: state.name, ...result });
        if (language === 'en' && theme === 'dark' && zoom === 1.17) {
          await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
          await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
          const png = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
          fs.writeFileSync(path.join(output, state.name + '.png'), png.toPNG());
        }
      }
    }
    // Both surfaces share custom tint and the same translucent/opaque preference.
    for (const color of ['#35234c', '#eef4ff']) for (const translucent of [true, false]) {
      const themed = await win.webContents.executeJavaScript(`(() => {
        document.documentElement.style.setProperty('--sidebar-color', '${color}');
        document.documentElement.dataset.translucentSidebar = '${translucent}';
        const popup = document.getElementById('connectionPopover');
        const actual = getComputedStyle(popup), expected = getComputedStyle(document.querySelector('.sidebar'));
        const same = actual.background === expected.background && actual.backdropFilter === expected.backdropFilter;
        return { same, width: popup.getBoundingClientRect().width, overflow: popup.scrollWidth > popup.clientWidth };
      })()`);
      assert.equal(themed.same, true);
      assert.ok(Math.abs(themed.width - 160) < 1, JSON.stringify(themed));
      assert.equal(themed.overflow, false);
    }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    console.log('Compact connection layout passed: ' + results.length + ' state/language/theme/zoom combinations.');
  } finally { win.destroy(); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
