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
    for (const width of [1000, 640, 430]) for (const images of [false, true]) {
      fixture.style.width = width + 'px';
      const attachments = document.getElementById('composerImages');
      attachments.hidden = !images;
      attachments.textContent = 'Example image'; attachments.style.height = '60px';
      await new Promise(resolve => requestAnimationFrame(resolve));
      const gear = rect('#composerSettings > summary'), circle = rect('#contextMeterButton'), tooltip = rect('#contextMeterInfo'), input = rect('#chatInput'), send = rect('#chatSend');
      output.push({width, images, gap: circle.left - gear.right, centerDifference: Math.abs((circle.top + circle.bottom - gear.top - gear.bottom) / 2), tooltipAnchor: Math.abs(tooltip.right - circle.right), toolbarBelowInput: circle.top >= input.bottom, sendAligned: Math.abs((send.top + send.bottom - circle.top - circle.bottom) / 2) < 1, overflow: fixture.scrollWidth > fixture.clientWidth});
    }
    return output;
  })()`);
  for (const row of results) {
    assert.ok(row.gap >= 1 && row.gap <= 4, JSON.stringify(row));
    assert.ok(row.centerDifference < 1, 'Circle and gear share their vertical center');
    assert.ok(row.tooltipAnchor < 1, 'Tooltip remains anchored to circle');
    assert.equal(row.toolbarBelowInput, true);
    assert.equal(row.sendAligned, true);
    assert.equal(row.overflow, false);
  }
  console.log('Composer geometry passed at1000/640/430px with/without attachments:2px gear-circle gap, centered row and anchored tooltip.');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
