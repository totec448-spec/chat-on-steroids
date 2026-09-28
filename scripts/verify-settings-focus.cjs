// Isolated production CSS/markup: focus and picker repaints must not move settings.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');
const output = path.join(root, 'outputs/settings-focus');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 1000, height: 900,
    webPreferences: { sandbox: true, backgroundThrottling: false } });
  try {
    const html = fs.readFileSync(path.join(root, 'out/renderer/index.html'), 'utf8')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'out/renderer/')).href}">`);
    const fixture = path.join(output, 'fixture.html'); fs.writeFileSync(fixture, html);
    await win.loadFile(fixture);
    const js = code => win.webContents.executeJavaScript(code, true);
    const settle = () => js(`(async () => {
      for (const a of document.getAnimations()) if (Number.isFinite(a.effect.getComputedTiming().endTime)) a.finish();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    })()`);
    await js(`(() => {
      const appearance = document.getElementById('uiLanguage').closest('.pane').cloneNode(true);
      const settings = document.getElementById('goalBackend').closest('.pane').cloneNode(true);
      document.body.innerHTML = '<div class="app" data-screen="settings" style="display:block;height:100%"><section class="panel appearance-panel is-active" style="height:100%;padding:50px"><div id="fixture"></div></section></div>';
      const fixture = document.getElementById('fixture'); fixture.append(appearance);
      const host = document.createElement('div'); host.dataset.view = 'settings'; host.style.marginTop = '30px'; host.append(settings); fixture.append(host);
      window.geometry = () => [...document.querySelectorAll('#fixture .pane, #fixture .setting, #fixture select')].map(e => ({id:e.id,rect:e.getBoundingClientRect().toJSON()}));
    })()`);
    await js('document.fonts.ready');
    for (const theme of ['dark', 'light']) for (const zoom of [1, 1.17, 1.5]) for (const id of ['uiLanguage', 'goalBackend']) {
      win.webContents.setZoomFactor(zoom);
      await js(`document.documentElement.dataset.theme='${theme}'; document.activeElement.blur(); new Promise(r=>setTimeout(r,250))`);
      await settle();
      const before = await js('geometry()');
      const baseline = await win.webContents.capturePage();
      const capture = async name => fs.writeFileSync(path.join(output, `${theme}-${zoom}-${id}-${name}.png`), (await win.webContents.capturePage()).toPNG());
      await capture('before');
      await js(`document.getElementById('${id}').focus(); new Promise(r=>setTimeout(r,200))`);
      assert.deepEqual(await js('geometry()'), before, 'Focus must not move rows');
      await capture('focus');
      await js(`document.getElementById('${id}').showPicker(); new Promise(r=>setTimeout(r,200))`);
      assert.deepEqual(await js('geometry()'), before, 'Opening must not move rows');
      if (id === 'uiLanguage') assert.equal(await js(`(() => {
        const select=document.getElementById('uiLanguage'), option=select.options[select.options.length-1];
        option.scrollIntoView({block: 'nearest'});
        const rect=option.getBoundingClientRect(), pane=select.closest('.pane').getBoundingClientRect();
        const hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
        return (rect.bottom>pane.bottom || rect.top<pane.top) && (hit===option || option.contains(hit));
      })()`), true, 'The top-layer option outside the card must remain clickable');
      await capture('open');
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'ESCAPE'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'ESCAPE'});
      await js('new Promise(r=>setTimeout(r,200))');
      assert.equal(await js(`document.getElementById('${id}').matches(':open')`), false);
      await capture('closed');
      await js('document.activeElement.blur(); new Promise(r=>setTimeout(r,200))');
      await settle();
      const after = await win.webContents.capturePage();
      const a = baseline.toBitmap(), b = after.toBitmap(), size = baseline.getSize();
      let changed = 0, material = 0; const points = [];
      for (let y=0;y<size.height;y++) for(let x=0;x<size.width;x++) {
        const i=(y*size.width+x)*4;
        const delta = Math.max(...[0,1,2].map(c => Math.abs(a[i+c]-b[i+c])));
        if(delta) { changed++; if(delta>2) material++; if(points.length<10) points.push({x,y,a:[...a.subarray(i,i+4)],b:[...b.subarray(i,i+4)]}); }
      }
      // Fractional DPI can re-rasterize a few edge pixels by 1–2 channel levels.
      // Geometry and hit targets remain exact; visible residue must still fail.
      assert.ok(material === 0 && changed <= 100, JSON.stringify({theme,zoom,id,changedPixelsAfterBlur:changed,material,points}));
    }
    console.log('Settings focus geometry passed: ' + output);
  } finally { win.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
