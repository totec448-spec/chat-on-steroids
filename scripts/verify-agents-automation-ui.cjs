/** Inspect the real Agents & automation markup/CSS in isolated Chromium. */
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
    document.querySelector('[data-panel="chat"]').classList.add('is-active');
    document.querySelectorAll('#chatBody > .view').forEach(view => { view.hidden = view.dataset.view !== 'settings'; });
    document.documentElement.dataset.theme = 'dark';
    document.querySelector('.app').dataset.screen = 'settings';
    document.querySelector('.sidebar-brand').hidden = true;
    document.getElementById('sidebarPrimary').hidden = true;
    document.getElementById('tabs').hidden = false;
    document.getElementById('backToChat').hidden = false;
    document.querySelector('.sidebar-sessions').hidden = true;
    document.getElementById('newChat').hidden = true;
    document.getElementById('composer').hidden = true;
    document.getElementById('composerDock').hidden = true;
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
      const bounds = node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width }; };
      const rect = selector => bounds(document.querySelector(selector));
      const view = document.querySelector('[data-view="settings"]');
      const panel = document.querySelector('[data-panel="chat"]');
      const scroll = document.getElementById('chatBody');
      const headers = [...view.querySelectorAll('.automation-section-head')];
      return {
        width: ${width}, viewport: window.innerWidth,
        scrollOverflow: scroll.scrollWidth > scroll.clientWidth,
        view: rect('[data-view="settings"]'), heading: rect('.automation-page-head'),
        headingCopy: rect('.automation-page-head > div:first-child'),
        search: rect('.automation-search .plugin-search'), firstCard: rect('.automation-content > .pane'),
        searchStyle: (() => {
          const pet = getComputedStyle(document.querySelector('#petsSearch').closest('.plugin-search'));
          const settings = getComputedStyle(document.querySelector('#settingsSearch').closest('.plugin-search'));
          return { pet: [pet.height, pet.borderRadius, pet.backgroundColor, pet.borderColor], settings: [settings.height, settings.borderRadius, settings.backgroundColor, settings.borderColor] };
        })(),
        maxWidth: getComputedStyle(view).maxWidth,
        motion: {
          panel: [getComputedStyle(panel).animationName, getComputedStyle(panel).animationDuration],
          view: [getComputedStyle(view).animationName, getComputedStyle(view).animationDuration]
        },
        cardBackground: getComputedStyle(view.querySelector('.pane')).backgroundColor,
        pageBackground: getComputedStyle(view).backgroundColor,
        sections: headers.map(header => ({ heading: header.querySelector('h2').textContent, description: header.querySelector('p')?.textContent.trim(), header: bounds(header), card: bounds(header.nextElementSibling) })),
        cardOverflows: headers.map(header => header.nextElementSibling.scrollWidth > header.nextElementSibling.clientWidth),
        modelActionInHeader: document.getElementById('refreshChatModels').closest('.automation-section-head') === headers[1],
        actionIcons: ['refreshChatModels', 'browserPreferencesRefresh', 'swarmReset'].map(id => {
          const icon = document.querySelector('#' + id + ' .ico');
          return icon && !['none', 'normal'].includes(getComputedStyle(icon, '::before').content);
        }),
        promptEditorHidden: document.getElementById('goalPromptPanel').hidden,
        modelPickerHidden: document.getElementById('goalModels').hidden
      };
    })()`);
  };

  for (const width of [1400, 900]) {
    const result = await inspect(width);
    assert.equal(result.scrollOverflow, false, JSON.stringify(result));
    assert.ok(result.view.width <= 941, JSON.stringify(result));
    if (width === 1400) assert.equal(result.view.width, 940, JSON.stringify(result));
    else assert.ok(result.view.width < 940, JSON.stringify(result));
    assert.equal(result.maxWidth, '940px', JSON.stringify(result));
    assert.deepEqual(result.motion, { panel: ['none', '0s'], view: ['surface-in', '0.16s'] }, JSON.stringify(result));
    assert.equal(result.sections.length, 7, JSON.stringify(result));
    assert.ok(result.sections.every(section => section.description), JSON.stringify(result));
    assert.deepEqual(result.searchStyle.settings, result.searchStyle.pet, JSON.stringify(result));
    assert.ok(result.sections.every(section => section.header.left === result.view.left && section.header.right === result.view.right && section.card.left === result.view.left && section.card.right === result.view.right), JSON.stringify(result));
    assert.ok(result.sections.every((section, index) => !index || result.sections[index - 1].card.bottom < section.header.top), JSON.stringify(result));
    assert.ok(result.cardOverflows.every(overflow => !overflow), JSON.stringify(result));
    assert.notEqual(result.cardBackground, result.pageBackground, JSON.stringify(result));
    assert.equal(result.modelActionInHeader, true, JSON.stringify(result));
    assert.deepEqual(result.actionIcons, [true, true, true], JSON.stringify(result));
    assert.equal(result.promptEditorHidden && result.modelPickerHidden, true, JSON.stringify(result));
    if (width === 1400) assert.equal(result.search.right, result.view.right, JSON.stringify(result));
    if (width === 900) assert.ok(result.search.top > result.headingCopy.bottom && result.search.left === result.view.left, JSON.stringify(result));
  }
  await inspect(1400);
  const screenshotPath = path.join(os.tmpdir(), 'cos-agents-automation-ui-verified.png');
  fs.writeFileSync(screenshotPath, (await win.webContents.capturePage()).toPNG());
  console.log(`Agents & automation UI geometry passed at 1400px and 900px. Screenshot: ${screenshotPath}`);
  win.destroy();
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
