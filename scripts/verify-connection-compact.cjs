// Isolated Chromium hit testing of the production connection overlay and CSS.
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
    const results = [];
    await win.webContents.executeJavaScript(`(() => {
      const $ = id => document.getElementById(id);
      ${relocation}
      document.documentElement.dataset.theme = 'dark';
      const popup = $('connectionPopover');
      popup.hidden = false;
      popup.classList.add('is-connected');
      popup.style.left = '100px';
      $('connectionPopoverTitle').textContent = 'Connected';
      $('connectionPopoverToggle').textContent = 'Disconnect';
      $('connectionPopoverConnector').textContent = 'Waiting for ChatGPT';
      $('connectionPopoverBrowser').textContent = 'Connected';
      $('connectionPopoverExtension').textContent = 'v2.1.13';
      for (const row of document.querySelectorAll('.connection-advanced-row')) row.classList.add('is-ok');
      $('connectionAdvancedApp').querySelector('.meta').textContent = 'ID confirmed';
    })()`);
    fs.mkdirSync(output, { recursive: true });
    for (const open of [false, true]) {
      await win.webContents.executeJavaScript(`document.getElementById('connectionAdvanced').open = ${open}`);
      const result = await win.webContents.executeJavaScript(`(() => {
        const popup = document.getElementById('connectionPopover');
        const rect = popup.getBoundingClientRect();
        const style = getComputedStyle(popup);
        const clipped = [...popup.querySelectorAll('.connection-popover-row > span')].filter(el => el.scrollWidth > el.clientWidth).map(el => el.textContent);
        const summary = document.querySelector('#connectionAdvanced > summary');
        return { width: rect.width, height: rect.height, clipped, blur: style.backdropFilter,
          summaryHit: summary.contains(document.elementFromPoint(summary.getBoundingClientRect().x + 12, summary.getBoundingClientRect().y + 12)),
          pipelineHidden: !document.getElementById('connectionPipeline').checkVisibility(),
          x: rect.x, y: rect.y };
      })()`);
      assert.equal(result.width, 220);
      assert.ok(result.height < (open ? 360 : 160), JSON.stringify(result));
      assert.deepEqual(result.clipped, []);
      assert.equal(result.summaryHit, true);
      assert.equal(result.pipelineHidden, true);
      assert.equal(result.blur, 'blur(18px)');
      results.push({ open, ...result });
      await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const png = await win.webContents.capturePage({ x: result.x - 20, y: result.y - 20, width: result.width + 40, height: Math.ceil(result.height) + 40 });
      fs.writeFileSync(path.join(output, open ? 'expanded.png' : 'compact.png'), png.toPNG());
    }
    await win.webContents.executeJavaScript(`document.getElementById('connectionRuntime').open = true`);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('connectionPipeline').checkVisibility()`), true);
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    console.log('Compact connection layout passed: ' + JSON.stringify(results));
  } finally { win.destroy(); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });

