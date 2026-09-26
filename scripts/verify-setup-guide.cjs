// Real Chromium layout for the setup guide, using the production modules and styles.
// Serves a UI-only fixture; no app backend, credentials, browser pairing or tunnel is started.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
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
          .replace('</head>', '<link rel="stylesheet" href="/icons.css" /></head>')
          .replace('</body>', `<script type="module">
            import { initSetupGuide } from '/setup-guide.ts';
            import { initLanguage, setLanguage, t } from '/i18n.ts';
            initLanguage(); initSetupGuide(); window.setLanguage = setLanguage; window.t = t;
            document.querySelector('.app').dataset.screen = 'settings';
            for (const p of document.querySelectorAll('.panel')) p.classList.toggle('is-active', p.dataset.panel === 'setup');
            document.getElementById('tabs').hidden = false;
            document.getElementById('desktopTunnelField').hidden = false;
            // Representative visual states only; the production state owner is main.ts.
            document.querySelector('[data-step="folder"]').classList.add('is-done');
            document.querySelector('[data-step="tunnel"]').classList.add('is-current');
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
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    const results = [];
    for (const [width, height, zoom, language, theme] of [
      [1400, 900, 1, 'en', 'dark'], [1100, 900, 1, 'en', 'dark'], [800, 650, 1, 'en', 'dark'],
      [1100, 900, 1.5, 'zh-CN', 'light'], [640, 720, 1, 'zh-CN', 'dark'],
      [800, 650, 1, 'es', 'dark'], [800, 650, 1, 'zh-TW', 'light'],
      [1100, 900, 1, 'ja', 'dark'], [1100, 900, 1.5, 'ja', 'light'], [640, 720, 1, 'ja', 'dark'],
      [1100, 900, 1, 'tr', 'dark'], [1100, 900, 1.5, 'tr', 'light'], [640, 720, 1, 'tr', 'dark'],
      [1100, 900, 1, 'fr', 'dark'], [1100, 900, 1.5, 'fr', 'light'], [640, 720, 1, 'fr', 'dark']
    ]) {
      win.setSize(width, height);
      win.webContents.setZoomFactor(zoom);
      await win.webContents.executeJavaScript(`window.setLanguage('${language}')`);
      await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = '${theme}'`);
      const page = await win.webContents.executeJavaScript(`(() => {
        const panel = document.querySelector('[data-panel="setup"]');
        panel.scrollTop = 0;
        const header = panel.querySelector('.setup-heading').getBoundingClientRect();
        const wizard = panel.querySelector('.wizard').getBoundingClientRect();
        const languages = panel.querySelector('.language-tabs').getBoundingClientRect();
        const steps = [...panel.querySelectorAll('.wizard > .step')];
        const first = steps[0].getBoundingClientRect();
        const second = steps[1].getBoundingClientRect();
        const doneMark = steps[0].querySelector('.step-mark');
        const panelStyle = getComputedStyle(panel);
        const available = panel.clientWidth - parseFloat(panelStyle.paddingLeft) - parseFloat(panelStyle.paddingRight);
        return {
          overflow: panel.scrollWidth > panel.clientWidth,
          aligned: Math.abs(header.left - wizard.left) < 1 && Math.abs(header.right - wizard.right) < 1,
          canvasWidth: Math.round(wizard.width),
          canvasWidthMatches: Math.abs(wizard.width - Math.min(940, available)) < 1.5,
          languagesFit: languages.left >= header.left - 1 && languages.right <= header.right + 1,
          separateCards: getComputedStyle(panel.querySelector('.wizard')).borderTopWidth === '0px'
            && steps.every(step => parseFloat(getComputedStyle(step).borderTopWidth) > 0
              && getComputedStyle(step).borderTopLeftRadius !== '0px')
            && second.top - first.bottom >= 8,
          doneCheck: getComputedStyle(doneMark.querySelector('.tick')).display !== 'none'
            && getComputedStyle(doneMark.querySelector('.tick'), '::before').content !== 'none'
            && getComputedStyle(doneMark, '::before').display === 'none'
            && getComputedStyle(doneMark).color !== getComputedStyle(steps[0]).color,
          numbered: [...panel.querySelectorAll('.step-mark')].every(mark => getComputedStyle(mark, '::before').content === 'counter(setup-step)')
        };
      })()`);
      assert.deepEqual(page, { overflow: false, aligned: true,
        canvasWidth: width === 1400 && zoom === 1 ? 940 : page.canvasWidth,
        canvasWidthMatches: true, languagesFit: true, separateCards: true, doneCheck: true, numbered: true },
        JSON.stringify({ width, zoom, language, page }));
      const header = await win.webContents.executeJavaScript(`(async () => {
        const panel = document.querySelector('[data-panel="setup"]'); panel.scrollTop = 0;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const tabs = panel.querySelector('.language-tabs'), title = panel.querySelector('.setup-heading > div:first-child');
        const bounds = tabs.getBoundingClientRect(), heading = title.getBoundingClientRect();
        const buttons = [...tabs.querySelectorAll('button')];
        return {
          overflow: panel.scrollWidth > panel.clientWidth,
          separated: heading.right <= bounds.left || heading.bottom <= bounds.top,
          compact: bounds.width <= 330,
          flagsOnly: buttons.length === 7 && buttons.every(button => !button.textContent.trim() && button.querySelector('svg')),
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
      fs.writeFileSync(path.join(output, `${language}-${width}-${zoom}-top.png`), (await win.webContents.capturePage()).toPNG());
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
      for (const [group, count] of [['tunnel', 1], ['key', 1], ['developer', 1], ['plugin', 2]]) {
        for (let index = 0; index < count; index++) {
          const selector = `[data-setup-guide="${group}"]`;
          const measured = await win.webContents.executeJavaScript(`(async () => {
            const host = document.querySelector('${selector}');
            const figures = host.querySelectorAll('.setup-figure');
            await Promise.all([...host.querySelectorAll('img')].map(img => img.decode()));
            const figure = figures[${index}];
            const img = figure.querySelector('img');
            (${count} > 1 && host.offsetHeight < innerHeight ? host : figure).scrollIntoView({block:'center'});
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const panel = host.closest('.panel'); const frame = figure.querySelector('.setup-shot').getBoundingClientRect();
            return { imageLoaded: img.naturalWidth > 0, overflow: panel.scrollWidth > panel.clientWidth,
              imagesVisible: figures.length === ${count} && [...figures].every(n => n.getBoundingClientRect().height > 0),
              captionTranslated: host.querySelector('figcaption p').textContent === window.t(${JSON.stringify('Select the workspace you use in ChatGPT, then create the tunnel and copy its ID.')}) || '${group}' !== 'tunnel',
              labelsFit: [...figure.querySelectorAll('.setup-callout, .setup-target')].every(n => {
                const r=n.getBoundingClientRect(); return r.left >= frame.left - 1 && r.right <= frame.right + 1 && r.top >= frame.top - 1 && r.bottom <= frame.bottom + 1;
              }),
              pairLayout: ${count} === 1 || (host.clientWidth > 510
                ? Math.abs(figures[0].getBoundingClientRect().top - figures[1].getBoundingClientRect().top) < 1
                : figures[1].getBoundingClientRect().top > figures[0].getBoundingClientRect().bottom)
            };
          })()`);
          assert.deepEqual(measured, { imageLoaded: true, overflow: false, imagesVisible: true, captionTranslated: true, labelsFit: true, pairLayout: true }, JSON.stringify({ group, index, width, zoom, measured }));
          results.push({ group, index, width, zoom, language, theme, ...measured });
          // Image decoding/layout can finish before the offscreen compositor publishes its tile.
          await new Promise(resolve => setTimeout(resolve, 100));
          fs.writeFileSync(path.join(output, `${language}-${width}-${zoom}-${group}-${index}.png`), (await win.webContents.capturePage()).toPNG());
          if (width === 1100 && zoom === 1) {
            const rect = await win.webContents.executeJavaScript(`(() => {
              const r=document.querySelectorAll('${selector} .setup-shot')[${index}].getBoundingClientRect();
              return r.top >= 0 && r.bottom <= innerHeight ? { x:Math.round(r.x), y:Math.round(r.y), width:Math.round(r.width), height:Math.round(r.height) } : null;
            })()`);
            if (rect) fs.writeFileSync(path.join(output, `overlay-${group}-${index}.png`), (await win.webContents.capturePage(rect)).toPNG());
          }
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
    await key('Tab');
    assert.equal(await win.webContents.executeJavaScript('document.activeElement.dataset.language'), 'es');
    await key('Enter');
    assert.equal(await win.webContents.executeJavaScript('document.documentElement.lang'), 'es');
    await key('Tab'); await key('Tab');
    assert.equal(await win.webContents.executeJavaScript('document.activeElement.dataset.language'), 'ja');
    await key('Space');
    assert.equal(await win.webContents.executeJavaScript('document.documentElement.lang'), 'ja');
    await key('Tab'); await key('Space');
    assert.equal(await win.webContents.executeJavaScript('document.documentElement.lang'), 'tr');
    await key('Tab'); await key('Space');
    assert.equal(await win.webContents.executeJavaScript('document.documentElement.lang'), 'fr');
    await win.loadURL(server.resolvedUrls.local[0] + 'setup-preview.html');
    assert.deepEqual(await win.webContents.executeJavaScript(`({language:document.documentElement.lang,
      selected:document.querySelector('[data-language="fr"]').getAttribute('aria-pressed'),
      preference:document.getElementById('uiLanguage').value})`), {language:'fr', selected:'true', preference:'fr'});
    // Native modal, Escape dismissal and focus restoration must work without opening a browser.
    await win.webContents.executeJavaScript(`(() => {
      const button=document.querySelectorAll('[data-setup-guide="plugin"] .setup-enlarge')[1];
      button.focus(); button.click();
    })()`);
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(".setup-image-dialog").open'), true);
    fs.writeFileSync(path.join(output, 'enlarged.png'), (await win.webContents.capturePage()).toPNG());
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESCAPE' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESCAPE' });
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(".setup-image-dialog").open'), false);
    assert.equal(await win.webContents.executeJavaScript('document.activeElement.textContent'), await win.webContents.executeJavaScript('window.t("Enlarge image")'));
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
