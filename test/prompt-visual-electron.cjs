/** Optional offscreen real-Electron visual review of renderer-prompt-visual.test.ts output.
 * Run the fixture-generating Vitest test first. No installed app or ChatGPT tab is opened. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.join(__dirname, '../out/prompt-qa');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], {
    env, encoding: 'utf8', windowsHide: true
  });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.join(output, 'electron-profile'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1150, height: 940, webPreferences: { offscreen: true } });
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
  const fragments = fs.readFileSync(path.join(output, 'actual-renderer-fragments.html'), 'utf8');
  const markup = `<!doctype html><meta charset="utf-8"><style>${css}
    body { padding: 20px; color: #202020; background: #fff; }
    .qa-root { max-width: 690px; margin:auto; }
    .qa-section { border-bottom: 1px solid #ddd; padding: 10px 0 24px; }
    .qa-section + .qa-section { padding-top: 28px; }
    .native-prompt-readonly { max-width: 100%; }
    </style><main class="qa-root">${fragments}</main>`;
  await win.loadURL('data:text/html;base64,' + Buffer.from(markup).toString('base64'));
  for (const width of [1000, 520]) {
    win.setSize(width, 940);
    const state = await win.webContents.executeJavaScript(`(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const root = document.querySelector('.qa-root');
      const cards = [...document.querySelectorAll('.native-prompt-readonly')];
      return {
        width: innerWidth, renderedSections: document.querySelectorAll('.qa-section').length,
        heading: document.querySelector('h2')?.textContent,
        code: document.querySelectorAll('code').length,
        readOnlyCards: cards.length,
        prompts: cards.map(card => card.textContent),
        forbiddenControls: document.querySelectorAll('form, input, button, textarea, select, [role="radio"], [onclick]').length,
        overflow: root.scrollWidth > root.clientWidth + 1,
        cardWidths: cards.map(card => ({ width: card.getBoundingClientRect().width, visible: card.getBoundingClientRect().height > 0 }))
      };
    })()`);
    assert.equal(state.renderedSections, 3);
    assert.equal(state.heading, 'Examples from sample data');
    assert.equal(state.code, 4);
    assert.equal(state.readOnlyCards, 2);
    assert.equal(state.forbiddenControls, 0);
    assert.equal(state.overflow, false);
    assert.ok(state.cardWidths.every(card => card.visible));
    assert.ok(state.prompts.some(text => text.includes('Merge strong matches only')));
    assert.ok(state.prompts.some(text => text.includes('Merge the records')));
    const screenshot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(output, `rendered-${width}px.png`), screenshot.toPNG());
    console.log(JSON.stringify(state));
  }
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
