// Real Electron/Chromium coverage for native customizable selects and production CSS.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 800,
    webPreferences: { sandbox: true, backgroundThrottling: false } });
  const root = path.join(__dirname, '..');
  const output = path.join(root, 'outputs/dropdown-layout');
  fs.mkdirSync(output, { recursive: true });
  const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, '');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html.replace('</head>', `<style>${css}</style></head>`)));
  await win.webContents.executeJavaScript(`(() => {
    const menu = document.querySelector('#composerSettings .composer-popover').cloneNode(true);
    const source = document.getElementById('goalBackend').closest('.setting').cloneNode(true);
    document.body.innerHTML = '';
    const host = document.createElement('main'); host.id = 'fixture'; host.dataset.view = 'settings';
    host.style.cssText = 'padding:32px;max-width:680px;margin:auto';
    const title = document.createElement('h2'); title.textContent = 'Goal & Loop'; host.append(title, source);
    const composer = document.createElement('div'); composer.id = 'composerSettings';
    composer.style.cssText = 'position:relative;width:280px;margin:42px auto';
    menu.style.cssText = 'position:relative;bottom:auto;left:0;translate:none';
    menu.querySelector('#loopDeliveryRow').hidden = false;
    menu.querySelector('#loopDelivery').value = 'after-turn';
    menu.querySelector('#sessionControls').hidden = false;
    menu.querySelector('#sessionObjective').value = 'Keep improving the current task and verify the result.';
    for (const button of menu.querySelectorAll('#automationSwitch [data-mode]'))
      button.setAttribute('aria-checked', String(button.dataset.mode === 'loop'));
    menu.querySelector('label[for="sessionObjective"]').textContent = 'Loop instructions';
    menu.querySelector('#cancelCompaction').hidden = true;
    composer.append(menu); host.append(composer); document.body.append(host);
  })()`);
  win.showInactive();
  const results = [];
  for (const theme of ['dark', 'light']) for (const zoom of [1, 1.5]) {
    win.webContents.setZoomFactor(zoom);
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = '${theme}'; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const measured = await win.webContents.executeJavaScript(`(() => {
      const select = document.getElementById('loopDelivery'), label = document.getElementById('loopDeliveryRow');
      const rect = select.getBoundingClientRect(), parent = label.getBoundingClientRect();
      return { supported: CSS.supports('appearance', 'base-select'), appearance: getComputedStyle(select).appearance,
        width: rect.width, height: rect.height, fits: rect.left >= parent.left && rect.right <= parent.right,
        overflow: select.scrollWidth > select.clientWidth, viewport: innerWidth };
    })()`);
    assert.equal(measured.supported, true);
    assert.equal(measured.appearance, 'base-select');
    assert.equal(measured.fits, true);
    assert.equal(measured.overflow, false);
    results.push({ theme, zoom, ...measured });
    for (const id of ['loopDelivery', 'goalBackend']) {
      await win.webContents.executeJavaScript(`document.getElementById('${id}').showPicker(); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`, true);
      const options = await win.webContents.executeJavaScript(`(() => {
        const select = document.getElementById('${id}');
        const field = select.getBoundingClientRect();
        const first = select.options[0].getBoundingClientRect(), last = select.options[select.options.length - 1].getBoundingClientRect();
        // The picker has 5px padding and a 1px border; its outside edge touches
        // the field even when Chromium flips it above to stay inside the viewport.
        return { open: select.matches(':open'), gap: Math.min(Math.abs(first.top - 6 - field.bottom), Math.abs(last.bottom + 6 - field.top)),
          widthDifference: Math.abs(first.width + 12 - field.width), options: [...select.options].map(option => {
          const rect = option.getBoundingClientRect();
          return { width: rect.width, height: rect.height, fits: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight };
        }) };
      })()`);
      assert.equal(options.open, true, JSON.stringify({ id, theme, zoom, options }));
      assert.ok(options.gap <= 1 && options.widthDifference <= 1, 'Picker must touch and match its field: ' + JSON.stringify(options));
      assert.ok(options.options.every(option => option.width > 0 && option.height >= 30 && option.fits));
      await new Promise(resolve => setTimeout(resolve, 100));
      fs.writeFileSync(path.join(output, `${theme}-${zoom}-${id}.png`), (await win.webContents.capturePage()).toPNG());
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESCAPE' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESCAPE' });
      // Native input is queued: wait for this picker to close before opening the
      // next one, otherwise the previous Escape can dismiss that next picker.
      await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = performance.now() + 3000;
        const check = () => {
          if (!document.getElementById('${id}').matches(':open')) return resolve();
          if (performance.now() >= deadline) return reject(new Error('Picker did not close after Escape'));
          requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      })`);
    }
  }
  // Selection remains a native form action, with one change event and Escape cancellation.
  await win.webContents.executeJavaScript(`(() => {
    const select = document.getElementById('goalBackend'); select.value = 'chatgpt';
    window.changes = 0; select.addEventListener('change', () => window.changes++);
    select.showPicker();
  })()`, true);
  for (const keyCode of ['HOME', 'DOWN', 'ENTER']) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  }
  const selected = await win.webContents.executeJavaScript(`({ value: document.getElementById('goalBackend').value, changes: window.changes })`);
  assert.deepEqual(selected, { value: 'api', changes: 1 });
  const translations = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/zh-CN.json'), 'utf8'));
  await win.webContents.executeJavaScript(`(() => {
    const translations = ${JSON.stringify(translations)};
    for (const option of document.querySelectorAll('select option')) option.textContent = translations[option.textContent] || option.textContent;
    document.getElementById('loopDelivery').showPicker();
  })()`, true);
  const translated = await win.webContents.executeJavaScript(`({ value: document.getElementById('loopDelivery').value,
    fits: [...document.getElementById('loopDelivery').options].every(option => { const r = option.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }) })`);
  assert.deepEqual(translated, { value: 'after-turn', fits: true });
  fs.writeFileSync(path.join(output, 'light-1.5-zh.png'), (await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify(results, null, 2));
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
