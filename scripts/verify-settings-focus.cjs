// Isolated production CSS/markup: focus and picker repaints must not move settings.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const output = path.join(root, 'outputs/settings-focus');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 1000, height: 900,
    webPreferences: { sandbox: true, backgroundThrottling: false } });
  try {
    const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8') +
      (process.argv.includes('--without-containment') ? '.appearance-panel select, [data-view="settings"] select { contain: none; }' : '');
    const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html.replace('</head>', `<style>${css}</style></head>`)));
    const js = code => win.webContents.executeJavaScript(code, true);
    await js(`(() => {
      const appearance = document.getElementById('uiLanguage').closest('.pane').cloneNode(true);
      const settings = document.getElementById('goalBackend').closest('.pane').cloneNode(true);
      document.body.innerHTML = '<div class="app" data-screen="settings" style="display:block;height:100%"><section class="panel appearance-panel is-active" style="height:100%;padding:50px"><div id="fixture"></div></section></div>';
      const fixture = document.getElementById('fixture'); fixture.append(appearance);
      const host = document.createElement('div'); host.dataset.view = 'settings'; host.style.marginTop = '30px'; host.append(settings); fixture.append(host);
      window.geometry = () => [...document.querySelectorAll('#fixture .pane, #fixture .setting, #fixture select')].map(e => ({id:e.id,rect:e.getBoundingClientRect().toJSON()}));
    })()`);
    win.show(); win.focus();
    for (const theme of ['dark', 'light']) for (const zoom of [1, 1.17, 1.5]) for (const id of ['uiLanguage', 'goalBackend']) {
      win.webContents.setZoomFactor(zoom);
      await js(`document.documentElement.dataset.theme='${theme}'; document.activeElement.blur(); new Promise(r=>setTimeout(r,250))`);
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
        const rect=option.getBoundingClientRect(), pane=select.closest('.pane').getBoundingClientRect();
        return rect.bottom>pane.bottom && document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)===option;
      })()`), true, 'The top-layer option outside the card must remain clickable');
      await capture('open');
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'ESCAPE'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'ESCAPE'});
      await js('new Promise(r=>setTimeout(r,200))');
      assert.equal(await js(`document.getElementById('${id}').matches(':open')`), false);
      await capture('closed');
      await js('document.activeElement.blur(); new Promise(r=>setTimeout(r,200))');
      const after = await win.webContents.capturePage();
      const a = baseline.toBitmap(), b = after.toBitmap(), size = baseline.getSize();
      let changed = 0; const points = [];
      for (let y=0;y<size.height;y++) for(let x=0;x<size.width;x++) {
        const i=(y*size.width+x)*4;
        if(a[i]!==b[i] || a[i+1]!==b[i+1] || a[i+2]!==b[i+2]) { changed++; if(points.length<10) points.push({x,y,a:[...a.subarray(i,i+4)],b:[...b.subarray(i,i+4)]}); }
      }
      assert.equal(changed, 0, JSON.stringify({theme,zoom,id,changedPixelsAfterBlur:changed,points}));
    }
    console.log('Settings focus geometry passed: ' + output);
  } finally { win.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });

