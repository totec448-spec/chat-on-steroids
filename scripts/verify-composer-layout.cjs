// Run with the repository's Electron binary. Uses real Chromium layout and production CSS.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 800,
    webPreferences: { sandbox: true, backgroundThrottling: false } });
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>${css}</style>
    <section id="host" hidden><form id="composer" class="composer">
    <textarea id="chatInput" rows="1" dir="auto" placeholder="Ask anything…"></textarea>
    <div class="composer-toolbar"><button type="button">+</button></div>
    </form></section>`));
  const results = await win.webContents.executeJavaScript(`(() => {
    const input = document.getElementById('chatInput'), host = document.getElementById('host');
    const results = [];
    const record = name => results.push({ name, height: input.clientHeight,
      scrollHeight: input.scrollHeight, scrollTop: input.scrollTop,
      overflow: input.scrollHeight > input.clientHeight });
    host.hidden = false; record('initial reveal');
    input.value = 'Pasted line\\n'.repeat(100); input.scrollTop = input.scrollHeight; record('long paste');
    input.value = ''; record('clear');
    input.value = 'one line'; record('short draft');
    input.value = 'wrapped words '.repeat(25); record('wide draft');
    host.style.width = '320px'; record('narrow draft');
    host.style.width = ''; record('wide again');
    host.hidden = true; input.value = 'restored line\\n'.repeat(5);
    host.hidden = false; record('hidden draft restore');
    input.value = ''; record('empty again');
    return results;
  })()`);
  console.log(JSON.stringify(results, null, 2));
  for (const name of ['initial reveal', 'clear', 'short draft', 'wide draft', 'wide again', 'hidden draft restore', 'empty again']) {
    assert.equal(results.find(r => r.name === name).overflow, false, name + ' must fit without scrolling');
  }
  const long = results.find(r => r.name === 'long paste');
  assert.equal(long.height, 220, 'Long input stays bounded');
  assert.equal(long.overflow, true, 'Long input remains scrollable');
  assert.ok(long.scrollTop > 0, 'Overflowing text can actually scroll');
  assert.equal(results.find(r => r.name === 'clear').scrollTop, 0, 'Clearing also resets the scroll position');
  assert.ok(results.find(r => r.name === 'narrow draft').height > results.find(r => r.name === 'wide draft').height,
    'Width changes must recalculate wrapping without an input event');
  assert.equal(results.at(-1).height, results[0].height, 'Empty input has stable initial and cleared geometry');
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
