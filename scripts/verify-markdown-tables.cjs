/** Synthetic offscreen Chromium geometry check; never opens a user chat. */
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
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { offscreen: true } });
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>${css}</style><div id="fixture" style="margin:20px"><div class="msg rich"><div class="markdown-table"><table><tbody></tbody></table></div></div></div>`));
  const results = await win.webContents.executeJavaScript(`(async () => {
    const fixture = document.getElementById('fixture'), viewport = document.querySelector('.markdown-table'), table = document.querySelector('table');
    const results = [];
    for (const width of [800, 360, 220]) {
      fixture.style.width = width + 'px';
      table.innerHTML = '<tbody><tr><th>Area</th><th>Status</th><th>Details</th></tr><tr><td>Great Hall</td><td>Browser acceptance passed with remaining visual refinements</td><td>' + 'long_filename_'.repeat(30) + '</td></tr></tbody>';
      await new Promise(resolve => requestAnimationFrame(resolve));
      results.push({ width, tableWidth: table.getBoundingClientRect().width, viewportWidth: viewport.clientWidth, outsideOverflow: fixture.scrollWidth > fixture.clientWidth, wrapped: table.rows[1].cells[1].getBoundingClientRect().height > 50 });
    }
    table.innerHTML = '<tbody><tr>' + '<td>x</td>'.repeat(80) + '</tr></tbody>';
    await new Promise(resolve => requestAnimationFrame(resolve));
    results.push({ wide: true, outsideOverflow: fixture.scrollWidth > fixture.clientWidth, scrollable: viewport.scrollWidth > viewport.clientWidth });
    return results;
  })()`);
  for (const row of results) {
    assert.equal(row.outsideOverflow, false, 'A table must not overflow its transcript column');
    if (row.wide) assert.equal(row.scrollable, true, 'Pathological many-column table stays locally scrollable');
    else {
      assert.ok(row.tableWidth <= row.width + 1, 'Ordinary table fits available width');
      assert.equal(row.wrapped, true, 'Long cell text wraps instead of clipping');
    }
  }
  console.log('Markdown table geometry passed at 800/360/220px, including long tokens and 80-column overflow.');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
