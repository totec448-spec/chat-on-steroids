/** Workspace settings geometry in real offscreen Chromium; no app data is read or changed. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], {
    env,
    encoding: 'utf8',
    windowsHide: true
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

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head></head>${body}</html>`));
  await win.webContents.insertCSS(css);
  const emptyFolders = await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.panel').forEach(panel => panel.classList.remove('is-active'));
    document.querySelector('[data-panel="home"]').classList.add('is-active');
    document.documentElement.dataset.theme = 'dark';
    document.querySelector('.app').dataset.screen = 'settings';
    document.querySelector('.sidebar-brand').hidden = true;
    document.getElementById('sidebarPrimary').hidden = true;
    document.getElementById('tabs').hidden = false;
    document.getElementById('backToChat').hidden = false;
    document.querySelector('.sidebar-sessions').hidden = true;
    document.getElementById('newChat').hidden = true;
    const empty = document.getElementById('rootsEmpty');
    const emptySurface = empty.closest('.workspace-surface');
    const emptyRect = empty.getBoundingClientRect();
    const surfaceRect = emptySurface.getBoundingClientRect();
    const emptyStyle = getComputedStyle(empty);
    const emptyFolders = {
      visible: empty.checkVisibility(),
      height: emptyRect.height,
      surfaceHeight: surfaceRect.height,
      centerDelta: Math.abs((emptyRect.top + emptyRect.bottom - surfaceRect.top - surfaceRect.bottom) / 2),
      marginTop: emptyStyle.marginTop,
      marginBottom: emptyStyle.marginBottom,
      paddingTop: emptyStyle.paddingTop,
      paddingBottom: emptyStyle.paddingBottom
    };
    const permission = (title, detail) => '<div class="perm is-on"><div class="perm-head"><button class="perm-main"><i class="ico"></i><i class="ico"></i><span><b>' + title + '</b><em>' + detail + '</em></span></button><span class="sw"><input type="checkbox" checked><i></i></span></div></div>';
    document.getElementById('groups').innerHTML = [
      permission('Look at files', '4 permissions'), permission('Change files', '4 permissions'),
      permission('Browser and desktop control', '4 permissions'), permission('Run programs', '1 permission'),
      permission('Sub-agents', 'agents tool exposed')
    ].join('');
    const folder = (name) => '<div class="root"><i class="ico"></i><b>/' + name + '</b><span>C:\\\\Projects\\\\' + name + '</span><button class="btn">Edit</button></div>';
    document.getElementById('rootList').innerHTML = Array.from(
      { length: 12 },
      (_, index) => folder(index === 5 ? 'a-very-long-project-name' : 'project-' + (index + 1))
    ).join('');
    document.getElementById('rootsEmpty').hidden = true;
    document.getElementById('facts').innerHTML = '<div class="fact"><span>Route to OpenAI</span><code>connected</code></div><div class="fact"><span>Tools across Core + Desktop</span><code>30 total · 3 folders</code></div>';
    document.getElementById('homeFeed').innerHTML = Array.from({ length: 8 }, (_, index) => '<p><time>13:4' + index + '</time><span class="what">renderer</span><span class="rest">Workspace event ' + index + '</span></p>').join('');
    return emptyFolders;
  })()`);
  assert.equal(emptyFolders.visible, true, JSON.stringify(emptyFolders));
  assert.ok(emptyFolders.height > 0 && emptyFolders.surfaceHeight > 0, JSON.stringify(emptyFolders));
  assert.equal(emptyFolders.marginTop, '0px', JSON.stringify(emptyFolders));
  assert.equal(emptyFolders.marginBottom, '0px', JSON.stringify(emptyFolders));
  assert.equal(emptyFolders.paddingTop, emptyFolders.paddingBottom, JSON.stringify(emptyFolders));
  assert.ok(emptyFolders.centerDelta < 1, JSON.stringify(emptyFolders));

  const inspect = async (width) => {
    win.setSize(width, 900);
    await new Promise(resolve => setTimeout(resolve, 80));
    return win.webContents.executeJavaScript(`(() => {
      const rect = selector => { const value = document.querySelector(selector).getBoundingClientRect(); return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width }; };
      const panel = document.querySelector('[data-panel="home"]');
      const section = selector => ({ header: rect(selector + ' .workspace-section-head'), surface: rect(selector + ' .workspace-surface') });
      return {
        width: ${width}, panelOverflow: panel.scrollWidth > panel.clientWidth,
        content: rect('.workspace-content'), panel: rect('[data-panel="home"]'),
        permissions: section('.workspace-permissions'), folders: section('#foldersCard'),
        health: section('.workspace-health'), activity: section('.workspace-activity')
      };
    })()`);
  };

  const wide = await inspect(1400);
  assert.equal(wide.panelOverflow, false, JSON.stringify(wide));
  assert.ok(wide.content.width <= 941, JSON.stringify(wide));
  const wideOrdered = [wide.permissions, wide.folders, wide.health, wide.activity];
  for (let index = 1; index < wideOrdered.length; index += 1) {
    assert.ok(wideOrdered[index - 1].surface.bottom < wideOrdered[index].header.top, JSON.stringify(wide));
  }
  assert.ok(wideOrdered.every(section => Math.abs(section.surface.left - wide.content.left) < 1 && Math.abs(section.surface.right - wide.content.right) < 1), JSON.stringify(wide));
  for (const section of [wide.permissions, wide.folders, wide.health, wide.activity]) {
    assert.ok(section.header.bottom <= section.surface.top, JSON.stringify(section));
  }

  const narrow = await inspect(900);
  assert.equal(narrow.panelOverflow, false, JSON.stringify(narrow));
  const ordered = [narrow.permissions, narrow.folders, narrow.health, narrow.activity];
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(ordered[index - 1].surface.bottom < ordered[index].header.top, JSON.stringify(narrow));
  }
  assert.ok(ordered.every(section => Math.abs(section.surface.left - narrow.content.left) < 1 && Math.abs(section.surface.right - narrow.content.right) < 1), JSON.stringify(narrow));

  win.setSize(1400, 900);
  await new Promise(resolve => setTimeout(resolve, 80));
  const screenshotPath = path.join(os.tmpdir(), 'cos-workspace-ui-verified.png');
  fs.writeFileSync(screenshotPath, (await win.webContents.capturePage()).toPNG());
  console.log(`Workspace UI geometry passed at 1400px and 900px. Screenshot: ${screenshotPath}`);
  win.destroy();
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
