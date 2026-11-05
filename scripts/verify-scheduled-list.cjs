// Real Chromium proof for the global Scheduled projection. Uses only fake chats in an isolated
// offscreen Electron window; never touches the installed app or its saved schedules.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = require('node:child_process').spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(run.stdout || '');
  process.stderr.write(run.stderr || '');
  process.exit(run.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/scheduled-list');
app.setPath('userData', path.join(root, '.tmp/scheduled-list-ui-profile'));
app.disableHardwareAcceleration();
const painted = win => win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
const saveCapture = async (window, file) => {
  await painted(window);
  const image = await window.webContents.capturePage();
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  assert.equal(bitmap.length, width * height * 4, 'Screenshot has four channels');
  await sharp(bitmap, { raw: { width, height, channels: 4 } }).png().toFile(path.join(output, file));
};

app.whenReady().then(async () => {
  const code = (await require('esbuild').build({
    entryPoints: [path.join(root, 'src/renderer/scheduled.ts')],
    bundle: true, write: false, platform: 'browser', format: 'iife',
    globalName: 'scheduledView', logLevel: 'error'
  })).outputFiles[0].text;
  // The data: fixture has no Vite resolver. Inline the same bundled icon font
  // so a screenshot represents actual icon shapes, not missing-font squares.
  const glyph = (variant, filename) => 'data:font/woff2;base64,' +
    fs.readFileSync(path.join(root, 'node_modules/@phosphor-icons/web/src', variant, filename)).toString('base64');
  const iconCss = fs.readFileSync(path.join(root, 'src/renderer/icons.css'), 'utf8')
    .replace('@phosphor-icons/web/regular/Phosphor.woff2', glyph('regular', 'Phosphor.woff2'))
    .replace('@phosphor-icons/web/fill/Phosphor-Fill.woff2', glyph('fill', 'Phosphor-Fill.woff2'));
  const css = [iconCss, ...['styles.css', 'settings.css', 'scheduled.css']
    .map(file => fs.readFileSync(path.join(root, 'src/renderer', file), 'utf8'))].join('\n');
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
    .replace(/<link[^>]+rel="stylesheet"[^>]*\/>/g, '')
    .replace(/<script[^>]+src="\.\/main\.ts"[^>]*><\/script>/, '')
    .replace('</head>', '<style>' + css + '</style></head>');
  const win = new BrowserWindow({ show: false, width: 1280, height: 820,
    webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await win.webContents.executeJavaScript(code);
    const js = source => win.webContents.executeJavaScript(source);
    await js(`(() => {
      const motionOff=document.createElement('style');
      motionOff.textContent='*{animation:none!important;transition:none!important;}';
      document.head.append(motionOff);
      document.documentElement.dataset.theme='dark';
      document.querySelector('.app').dataset.screen='library';
      document.querySelectorAll('.panel').forEach(panel => panel.classList.toggle('is-active', panel.dataset.panel==='scheduled'));
      document.querySelector('#sidebarScheduled').classList.add('is-sel');
      const now=Date.now();
      const nextDaily=new Date(now);
      nextDaily.setHours(9,0,0,0);
      if(nextDaily.getTime()<=now) nextDaily.setDate(nextDaily.getDate()+1);
      const fixtures=[
        {id:'schedule-1',sessionId:'fixture-economics',sessionTitle:'Economics monitoring',text:'Review the latest economic indicators and summarize new official publications.',repeat:{kind:'daily',at:'09:00'},until:null,paused:false,createdAt:now-86400000,lastDueAt:null,nextRunAt:nextDaily.getTime()},
        {id:'schedule-2',sessionId:'fixture-politics',sessionTitle:'Politics overview',text:'Review the National Congress agenda and cite primary documents.',repeat:{kind:'weekdays',at:'08:30'},until:null,paused:true,createdAt:now-3600000,lastDueAt:null,nextRunAt:null}
      ];
      window.fixture={rows:fixtures,actions:[],fail:false};
      const ok=data=>Promise.resolve({ok:true,data});
      window.scheduledController=scheduledView.initScheduled({
        list:()=>window.fixture.fail?Promise.resolve({ok:false,error:'Fixture read failure'}):ok(window.fixture.rows.map(row=>({...row}))),
        pause:(sessionId,paused)=>{window.fixture.actions.push(['pause',sessionId,paused]);window.fixture.rows.find(row=>row.sessionId===sessionId).paused=paused;return ok(true);},
        runNow:sessionId=>{window.fixture.actions.push(['runNow',sessionId]);return ok(true);},
        delete:sessionId=>{window.fixture.actions.push(['delete',sessionId]);window.fixture.rows=window.fixture.rows.filter(row=>row.sessionId!==sessionId);return ok(true);},
        openChat:sessionId=>{window.fixture.actions.push(['openChat',sessionId]);}
      });
    })()`);
    await js('window.scheduledController.refresh().then(() => true)');
    const preview = await js(`(() => { try {
      const rows=[...document.querySelectorAll('.scheduled-index-row')];
      const bounds=rows.map(row=>{const r=row.getBoundingClientRect();return {width:r.width,height:r.height,right:r.right}});
      return {length:rows.length,titles:rows.map(row=>row.querySelector('h2').textContent),
        rowsVisible:bounds.every(r=>r.width>0&&r.height>0&&r.right<=innerWidth+1),
        actions:rows.map(row=>[...row.querySelectorAll('button')].map(button=>button.textContent))};
    } catch(error) {return {error:String(error)}} })()`);
    assert.equal(preview.length, 2);
    assert.deepEqual(preview.titles, ['Economics monitoring', 'Politics overview']);
    assert(preview.rowsVisible, 'both scheduled rows fit the app width');
    assert(preview.actions[0].includes('Run now') && preview.actions[0].includes('Pause'));
    assert(preview.actions[1].includes('Resume'));
    fs.mkdirSync(output, { recursive: true });
    await saveCapture(win, 'scheduled-dark.png');
    await js("document.querySelector('.scheduled-index-row button').click(); true");
    const actions = await js('JSON.stringify(window.fixture.actions)');
    assert.equal(actions, JSON.stringify([['openChat', 'fixture-economics']]));
    await js(`(() => {document.documentElement.dataset.theme='light';window.fixture.rows=[];return true})()`);
    await js('window.scheduledController.refresh().then(() => true)');
    const empty = await js(`(() => ({text:document.querySelector('.scheduled-index-empty')?.textContent,overflow:document.documentElement.scrollWidth>innerWidth}))()`);
    assert.match(empty.text, /No scheduled messages yet/);
    assert.equal(empty.overflow, false);
    await saveCapture(win, 'scheduled-empty-light.png');
    console.log('Passed: global Scheduled view renders two chats, actions and paused state; empty state fits the light window.');
    console.log('Screenshots: outputs/scheduled-list/scheduled-dark.png and scheduled-empty-light.png');
  } finally {
    win.destroy();
  }
}).then(() => app.exit(0), error => { console.error('Scheduled UI check failed:', error?.stack || String(error)); app.exit(1); });
