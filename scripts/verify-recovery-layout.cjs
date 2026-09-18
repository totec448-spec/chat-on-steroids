// Isolated Electron fixture: production countdown renderer, dock markup and CSS.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { build } = require('esbuild');

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..');
  const output = path.join(root, 'outputs/recovery-layout');
  fs.mkdirSync(output, { recursive: true });
  const bundle = await build({ entryPoints: [path.join(root, 'src/renderer/recovery.ts')], bundle: true,
    write: false, format: 'iife', globalName: 'recovery', platform: 'browser' });
  const win = new BrowserWindow({ show: false, width: 920, height: 380,
    webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });
  const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html.replace('</head>', `<style>${css}</style></head>`)));
  await win.webContents.executeJavaScript(bundle.outputFiles[0].text);
  await win.webContents.executeJavaScript(`(() => {
    const dock = document.getElementById('composerDock');
    const composer = document.querySelector('form.composer');
    const sprite = document.querySelector('svg');
    document.body.replaceChildren(sprite, dock, composer);
    document.body.style.cssText = 'padding-top:70px;display:block';
    dock.hidden = false;
    const goal = document.getElementById('activeGoalRow'); goal.hidden = false;
    goal.innerHTML = '<svg class="ico"><use href="#i-pulse"/></svg><span class="queue-label">Loop · Continue the requested work and verify the result.</span><button class="dock-action" aria-label="Pause automation">⏻</button>';
    const plan = document.getElementById('agentPlan'); plan.hidden = false;
    plan.innerHTML = '<summary class="agent-plan-heading">Plan <span class="agent-plan-count">2 / 7</span></summary>';
    document.getElementById('chatInput').placeholder = 'Ask anything…';
  })()`);
  const results = [];
  for (const width of [920, 420]) for (const zoom of [1, 1.5]) for (const theme of ['dark', 'light']) {
    win.setContentSize(width, 380);
    win.webContents.setZoomFactor(zoom);
    for (const kind of ['thinking-failed', 'unattributed', 'unattributed-wait', 'assistant-error', 'tab-recovery', 'native-busy', 'silence', 'post-reload'])
      for (const next of kind === 'post-reload' ? [null, 'queue', 'goal', 'loop', 'continue'] : kind === 'native-busy' ? [null, 'continue'] : [null]) {
      const measured = await win.webContents.executeJavaScript(`(() => {
        document.documentElement.dataset.theme = '${theme}';
        recovery.renderRecoveryCountdowns(document.getElementById('recoveryStatus'), [{ kind: '${kind}', next: ${JSON.stringify(next)}, generating: ${kind === 'post-reload'}, deadline: ${kind === 'unattributed' ? 15000 : 300000} }], 1000);
        const host = document.getElementById('recoveryStatus'), timer = host.querySelector('.recovery-countdown');
        const h = host.getBoundingClientRect(), t = timer.getBoundingClientRect();
        return { hostWidth: h.width, height: h.height, timerWidth: t.width, text: timer.textContent,
          fits: t.left >= h.left && t.right <= h.right && host.scrollWidth <= host.clientWidth };
      })()`);
      assert.ok(measured.fits, JSON.stringify({ width, zoom, theme, kind, ...measured }));
      assert.ok(measured.height >= 38 && measured.timerWidth > 0);
      results.push({ width, zoom, theme, kind, next, ...measured });
      if (width === 920 && zoom === 1 && theme === 'dark') {
        await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        fs.writeFileSync(path.join(output, `${kind}${next ? '-' + next : ''}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
  }
  // Explicit UI examples rendered with production labels and countdowns.
  win.setContentSize(920, 320);
  win.webContents.setZoomFactor(1);
  const previews = [
    { file: 'preview-unattributed', kind: 'unattributed', deadline: 15_000, now: 0 },
    { file: 'preview-unattributed-multiple', kind: 'unattributed', deadline: 60_000, now: 0 },
    { file: 'preview-unattributed-five-minute', kind: 'unattributed-wait', deadline: 300_000, now: 60_000 },
    { file: 'preview-thinking-failed', kind: 'thinking-failed', deadline: 300_000, now: 0 },
    { file: 'preview-extended-wait', kind: 'native-busy', deadline: 600_000, now: 300_000 },
    { file: 'preview-continue-one-minute', kind: 'native-busy', next: 'continue', deadline: 60_000, now: 0 },
    { file: 'preview-continue-five-minutes', kind: 'native-busy', next: 'continue', deadline: 300_000, now: 0 },
    { file: 'preview-generating-queue', kind: 'post-reload', generating: true, next: 'queue', deadline: 60_000, now: 0 },
    { file: 'preview-pro-silence', kind: 'silence', visibleAt: 300_000, deadline: 600_000, now: 300_000 },
    { file: 'preview-goal-one-minute', kind: 'post-reload', next: 'goal', deadline: 180_000, now: 120_000 },
    { file: 'preview-queue-one-minute', kind: 'post-reload', next: 'queue', deadline: 180_000, now: 120_000 },
    { file: 'preview-loop-thinking-failed', kind: 'thinking-failed', next: 'loop', deadline: 300_000, now: 0 }
  ];
  for (const preview of previews) {
    await win.webContents.executeJavaScript(`(() => {
      const sample = ${JSON.stringify(preview)};
      document.documentElement.dataset.theme = 'dark';
      document.body.style.paddingTop = '30px';
      recovery.renderRecoveryCountdowns(document.getElementById('recoveryStatus'), [sample], sample.now);
      document.querySelector('#activeGoalRow .queue-label').textContent = sample.next === 'goal'
        ? 'Goal · Complete the requested task and verify the result.'
        : 'Loop · Continue the requested work and verify the result.';
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
    fs.writeFileSync(path.join(output, `${preview.file}.png`), (await win.webContents.capturePage()).toPNG());
  }
  fs.writeFileSync(path.join(output, 'measurements.json'), JSON.stringify(results, null, 2));
  console.log(`Passed ${results.length} recovery layout cases. Screenshots: ${output}`);
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
