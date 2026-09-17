/** Real Chromium regression: repainting labels must release retired row data.
 * node scripts/verify-renderer-label-memory.cjs [--baseline <old i18n.ts>]
 * Synthetic rows only; no production bridge, preload or user data. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    env, encoding: 'utf8', windowsHide: true, timeout: 90000,
  });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.resolve(__dirname, '../outputs/renderer-label-memory-runtime'));
app.commandLine.appendSwitch('js-flags', '--expose-gc');
app.whenReady().then(async () => {
  const root = path.join(__dirname, '..');
  const baseline = process.argv.indexOf('--baseline');
  const bundle = process.argv.indexOf('--bundle');
  const source = fs.readFileSync(baseline < 0 ? path.join(root, 'src/renderer/i18n.ts') : process.argv[baseline + 1], 'utf8');
  const code = bundle >= 0 ? fs.readFileSync(process.argv[bundle + 1], 'utf8') : require('esbuild').buildSync({
    stdin: { contents: source, resolveDir: path.join(root, 'src/renderer'), loader: 'ts' },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'labels',
  }).outputFiles[0].text;
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
  const deadline = setTimeout(() => { console.error('Renderer label stress timed out'); win.destroy(); app.exit(1); }, 60000);
  try {
    await win.loadURL('data:text/html,<main id="rows"></main>');
    await win.webContents.executeJavaScript(code + '\n;void 0;');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('HeapProfiler.collectGarbage');
    const before = await win.webContents.debugger.sendCommand('Runtime.getHeapUsage');
    const times = [];
    let during;
    // Each refresh is a separate task. Collection at the end of the repaint
    // models allocation pressure while rendering, when dereferenced WeakRefs
    // are still kept alive by V8. Do not mask that with an idle GC between rows.
    for (let round = 0; round < 80; round++) {
      times.push(await win.webContents.executeJavaScript(`(() => {
        const start = performance.now();
        const rows = document.getElementById('rows');
        rows.replaceChildren();
        for (let i = 0; i < 512; i++) {
          const metadata = Array.from({length: 256}, (_, at) => at + i);
          const node = labels.ui(document.createElement('button'), 'title', () => labels.t('Remove {0}', [metadata[0]]));
          rows.append(node);
        }
        gc();
        return performance.now() - start;
      })()`));
      if (round === 39 || round === 79) {
        const memory = await win.webContents.debugger.sendCommand('Runtime.getHeapUsage');
        if (round === 39) during = memory;
        else {
          const result = { rounds: 80, rowsPerRound: 512,
            heapBeforeMiB: before.usedSize / 2 ** 20, heapMidMiB: during.usedSize / 2 ** 20,
            heapAfterMiB: memory.usedSize / 2 ** 20, lateGrowthMiB: (memory.usedSize - during.usedSize) / 2 ** 20,
            firstPaintMs: times[0], lastPaintMs: times.at(-1),
          };
          console.log(JSON.stringify(result, null, 2));
          assert.ok(result.lateGrowthMiB < 8, 'Retired row bindings grew by at least 8 MiB in the second half');
          assert.ok(result.heapAfterMiB - result.heapBeforeMiB < 16, 'Retired row data accumulated in the renderer');
        }
      }
    }
    const translated = await win.webContents.executeJavaScript(`(() => {
      labels.setLanguage('zh-CN');
      return document.querySelector('button').title;
    })()`);
    assert.equal(translated, '移除 0');
    console.log('PASS: row memory stays bounded and mounted labels still translate');
  } finally { clearTimeout(deadline); win.destroy(); }
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
