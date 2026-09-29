/** Current composer markup/CSS in offscreen Chromium; no installed app interaction. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { offscreen: true } });
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const composer = html.match(/<form class="composer"[\s\S]*?<\/form>/)[0];
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>${css}</style><div id="fixture" style="margin:250px 20px 0">${composer}</div>`));
  const results = await win.webContents.executeJavaScript(`(async () => {
    const fixture = document.getElementById('fixture');
    const rect = selector => document.querySelector(selector).getBoundingClientRect();
    const output = [];
    document.getElementById('contextMeter').classList.add('pinned');
    // 560px is below the narrowest real composer: the 640px minimum window leaves it about 600px wide.
    for (const width of [1000, 640, 560]) for (const images of [false, true]) {
      fixture.style.width = width + 'px';
      const attachments = document.getElementById('composerImages');
      attachments.hidden = !images;
      attachments.textContent = 'Example image'; attachments.style.height = '60px';
      await new Promise(resolve => requestAnimationFrame(resolve));
      const model = document.getElementById('composerModelLabel').closest('summary').getBoundingClientRect(), circle = rect('#contextMeterButton'), tooltip = rect('#contextMeterInfo'), input = rect('#chatInput'), send = rect('#chatSend');
      output.push({width, images, gap: model.left - circle.right, centerDifference: Math.abs((circle.top + circle.bottom - model.top - model.bottom) / 2),
        tooltipEdgeDifference: Math.abs(tooltip.right - circle.right),
        tooltipInViewport: tooltip.left >= 0 && tooltip.right <= document.documentElement.clientWidth && tooltip.top >= 0 && tooltip.bottom <= document.documentElement.clientHeight,
        toolbarBelowInput: circle.top >= input.bottom, sendAligned: Math.abs((send.top + send.bottom - circle.top - circle.bottom) / 2) < 1, overflow: fixture.scrollWidth > fixture.clientWidth});
    }
    return output;
  })()`);
  for (const row of results) {
    // Since the 2026-09-28 composer refresh the ring sits beside the model picker and its dialog opens right-aligned to it.
    assert.ok(row.gap >= 4 && row.gap <= 12, JSON.stringify(row));
    assert.ok(row.centerDifference < 1, 'Circle and model picker share their vertical center');
    assert.ok(row.tooltipEdgeDifference < 1, 'Context dialog is right-aligned to the context circle');
    assert.equal(row.tooltipInViewport, true, 'Tooltip remains within the visible viewport');
    assert.equal(row.toolbarBelowInput, true);
    assert.equal(row.sendAligned, true);
    assert.equal(row.overflow, false);
  }
  console.log('Composer geometry passed at 1000/640/560px with/without attachments: ring beside the model picker, centered row, right-aligned visible context dialog.');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
