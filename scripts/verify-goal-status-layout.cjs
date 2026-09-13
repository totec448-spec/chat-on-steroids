// Isolated Chromium layout probe using the production extension status styles.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cos-goal-layout-')));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 800,
    webPreferences: { sandbox: true, backgroundThrottling: false } });
  const css = fs.readFileSync(path.join(__dirname, '../extension/overlay.css'), 'utf8');
  const errors = fs.readFileSync(path.join(__dirname, '../src/shared/goal-errors.ts'), 'utf8');
  const reason = errors.match(/loop_mcp_call_missing: '([^']+)'/)[1];
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>${css}
    body { background: #171717; color: #eee; font-family: sans-serif; }</style>
    <div class="clf-stage" data-kind="goal-error"><div class="clf-stage-head">
    <span class="clf-stage-title">Loop continuation paused</span>
    <span class="clf-stage-detail">${reason}</span><button class="clf-stage-close">×</button>
    </div><div class="clf-stage-steps">Answer settling · Reading the chat · Writing the reply · Sending</div></div>`));
  const results = [];
  for (const width of [380, 800]) {
    const result = await win.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('.clf-stage'); root.style.width = '${width}px';
      const detail = document.querySelector('.clf-stage-detail');
      const head = document.querySelector('.clf-stage-head');
      const box = root.getBoundingClientRect(), text = detail.getBoundingClientRect();
      return { width: ${width}, text: detail.textContent, lines: text.height / parseFloat(getComputedStyle(detail).lineHeight),
        clipped: detail.scrollHeight > detail.clientHeight || detail.scrollWidth > detail.clientWidth,
        contained: text.left >= box.left && text.right <= box.right && text.bottom <= head.getBoundingClientRect().bottom,
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    })()`);
    assert.equal(result.text, reason);
    assert.equal(result.clipped, false);
    assert.equal(result.contained, true);
    assert.equal(result.documentOverflow, false);
    assert.ok(result.lines > 1);
    results.push(result);
  }
  console.log(JSON.stringify(results, null, 2));
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
