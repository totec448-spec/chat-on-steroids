/** Render the real Usage markup/CSS in isolated Chromium; no user data is read. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], {
    env, encoding: 'utf8', windowsHide: true
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const body = source.match(/<body[\s\S]*?<\/body>/i)[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
const iconsCss = fs.readFileSync(path.join(root, 'src/renderer/icons.css'), 'utf8');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head></head>${body}</html>`));
  await win.webContents.insertCSS(css);
  await win.webContents.insertCSS(iconsCss);
  await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.panel').forEach(panel => panel.classList.remove('is-active'));
    document.querySelector('[data-panel="usage"]').classList.add('is-active');
    document.documentElement.dataset.theme = 'dark';
    document.querySelector('.app').dataset.screen = 'settings';
    document.querySelector('.sidebar-brand').hidden = true;
    document.getElementById('sidebarPrimary').hidden = true;
    document.getElementById('tabs').hidden = false;
    document.getElementById('backToChat').hidden = false;
    document.querySelector('.sidebar-sessions').hidden = true;
    document.getElementById('newChat').hidden = true;
    document.getElementById('usageStatus').textContent = 'Recorded model attribution; missing history assumes GPT-5.6 High.';
    const metrics = [
      ['US$ 1.403,75', 'Estimated equivalent · USD'], ['2,9 bi', 'Processed tokens · est.'],
      ['342,1 mi', 'Peak daily tokens'], ['91', 'Conversations'], ['26', 'Active days']
    ];
    document.getElementById('usageSummary').innerHTML = metrics.map(([number, label]) => '<div><strong>' + number + '</strong><span>' + label + '</span></div>').join('');
    document.getElementById('usageHeatmap').innerHTML = Array.from({ length: 364 }, (_, index) => '<span class="heat-cell" data-level="' + (index > 350 ? (index % 4) + 1 : 0) + '" aria-label="day ' + index + '"></span>').join('');
    document.getElementById('usageCost').textContent = 'US$ 1.403,75 estimated equivalent. This is a comparison, not a bill.';
    for (const [host, heading, value] of [['usageModels', 'Recorded model / effort', 'gpt-5.6-sol · high'], ['usageDays', 'Day', '2026-09-18']]) {
      document.getElementById(host).innerHTML = '<table class="usage-table"><tr><th>' + heading + '</th><th>Estimated tokens</th><th>Estimated equivalent</th></tr>' + Array.from({ length: 4 }, () => '<tr><td>' + value + '</td><td>1.295.179.190</td><td>US$ 621,69</td></tr>').join('') + '</table>';
    }
    document.getElementById('modelUsage').innerHTML = Array.from({ length: 8 }, (_, index) => '<div class="usage-limit"><div><strong>Model ' + index + '</strong><small>Shared usage pool</small></div><div><b>3 remaining</b><small>Reset not reported</small><progress max="100" value="50"></progress></div></div>').join('');
  })()`);

  const inspect = async width => {
    win.setSize(width, 900);
    await win.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 60; attempt++) {
        if (Math.abs(window.innerWidth - ${width}) <= 2) return;
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      throw new Error('Chromium viewport did not resize to ${width}px');
    })()`);
    return win.webContents.executeJavaScript(`(() => {
      const rect = selector => { const box = document.querySelector(selector).getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width }; };
      const panel = document.querySelector('[data-panel="usage"]');
      const heat = document.querySelector('.usage-heatmap-surface');
      const tables = [...document.querySelectorAll('.usage-table-stack')];
      return {
        width: ${width}, viewport: window.innerWidth, panel: { left: panel.getBoundingClientRect().left, right: panel.getBoundingClientRect().right, clientWidth: panel.clientWidth, scrollWidth: panel.scrollWidth }, overflow: panel.scrollWidth > panel.clientWidth,
        content: rect('.usage-content'), heading: rect('.usage-content h1'),
        summary: rect('.usage-summary'), sections: [...document.querySelectorAll('.usage-section')].map(node => ({
          heading: node.querySelector('h2').getBoundingClientRect().top,
          surface: { left: node.querySelector('.settings-surface:not([hidden])').getBoundingClientRect().left, right: node.querySelector('.settings-surface:not([hidden])').getBoundingClientRect().right }
        })),
        metrics: [...document.querySelectorAll('.usage-summary > div')].map(node => ({
          top: node.getBoundingClientRect().top,
          overflow: node.scrollWidth > node.clientWidth
        })),
        heatScrolls: heat.scrollWidth > heat.clientWidth,
        tablesScrolls: tables.map(table => table.scrollWidth > table.clientWidth),
        separateTables: tables.length === 2 && tables[0].parentElement !== tables[1].parentElement,
        formulaButtonRight: document.getElementById('usageFormulaToggle').getBoundingClientRect().right === document.querySelector('.usage-cost-groups').getBoundingClientRect().right,
        actionIcons: ['usageFormulaToggle', 'refreshUsage'].map(id => {
          const icon = document.querySelector('#' + id + ' .ico');
          return icon && !['none', 'normal'].includes(getComputedStyle(icon, '::before').content);
        }),
        cells: document.querySelectorAll('.heat-cell').length,
        emptyCellColor: getComputedStyle(document.querySelector('.heat-cell')).backgroundColor,
        cardColor: getComputedStyle(heat).backgroundColor
      };
    })()`);
  };

  for (const width of [1400, 900]) {
    const result = await inspect(width);
    assert.equal(result.overflow, false, JSON.stringify(result));
    assert.ok(Math.abs(result.viewport - width) <= 2, JSON.stringify(result));
    assert.ok(result.content.width <= 941, JSON.stringify(result));
    assert.equal(result.cells, 364, JSON.stringify(result));
    assert.notEqual(result.emptyCellColor, result.cardColor, JSON.stringify(result));
    assert.ok(result.metrics.every(metric => !metric.overflow), JSON.stringify(result));
    assert.ok(result.sections.every(section => section.surface.left === result.summary.left && section.surface.right === result.summary.right), JSON.stringify(result));
    assert.ok(result.sections.every((section, index) => !index || result.sections[index - 1].heading < section.heading), JSON.stringify(result));
    assert.ok(result.summary.bottom < result.sections[0].heading, JSON.stringify(result));
    assert.equal(result.heatScrolls, width === 900, JSON.stringify(result));
    assert.deepEqual(result.tablesScrolls, [width === 900, width === 900], JSON.stringify(result));
    assert.equal(result.separateTables, true, JSON.stringify(result));
    assert.equal(result.formulaButtonRight, true, JSON.stringify(result));
    assert.deepEqual(result.actionIcons, [true, true], JSON.stringify(result));
    assert.equal(result.metrics[0].top === result.metrics[4].top, width === 1400, JSON.stringify(result));
  }

  await inspect(900);
  const expanded = await win.webContents.executeJavaScript(`(() => {
    document.getElementById('usageFormulaDetails').hidden = false;
    document.getElementById('usageFormulaToggle').setAttribute('aria-expanded', 'true');
    const panel = document.querySelector('[data-panel="usage"]');
    const input = document.getElementById('usageDivisor');
    return { overflow: panel.scrollWidth > panel.clientWidth, inputWidth: input.getBoundingClientRect().width,
      visible: input.getBoundingClientRect().height > 0,
      expanded: document.getElementById('usageFormulaToggle').getAttribute('aria-expanded') };
  })()`);
  assert.equal(expanded.overflow, false, JSON.stringify(expanded));
  assert.ok(expanded.visible && expanded.inputWidth >= 100, JSON.stringify(expanded));
  assert.equal(expanded.expanded, 'true', JSON.stringify(expanded));

  await win.webContents.executeJavaScript(`document.getElementById('usageFormulaDetails').hidden = true; document.getElementById('usageFormulaToggle').setAttribute('aria-expanded', 'false')`);
  await inspect(1400);
  const screenshotPath = path.join(os.tmpdir(), 'cos-usage-ui-verified.png');
  fs.writeFileSync(screenshotPath, (await win.webContents.capturePage()).toPNG());
  console.log(`Usage UI geometry passed at 1400px and 900px. Screenshot: ${screenshotPath}`);
  win.destroy();
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
