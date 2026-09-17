// Isolated Chromium hit testing of the production connection overlay and CSS.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/connection-layer');
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
    for (const translucent of [false, true]) for (const files of [false, true]) {
      const result = await win.webContents.executeJavaScript(`(() => {
        const $ = id => document.getElementById(id);
        document.documentElement.dataset.translucentSidebar = '${translucent}';
        document.documentElement.style.setProperty('--sidebar-color', '#1a2129');
        document.querySelector('[data-panel="chat"]').classList.toggle('has-file-panel', ${files});
        const popup = $('connectionPopover');
        popup.hidden = false;
        // Fixed overlap reproduces the reported paint boundary independently of window size.
        const composer = document.querySelector('.composer');
        composer.style.cssText = 'position:fixed;left:250px;bottom:24px;width:400px;height:130px;display:block';
        popup.style.cssText = 'left:100px;bottom:56px;width:300px';
        document.querySelector('.connection-anchor').append(popup);
        const hit = () => popup.contains(document.elementFromPoint(275, innerHeight - 100));
        const before = hit();
        ${relocation}
        return { before, after: hit(), outsideSidebar: popup.parentElement === document.body };
      })()`);
      assert.equal(result.after, true, JSON.stringify({ translucent, files, result }));
      assert.equal(result.outsideSidebar, true);
      if (translucent) assert.equal(result.before, false, 'Must reproduce the original occlusion');
      results.push({ translucent, files, ...result });
    }
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    console.log('Connection overlay hit tests passed: ' + JSON.stringify(results));
  } finally { win.destroy(); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
