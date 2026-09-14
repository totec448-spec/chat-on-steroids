// Isolated Electron/Chromium acceptance for the production Skills renderer.
// Run: node scripts/verify-skills-layout.cjs
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs', 'skills-layout');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'runtime'));

const emptyLibrary = { directory: 'C:\\fixture-skills', skills: [], errors: [] };
const longDescription = 'Review implementation details, race boundaries, error paths, keyboard behavior, and integration assumptions. '.repeat(7).trim();
const populatedLibrary = {
  directory: 'C:\\fixture-skills',
  skills: [
    { id: 'review', name: 'Code review', description: longDescription },
    { id: 'docs_helper.v2', name: 'Documentation helper with a deliberately long display name', description: 'Write concise user-facing documentation and preserve exact technical directives.' }
  ],
  errors: []
};

app.whenReady().then(async () => {
  const bundle = buildSync({
    entryPoints: [path.join(root, 'src', 'renderer', 'skills.ts')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'skills'
  }).outputFiles[0].text;
  const css = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace('</head>', `<style>${css}</style></head>`);
  const win = new BrowserWindow({
    show: false,
    width: 920,
    height: 720,
    webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false }
  });
  const js = code => win.webContents.executeJavaScript(code);
  const frame = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const waitFor = async (expression, label) => {
    for (let i = 0; i < 120; i++) {
      if (await js(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await js(bundle);
    await js(`(() => {
      const sprite = document.querySelector('.sprite');
      const composer = document.getElementById('composer');
      const dialog = document.getElementById('skillsDialog');
      const shell = document.createElement('main');
      shell.id = 'skillsFixture';
      shell.style.cssText = 'height:100%;display:flex;flex-direction:column;justify-content:flex-end;padding:24px 0 44px;overflow:hidden;background:var(--page)';
      const heading = document.createElement('div');
      heading.style.cssText = 'margin:auto auto 24px;max-width:720px;padding:20px;color:var(--soft);text-align:center';
      heading.innerHTML = '<strong style="display:block;color:var(--ink);font-size:18px">Skills renderer fixture</strong><span>Production composer, dialog and slash completion</span>';
      shell.append(heading, composer);
      document.body.replaceChildren(sprite, shell, dialog);
      const still = document.createElement('style');
      still.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
      document.head.append(still);
      const clone = value => JSON.parse(JSON.stringify(value));
      window.fixtureLibrary = clone(${JSON.stringify(emptyLibrary)});
      window.fixtureImportLibrary = clone(${JSON.stringify(populatedLibrary)});
      window.fixture = { listCalls: 0, importCalls: 0, removeCalls: 0, openFolderCalls: 0 };
      const ok = data => Promise.resolve({ok:true,data});
      const api = {
        skillsList: () => { window.fixture.listCalls++; return ok(clone(window.fixtureLibrary)); },
        skillsImport: () => { window.fixture.importCalls++; window.fixtureLibrary = clone(window.fixtureImportLibrary); return ok(clone(window.fixtureLibrary)); },
        skillsOpenFolder: () => { window.fixture.openFolderCalls++; return ok(undefined); },
        skillsRemove: id => {
          window.fixture.removeCalls++;
          window.fixtureLibrary = {...window.fixtureLibrary, skills:window.fixtureLibrary.skills.filter(skill=>skill.id!==id)};
          return ok(clone(window.fixtureLibrary));
        }
      };
      const input = document.getElementById('chatInput');
      window.skillsController = skills.createSkills({api,input,getDraftIdentity:()=> 'fixture:draft'});
      input.addEventListener('input', () => window.skillsController.onInput());
      input.addEventListener('keydown', event => window.skillsController.onKeydown(event));
      composer.addEventListener('submit', event => event.preventDefault());
      window.setFixtureLibrary = value => { window.fixtureLibrary = clone(value); };
      window.setFixtureInput = (value, caret = value.length) => {
        input.value = value; input.setSelectionRange(caret, caret); input.focus();
        input.dispatchEvent(new Event('input', {bubbles:true}));
      };
      window.closeSkillsFixture = () => { if (dialog.open) dialog.close(); window.setFixtureInput('Actual task to preserve'); };
      window.fixtureReady = true;
    })()`);
    await waitFor('window.fixtureReady === true', 'fixture bootstrap');

    const screenshots = [];
    const measurements = [];
    const capture = async name => {
      await frame();
      const file = path.join(output, `${name}.png`);
      fs.writeFileSync(file, (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
      screenshots.push(path.basename(file));
    };
    const setCase = async (width, theme, library) => {
      win.setContentSize(width, 720);
      win.webContents.setZoomFactor(1);
      await js(`(() => {
        document.documentElement.dataset.theme = ${JSON.stringify(theme)};
        window.closeSkillsFixture();
        window.setFixtureLibrary(${JSON.stringify(library)});
        document.getElementById('composerSkills').click();
      })()`);
      await waitFor(`document.getElementById('skillsDialog').open && !document.getElementById('skillsList').textContent.includes('Loading skills')`, `${theme} ${width}px skill dialog`);
      await frame();
    };
    const measureDialog = async () => js(`(() => {
      const dialog = document.getElementById('skillsDialog');
      const body = dialog.querySelector('.skills-dialog-body');
      const d = dialog.getBoundingClientRect(), b = body.getBoundingClientRect();
      const rows = [...dialog.querySelectorAll('.skill-row')].map(row => {
        const r = row.getBoundingClientRect();
        const text = row.querySelector('.skill-row-copy p');
        const t = text?.getBoundingClientRect();
        return { left:r.left, right:r.right, width:r.width, textWidth:t?.width ?? 0,
          textScroll:text?.scrollWidth ?? 0, textClient:text?.clientWidth ?? 0,
          actions:[...row.querySelectorAll('button')].map(button => { const x=button.getBoundingClientRect(); return {left:x.left,right:x.right,width:x.width,height:x.height}; }) };
      });
      return { viewport:[innerWidth,innerHeight], dialog:{left:d.left,right:d.right,top:d.top,bottom:d.bottom,width:d.width,height:d.height,
        scrollWidth:dialog.scrollWidth,clientWidth:dialog.clientWidth}, body:{left:b.left,right:b.right,width:b.width}, rows,
        background:getComputedStyle(document.body).backgroundColor };
    })()`);

    for (const width of [920, 420]) for (const theme of ['dark', 'light']) {
      await setCase(width, theme, emptyLibrary);
      let measured = await measureDialog();
      assert.ok(measured.dialog.left >= 0 && measured.dialog.right <= measured.viewport[0], JSON.stringify({ width, theme, kind:'empty', measured }));
      assert.ok(measured.dialog.top >= 0 && measured.dialog.bottom <= measured.viewport[1], JSON.stringify({ width, theme, kind:'empty', measured }));
      assert.ok(measured.dialog.scrollWidth <= measured.dialog.clientWidth, JSON.stringify({ width, theme, kind:'empty', measured }));
      assert.ok(await js(`document.getElementById('skillsList').textContent.includes('No skills yet.')`));
      measurements.push({ width, theme, kind:'empty', ...measured });
      await capture(`empty-${width}-${theme}`);

      await setCase(width, theme, populatedLibrary);
      measured = await measureDialog();
      assert.equal(measured.rows.length, 2, JSON.stringify({ width, theme, kind:'populated', measured }));
      assert.ok(measured.dialog.left >= 0 && measured.dialog.right <= measured.viewport[0], JSON.stringify({ width, theme, kind:'populated', measured }));
      assert.ok(measured.dialog.top >= 0 && measured.dialog.bottom <= measured.viewport[1], JSON.stringify({ width, theme, kind:'populated', measured }));
      assert.ok(measured.dialog.scrollWidth <= measured.dialog.clientWidth, JSON.stringify({ width, theme, kind:'populated', measured }));
      for (const row of measured.rows) {
        assert.ok(row.left >= measured.body.left - 1 && row.right <= measured.body.right + 1, JSON.stringify({ width, theme, row }));
        assert.ok(row.textScroll <= row.textClient + 1, JSON.stringify({ width, theme, row }));
        assert.ok(row.actions.every(button => button.width > 0 && button.height > 0 && button.left >= measured.body.left - 1 && button.right <= measured.body.right + 1), JSON.stringify({ width, theme, row }));
      }
      measurements.push({ width, theme, kind:'populated', ...measured });
      await capture(`populated-${width}-${theme}`);

      await js(`(() => {
        document.getElementById('skillsDialog').close();
        window.setFixtureLibrary(${JSON.stringify(populatedLibrary)});
        window.setFixtureInput('/\\nActual task', 1);
      })()`);
      await waitFor(`document.querySelectorAll('#skillAutocomplete .skill-autocomplete-option').length === 2`, `${theme} ${width}px slash autocomplete`);
      const popup = await js(`(() => { const p=document.getElementById('skillAutocomplete').getBoundingClientRect(), c=document.getElementById('composer').getBoundingClientRect();
        return {left:p.left,right:p.right,top:p.top,bottom:p.bottom,width:p.width,viewport:[innerWidth,innerHeight],composer:{left:c.left,right:c.right}}; })()`);
      assert.ok(popup.left >= 0 && popup.right <= popup.viewport[0] && popup.top >= 0 && popup.bottom <= popup.viewport[1], JSON.stringify({ width, theme, popup }));
      assert.ok(popup.left >= popup.composer.left - 1 && popup.right <= popup.composer.right + 1, JSON.stringify({ width, theme, popup }));
      await capture(`autocomplete-${width}-${theme}`);
      await js(`window.setFixtureInput('Actual task to preserve')`);
    }

    // Empty -> import -> Use runs through the real dialog controller and preserves authored prose.
    win.setContentSize(920, 720);
    await js(`(() => {
      document.documentElement.dataset.theme='dark';
      window.setFixtureLibrary(${JSON.stringify(emptyLibrary)});
      window.fixtureImportLibrary=${JSON.stringify(populatedLibrary)};
      window.setFixtureInput('Keep this exact authored task');
      document.getElementById('composerSkills').click();
    })()`);
    await waitFor(`document.getElementById('skillsList').textContent.includes('No skills yet.')`, 'empty import dialog');
    await js(`document.getElementById('skillsImport').click()`);
    await waitFor(`document.querySelectorAll('#skillsList .skill-row').length === 2`, 'imported skills');
    assert.equal(await js(`window.fixture.importCalls > 0`), true);
    await js(`document.querySelector('#skillsList .skill-use').click()`);
    await waitFor(`!document.getElementById('skillsDialog').open`, 'Use closes skill dialog');
    assert.equal(await js(`document.getElementById('chatInput').value`), '/review\nKeep this exact authored task');

    // Actual Chromium key events exercise both autocomplete acceptance keys.
    await js(`window.setFixtureLibrary(${JSON.stringify(populatedLibrary)}); window.setFixtureInput('/rev\\nActual task',4)`);
    await waitFor(`document.querySelectorAll('#skillAutocomplete .skill-autocomplete-option').length === 1`, 'Enter autocomplete');
    win.webContents.sendInputEvent({ type:'keyDown', keyCode:'ENTER' });
    win.webContents.sendInputEvent({ type:'keyUp', keyCode:'ENTER' });
    await waitFor(`document.getElementById('chatInput').value === '/review\\nActual task'`, 'Enter skill selection');
    await js(`window.setFixtureInput('/docs\\nActual task',5)`);
    await waitFor(`document.querySelectorAll('#skillAutocomplete .skill-autocomplete-option').length === 1`, 'Tab autocomplete');
    win.webContents.sendInputEvent({ type:'keyDown', keyCode:'TAB' });
    win.webContents.sendInputEvent({ type:'keyUp', keyCode:'TAB' });
    await waitFor(`document.getElementById('chatInput').value === '/docs_helper.v2\\nActual task'`, 'Tab skill selection');

    fs.writeFileSync(path.join(output, 'measurements.json'), JSON.stringify({ measurements, screenshots,
      flow: await js(`({input:document.getElementById('chatInput').value,calls:window.fixture})`) }, null, 2));
    console.log(JSON.stringify({ cases: measurements.length, screenshots: screenshots.length, output,
      flow: await js(`({input:document.getElementById('chatInput').value,calls:window.fixture})`) }, null, 2));
  } finally {
    win.destroy();
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
