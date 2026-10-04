// Real Chromium layout for the setup guide, using the production modules and styles.
// Serves a UI-only fixture; no app backend, credentials, browser pairing or tunnel is started.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const LANGUAGES = 1 + require('node:fs').readdirSync(path.join(__dirname, '../src/renderer/locales')).filter(name => name.endsWith('.json')).length;
const assert = require('node:assert/strict');
app.setPath('userData', path.resolve(__dirname, '../outputs/setup-guide-runtime'));

app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'outputs/setup-guide');
  fs.mkdirSync(output, { recursive: true });
  // Pixel data and transparency are sufficient for these PNGs; reject embedded metadata.
  for (const name of fs.readdirSync(path.join(root, 'src/renderer/setup-images'))) {
    if (!name.endsWith('.png')) continue;
    const bytes = fs.readFileSync(path.join(root, 'src/renderer/setup-images', name));
    let offset = 8;
    while (offset < bytes.length) {
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      assert.ok(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS'].includes(type), `${name}: unexpected metadata ${type}`);
      offset += bytes.readUInt32BE(offset) + 12;
      if (type === 'IEND') break;
    }
    assert.equal(offset, bytes.length, `${name}: trailing data`);
  }
  const server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'),
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'setup-fixture', configureServer(vite) {
      vite.middlewares.use('/setup-preview.html', async (_request, response) => {
        const source = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace('</body>', `<script type="module">
            import { initSetupGuide } from '/setup-guide.ts';
            import { initLanguage, setLanguage, t } from '/i18n.ts';
            initLanguage(); initSetupGuide(); window.setLanguage = setLanguage; window.t = t;
            document.querySelector('.app').dataset.screen = 'settings';
            for (const p of document.querySelectorAll('.panel')) p.classList.toggle('is-active', p.dataset.panel === 'setup');
            document.getElementById('tabs').hidden = false;
            document.getElementById('desktopTunnelField').hidden = false;
            window.fixtureReady = true;
          </script></body>`);
        response.setHeader('Content-Type', 'text/html');
        response.end(await vite.transformIndexHtml('/setup-preview.html', source));
      });
    } }] });
  let win;
  try {
    await server.listen();
    win = new BrowserWindow({ show: false, width: 1100, height: 900,
      webPreferences: { sandbox: true, backgroundThrottling: false } });
    await win.loadURL(server.resolvedUrls.local[0] + 'setup-preview.html');
    const ready = await win.webContents.executeJavaScript('window.fixtureReady');
    assert.equal(ready, true);
    const results = [];
    for (const [width, height, zoom, language, theme] of [
      [1100, 900, 1, 'en', 'dark'], [800, 650, 1, 'en', 'dark'],
      [1100, 900, 1.5, 'zh-CN', 'light'], [640, 720, 1, 'zh-CN', 'dark'],
      [800, 650, 1, 'es', 'dark'], [800, 650, 1, 'zh-TW', 'light'],
      [1100, 900, 1, 'ja', 'dark'], [1100, 900, 1.5, 'ja', 'light'], [640, 720, 1, 'ja', 'dark'],
      [1100, 900, 1, 'tr', 'dark'], [1100, 900, 1.5, 'tr', 'light'], [640, 720, 1, 'tr', 'dark'],
      [1100, 900, 1, 'fr', 'dark'], [1100, 900, 1.5, 'fr', 'light'], [640, 720, 1, 'fr', 'dark'],
      [1100, 900, 1, 'pt-PT', 'dark'], [1100, 900, 1.5, 'pt-PT', 'light'], [640, 720, 1, 'pt-PT', 'dark'],
      [1100, 900, 1, 'ru', 'dark'], [1100, 900, 1.5, 'ru', 'light'], [640, 720, 1, 'ru', 'dark'],
      [1100, 900, 1, 'vi', 'dark'], [1100, 900, 1.5, 'vi', 'light'], [640, 720, 1, 'vi', 'dark']
    ]) {
      win.setSize(width, height);
      win.webContents.setZoomFactor(zoom);
      await win.webContents.executeJavaScript(`window.setLanguage('${language}')`);
      await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = '${theme}'`);
      const header = await win.webContents.executeJavaScript(`(async () => {
        const panel = document.querySelector('[data-panel="setup"]'); panel.scrollTop = 0;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const tabs = panel.querySelector('.language-tabs'), title = panel.querySelector('.setup-heading h1');
        const bounds = tabs.getBoundingClientRect(), heading = title.getBoundingClientRect();
        const buttons = [...tabs.querySelectorAll('button')];
        return {
          overflow: panel.scrollWidth > panel.clientWidth,
          separated: heading.right <= bounds.left || heading.bottom <= bounds.top,
          // One flag per shipped language (English plus each locale catalog), about 46px each.
          compact: bounds.width <= buttons.length * 46,
          flagsOnly: buttons.length === ${LANGUAGES} && buttons.every(button => !button.textContent.trim() && button.querySelector('svg')),
          labeled: buttons.every(button => button.title && button.title === button.getAttribute('aria-label')),
          selected: buttons.filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.dataset.language),
          reachable: buttons.every(button => {
            const r = button.getBoundingClientRect();
            return r.width >= 36 && r.height >= 32 && r.left >= 0 && r.right <= innerWidth
              && r.top >= 0 && r.bottom <= innerHeight && button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
          })
        };
      })()`);
      assert.deepEqual(header, { overflow:false, separated:true, compact:true, flagsOnly:true, labeled:true, selected:[language], reachable:true }, JSON.stringify({width, zoom, language, header}));
      results.push({ kind:'header', width, zoom, language, theme, ...header });
      // Let the offscreen compositor publish the scrolled header before capturing it.
      await new Promise(resolve => setTimeout(resolve, 100));
      fs.writeFileSync(path.join(output, `${language}-${width}-${zoom}-header.png`), (await win.webContents.capturePage()).toPNG());
      const emptyFields = await win.webContents.executeJavaScript(`(() => {
        return [...document.querySelectorAll('.setup-required')].every(input => {
          const empty = getComputedStyle(input).backgroundColor;
          input.classList.remove('is-empty');
          const filled = getComputedStyle(input).backgroundColor;
          input.classList.add('is-empty');
          return empty !== filled;
        });
      })()`);
      assert.equal(emptyFields, true, 'Empty required fields must have a distinct tint');
      // Each step's pictures sit in a carousel inside that step; only the open step is on screen.
      const groups = await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-setup-guide]')]
        .map(host => [host.dataset.setupGuide, host.querySelectorAll('.guide-frame').length]).filter(([, count]) => count > 0)`);
      assert.ok(groups.length >= 6, 'Setup has its picture guides: ' + JSON.stringify(groups));
      for (const [group, count] of groups) {
        for (let index = 0; index < count; index++) {
          const selector = `[data-setup-guide="${group}"]`;
          const measured = await win.webContents.executeJavaScript(`(async () => {
            const host = document.querySelector('${selector}');
            const step = host.closest('.step');
            for (const other of document.querySelectorAll('.wizard > .step')) other.classList.toggle('is-open', other === step);
            for (let node = host; node && node !== step; node = node.parentElement) node.hidden = false;
            const frames = [...host.querySelectorAll('.guide-frame')];
            host.querySelectorAll('.guide-dot')[${index}]?.click();
            await Promise.all([...host.querySelectorAll('img')].map(img => img.decode()));
            const frame = frames[${index}];
            frame.scrollIntoView({block:'center'});
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const panel = host.closest('.panel');
            const picture = frame.querySelector('.guide-picture').getBoundingClientRect();
            return { imageLoaded: frame.querySelector('img').naturalWidth > 0, overflow: panel.scrollWidth > panel.clientWidth,
              shown: !frame.hidden && picture.height > 0 && frames.filter(other => !other.hidden).length === 1,
              labelled: frame.getAttribute('aria-label') === window.t('Enlarge image'),
              spotsFit: [...frame.querySelectorAll('.guide-spot')].every(n => {
                const r = n.getBoundingClientRect();
                return r.left >= picture.left - 1 && r.right <= picture.right + 1 && r.top >= picture.top - 1 && r.bottom <= picture.bottom + 1;
              })
            };
          })()`);
          assert.deepEqual(measured, { imageLoaded: true, overflow: false, shown: true, labelled: true, spotsFit: true }, JSON.stringify({ group, index, width, zoom, measured }));
          results.push({ group, index, width, zoom, language, theme, ...measured });
          // Image decoding/layout can finish before the offscreen compositor publishes its tile.
          await new Promise(resolve => setTimeout(resolve, 100));
          fs.writeFileSync(path.join(output, `${language}-${width}-${zoom}-${group}-${index}.png`), (await win.webContents.capturePage()).toPNG());
        }
      }
    }
    // Use Chromium's native button activation, then reload to check the new locale.
    await win.webContents.executeJavaScript(`document.querySelector('[data-language="en"]').focus()`);
    const key = async keyCode => {
      win.webContents.sendInputEvent({type:'keyDown', keyCode});
      if (keyCode === 'Enter') win.webContents.sendInputEvent({type:'char', keyCode:'\r'});
      win.webContents.sendInputEvent({type:'keyUp', keyCode});
      await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    };
    // Each step moves focus to another flag and activates it natively (Enter or Space); the page must
    // switch to exactly the focused language. Derived from the live focus, not a fixed flag order.
    const focused = () => win.webContents.executeJavaScript('document.activeElement.dataset.language');
    const lang = () => win.webContents.executeJavaScript('document.documentElement.lang');
    const visited = new Set(['en']);
    let last = 'en';
    for (const [tabs, activation] of [[1, 'Enter'], [2, 'Space'], [1, 'Space'], [1, 'Space']]) {
      for (let i = 0; i < tabs; i++) await key('Tab');
      const target = await focused();
      assert.ok(target && target !== last, 'Tab reaches another language flag: ' + target);
      await key(activation);
      assert.equal(await lang(), target, activation + ' activates the focused language');
      visited.add(target); last = target;
    }
    assert.ok(visited.size >= 4, 'Keyboard reached several languages: ' + [...visited].join(','));
    await win.loadURL(server.resolvedUrls.local[0] + 'setup-preview.html');
    assert.deepEqual(await win.webContents.executeJavaScript(`({language:document.documentElement.lang,
      selected:document.querySelector('[data-language="${last}"]').getAttribute('aria-pressed'),
      preference:document.getElementById('uiLanguage').value})`), {language:last, selected:'true', preference:last});
    // Native modal, Escape dismissal and focus restoration must work without opening a browser.
    await win.webContents.executeJavaScript(`(() => {
      const host=document.querySelector('[data-setup-guide="plugin"]');
      for (const step of document.querySelectorAll('.wizard > .step')) step.classList.toggle('is-open', step === host.closest('.step'));
      host.querySelectorAll('.guide-dot')[1].click();
      const button=host.querySelectorAll('.guide-frame')[1];
      button.focus(); button.click();
    })()`);
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(".setup-image-dialog").open'), true);
    fs.writeFileSync(path.join(output, 'enlarged.png'), (await win.webContents.capturePage()).toPNG());
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESCAPE' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESCAPE' });
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(".setup-image-dialog").open'), false);
    assert.equal(await win.webContents.executeJavaScript('document.activeElement.getAttribute("aria-label")'), await win.webContents.executeJavaScript('window.t("Enlarge image")'));
    const details = await win.webContents.executeJavaScript(`(() => {
      const d=document.getElementById('desktopTunnelField'); const initial=d.open;
      d.querySelector('summary').click(); return { initial, opened:d.open };
    })()`);
    assert.deepEqual(details, { initial: false, opened: true });
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    console.log(`PASS: ${results.length} setup/header layouts; native language keyboard controls and persistence; modal/Escape/focus and optional disclosure.`);
  } finally {
    win?.destroy();
    await server.close();
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
