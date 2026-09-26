// Isolated Chromium layout probe. No provider or project data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/panel-motion');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'runtime'));

app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    const {showSlidingPanel,hideSlidingPanel}=await import('/panel-motion.ts');
    const app=document.querySelector('.app'), chat=document.querySelector('[data-panel="chat"]');
    const file=document.createElement('aside'); file.className='file-panel'; file.hidden=true; chat.append(file);
    const terminal=document.createElement('section'); terminal.className='workspace-terminal'; terminal.hidden=true; app.append(terminal);
    window.motion={
      sidebar(open){app.classList.toggle('is-sidebar-collapsed',!open)},
      files(open){if(open){showSlidingPanel(file,'right');chat.classList.add('has-file-panel')}
        else{hideSlidingPanel(file,'right');chat.classList.remove('has-file-panel')}},
      terminal(open){if(open){showSlidingPanel(terminal,'up');app.classList.add('has-terminal')}
        else{hideSlidingPanel(terminal,'up');app.classList.remove('has-terminal')}}
    };
    window.motionReady=true;
  `;
  const server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'),
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'panel-motion-fixture', configureServer(vite) {
      vite.middlewares.use('/fixture.html', async (_, response) => {
        const source = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace('</head>', '<link rel="stylesheet" href="/icons.css"></head>')
          .replace('</body>', '<script type="module">' + fixture + '</script></body>');
        response.setHeader('Content-Type', 'text/html');
        response.end(await vite.transformIndexHtml('/fixture.html', source));
      });
    } }] });
  let win;
  try {
    await server.listen();
    win = new BrowserWindow({ show: true, width: 1100, height: 800, webPreferences: { sandbox: true, backgroundThrottling: false } });
    await win.loadURL(server.resolvedUrls.local[0] + 'fixture.html');
    win.webContents.setZoomFactor(1);
    const js = code => win.webContents.executeJavaScript(code);
    for (let i = 0; i < 100 && !(await js('window.motionReady === true')); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await js('window.motionReady'), true);
    assert.equal(await js('document.fonts.ready.then(() => true)'), true);
    assert.equal(await js("matchMedia('(prefers-reduced-motion: reduce)').matches"), false,
      'motion acceptance requires a no-preference Chromium environment');
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const sampleMotion = (action, key, open) => js(`new Promise(resolve => {
      const read = () => {
        const app=document.querySelector('.app');
        const cols=getComputedStyle(app).gridTemplateColumns.split(' ').map(parseFloat);
        const rows=getComputedStyle(app).gridTemplateRows.split(' ').map(parseFloat);
        const work=getComputedStyle(document.querySelector('[data-panel="chat"]')).gridTemplateColumns.split(' ').map(parseFloat);
        return ({sidebar:cols[0],files:work[1],terminal:rows[4]})['${key}'];
      };
      const values=[], started=performance.now();
      window.motion.${action}(${open});
      const tick=()=>{values.push(read());if(performance.now()-started<280)requestAnimationFrame(tick);else resolve(values)};
      requestAnimationFrame(tick);
    })`);
    const refreshMetrics = await js(`(() => {
      const button = document.querySelector('#chatRefresh');
      const icon = button.querySelector('.ico');
      const buttonBounds = button.getBoundingClientRect();
      const iconBounds = icon.getBoundingClientRect();
      return {
        button: [buttonBounds.width, buttonBounds.height],
        icon: [iconBounds.width, iconBounds.height],
        translate: getComputedStyle(icon, '::before').translate
      };
    })()`);
    assert.ok(refreshMetrics.button.every(value => Math.abs(value - 26) < 0.1), JSON.stringify(refreshMetrics));
    assert.ok(refreshMetrics.icon.every(value => Math.abs(value - 16) < 0.1), JSON.stringify(refreshMetrics));
    assert.equal(refreshMetrics.translate, '-1px 2px');
    const modeMenuGeometry = await js(`(() => {
      const details = document.querySelector('#composerSettings');
      const summary = document.querySelector('#composerSettingsSummary');
      const control = document.querySelector('#composerModeControl');
      const label = document.querySelector('#composerModeLabel');
      const clear = document.querySelector('#clearComposerMode');
      const popover = details.querySelector('.composer-popover');
      details.open = true;
      return ['', 'Goal', 'Loop + Plan'].map(text => {
        const active = text.length > 0;
        summary.toggleAttribute('data-mode-active', active);
        control.toggleAttribute('data-mode-active', active);
        label.hidden = !active;
        label.textContent = text;
        clear.hidden = !active;
        const detailsBounds = details.getBoundingClientRect();
        const summaryBounds = summary.getBoundingClientRect();
        const popoverBounds = popover.getBoundingClientRect();
        return {
          mode: text || 'Off',
          triggerWidth: summaryBounds.width,
          popoverLeft: popoverBounds.left,
          popoverCenter: popoverBounds.left + popoverBounds.width / 2,
          iconAnchor: detailsBounds.left + 18
        };
      });
    })()`);
    assert.ok(modeMenuGeometry[0].triggerWidth < modeMenuGeometry[1].triggerWidth, JSON.stringify(modeMenuGeometry));
    assert.ok(modeMenuGeometry[1].triggerWidth < modeMenuGeometry[2].triggerWidth, JSON.stringify(modeMenuGeometry));
    for (const state of modeMenuGeometry) {
      assert.ok(Math.abs(state.popoverLeft - modeMenuGeometry[0].popoverLeft) < 0.1, JSON.stringify(modeMenuGeometry));
      assert.ok(Math.abs(state.popoverCenter - state.iconAnchor) < 0.1, JSON.stringify(modeMenuGeometry));
    }
    await js(`(() => {
      const details = document.querySelector('#composerSettings');
      const summary = document.querySelector('#composerSettingsSummary');
      const control = document.querySelector('#composerModeControl');
      const label = document.querySelector('#composerModeLabel');
      const clear = document.querySelector('#clearComposerMode');
      details.open = false;
      summary.removeAttribute('data-mode-active');
      control.removeAttribute('data-mode-active');
      label.hidden = true;
      label.textContent = '';
      clear.hidden = true;
    })()`);
    const phases = [
      ['sidebar', 'sidebar', 180], ['files', 'files', 280], ['terminal', 'terminal', 130]
    ];
    await js('window.motion.sidebar(false)');
    await wait(260);
    for (const [action, key, minimum] of phases) {
      const opening = await sampleMotion(action, key, true);
      const opened = opening.at(-1);
      const entering = opening.find(value => value > 1 && value < opened - 1);
      assert.ok(opened >= minimum, `${action} did not open: ${JSON.stringify(opening)}`);
      assert.notEqual(entering, undefined, `${action} did not interpolate open: ${JSON.stringify(opening)}`);
      if (action === 'sidebar') {
        await js(`Promise.all(document.querySelector('.sidebar').getAnimations().map(animation => animation.finished.catch(() => undefined)))`);
        const exposure = await js(`(() => {
          const sidebar = document.querySelector('.sidebar');
          return {
            clipPath: getComputedStyle(sidebar).clipPath,
            cornerWidth: parseFloat(getComputedStyle(sidebar, '::before').width)
          };
        })()`);
        assert.ok(Math.abs(exposure.cornerWidth - 18) < 0.1, `unexpected workspace corner width: ${exposure.cornerWidth}`);
        const rightClip = Number(exposure.clipPath.split(' ')[1]?.replace('px', ''));
        assert.ok(Number.isFinite(rightClip) && rightClip <= -(exposure.cornerWidth + 1),
          `the expanded sidebar clipped its rounded workspace corner: ${JSON.stringify(exposure)}`);
      }
      const closing = await sampleMotion(action, key, false);
      const closed = closing.at(-1);
      const exiting = closing.find(value => value > closed + 1 && value < opened - 1);
      assert.ok(closed < 2, `${action} did not close: ${JSON.stringify(closing)}`);
      assert.notEqual(exiting, undefined, `${action} did not interpolate closed: ${JSON.stringify(closing)}`);
      if (action === 'sidebar') {
        await js(`Promise.all(document.querySelector('.sidebar').getAnimations().map(animation => animation.finished.catch(() => undefined)))`);
        const closedSidebar = await js(`(() => {
          const style = getComputedStyle(document.querySelector('.sidebar'));
          return { visibility: style.visibility, pointerEvents: style.pointerEvents };
        })()`);
        assert.deepEqual(closedSidebar, { visibility: 'hidden', pointerEvents: 'none' });
      }
    }
    await js('window.motion.sidebar(true);window.motion.files(true);window.motion.terminal(true)');
    await wait(260);
    const refreshPoint = await js(`(() => { const rect = document.querySelector('#chatRefresh').getBoundingClientRect(); return [rect.x + rect.width / 2, rect.y + rect.height / 2]; })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: refreshPoint[0], y: refreshPoint[1] });
    await wait(50);
    fs.writeFileSync(path.join(output, 'open.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    console.log('Panel motion: three directions opened and closed with intermediate Chromium geometry.');
  } finally {
    win?.destroy();
    await server.close();
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
