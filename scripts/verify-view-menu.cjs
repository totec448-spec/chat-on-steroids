// Isolated Chromium render of the production View-menu renderer. The backend is synthetic and
// never reads app state; main-process ownership and native focus behavior live in view-menu.test.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/view-menu');
const zoom = 1.17;
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'runtime'));

app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    window.fixtureCommands=[];
    let listener=()=>{};
    window.viewMenuApi={
      command:value=>window.fixtureCommands.push(value),
      close:()=>window.fixtureCommands.push('close'),
      onSnapshot:value=>{listener=value;return()=>{}}
    };
    await import('/view-menu.ts');
    window.fixtureApply=(theme)=>listener({
      petVisible:true,petReady:true,sidebarCollapsed:false,zoomPercent:117,theme,language:'en',
      labels:{pet:'Desktop pets',sidebar:'Toggle Sidebar',zoomIn:'Zoom In',zoomOut:'Zoom Out',actualSize:'Actual Size'}
    });
    window.fixtureApply('dark');
    window.fixtureReady=true;
  `;
  const server = await createServer({
    configFile: false,
    root: path.join(root, 'src/renderer'),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'view-menu-fixture',
      configureServer(vite) {
        vite.middlewares.use('/fixture.html', async (_request, response) => {
          const source = fs.readFileSync(path.join(root, 'src/renderer/view-menu.html'), 'utf8')
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace('</body>', `<script type="module">${fixture}</script></body>`);
          response.setHeader('Content-Type', 'text/html');
          response.end(await vite.transformIndexHtml('/fixture.html', source));
        });
      }
    }]
  });
  let win;
  try {
    await server.listen();
    win = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      width: Math.round(272 * zoom),
      height: Math.round(233 * zoom),
      webPreferences: { sandbox: true, contextIsolation: false, backgroundThrottling: false }
    });
    await win.loadURL(server.resolvedUrls.local[0] + 'fixture.html');
    win.webContents.setZoomFactor(zoom);
    const js = code => win.webContents.executeJavaScript(code);
    for (let attempt = 0; attempt < 100 && !(await js('window.fixtureReady === true')); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(await js('window.fixtureReady'), true);
    await js('document.fonts.ready');
    const metrics = await js(`(() => {
      const buttons=[...document.querySelectorAll('[data-command]')];
      const surface=document.querySelector('.view-menu-surface').getBoundingClientRect();
      return {
        commands:buttons.map(button=>button.dataset.command),
        firstLabel:buttons[0].textContent.trim(),
        checked:buttons.filter(button=>button.getAttribute('aria-pressed')==='true').map(button=>button.dataset.command),
        surface:[surface.width,surface.height],
        viewport:[innerWidth,innerHeight],
        overflow:document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight,
        icons:buttons.map(button=>button.querySelector('.ico')?.getAttribute('class')),
        checks:document.querySelectorAll('.menu-check.ph-check').length,
        customActionSvgs:document.querySelectorAll('.view-menu-surface svg').length,
        iconFont:getComputedStyle(document.querySelector('.ico')).fontFamily,
        iconContent:getComputedStyle(document.querySelector('#viewPet .ico'),'::before').content,
        iconWidth:document.querySelector('#viewPet .ico').getBoundingClientRect().width,
        iconRects:buttons.map(button=>{const rect=button.querySelector('.ico').getBoundingClientRect();return [rect.x,rect.y,rect.width,rect.height]}),
        fontReady:document.fonts.check('16px "CoS Phosphor"')
      };
    })()`);
    assert.deepEqual(metrics.commands, ['pet', 'sidebar', 'zoom-in', 'zoom-out', 'zoom-reset']);
    assert.ok(metrics.firstLabel.startsWith('Desktop pets'), JSON.stringify(metrics));
    assert.deepEqual(metrics.icons, [
      'ico ph ph-paw-print', 'ico ph ph-sidebar-simple', 'ico ph ph-magnifying-glass-plus',
      'ico ph ph-magnifying-glass-minus', 'ico ph ph-corners-out'
    ]);
    assert.equal(metrics.checks, 2);
    assert.equal(metrics.customActionSvgs, 0);
    assert.ok(metrics.iconFont.includes('CoS Phosphor'), JSON.stringify(metrics));
    assert.notEqual(metrics.iconContent, 'none', JSON.stringify(metrics));
    assert.ok(metrics.iconWidth > 0, JSON.stringify(metrics));
    assert.equal(metrics.fontReady, true, JSON.stringify(metrics));
    assert.deepEqual(metrics.checked, ['pet', 'sidebar']);
    assert.equal(metrics.overflow, false);
    // Fractional Electron zoom can expose a subpixel remainder at the viewport edge.
    assert.ok(Math.abs(metrics.surface[0] - metrics.viewport[0]) < 1, JSON.stringify(metrics));
    assert.ok(Math.abs(metrics.surface[1] - metrics.viewport[1]) < 1, JSON.stringify(metrics));
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
    const darkImage = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    const darkBitmap = darkImage.toBitmap();
    const darkSize = darkImage.getSize();
    const scaleX = darkSize.width / metrics.viewport[0];
    const scaleY = darkSize.height / metrics.viewport[1];
    const painted = metrics.iconRects.map(([x,y,w,h]) => {
      let count = 0;
      const left = Math.max(0, Math.floor(x * scaleX));
      const top = Math.max(0, Math.floor(y * scaleY));
      const right = Math.min(darkSize.width, Math.ceil((x + w) * scaleX));
      const bottom = Math.min(darkSize.height, Math.ceil((y + h) * scaleY));
      for (let py = top; py < bottom; py++) for (let px = left; px < right; px++) {
        const offset = (py * darkSize.width + px) * 4;
        if (darkBitmap[offset] > 100 || darkBitmap[offset + 1] > 100 || darkBitmap[offset + 2] > 100) count++;
      }
      return count;
    });
    assert.ok(painted.every(count => count > 2), JSON.stringify({ painted, metrics }));
    fs.writeFileSync(path.join(output, 'dark.png'), darkImage.toPNG());
    await js(`window.fixtureApply('light');new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(output, 'light.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    await js(`document.getElementById('viewPet').click();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    assert.deepEqual(await js('window.fixtureCommands'), ['pet', 'close']);
    console.log('View menu: five commands, lab-approved Phosphor icons, checked states, themes and bounds verified in Chromium.');
  } finally {
    win?.destroy();
    await server.close();
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
