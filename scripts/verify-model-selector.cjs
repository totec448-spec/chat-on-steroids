/** Actual Chromium layout of the shipped selector, with synthetic catalog data only. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const run = require('node:child_process').spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(run.stdout || ''); process.stderr.write(run.stderr || ''); process.exit(run.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const root = path.join(__dirname, '..');
  const { outputFiles } = await require('esbuild').build({ entryPoints: [path.join(root, 'src/renderer/chat-models.ts')], bundle: true,
    write: false, platform: 'browser', format: 'iife', globalName: 'models' });
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '')
    .replace('</head>', '<style>' + fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8') + '</style></head>');
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { offscreen: true, sandbox: true, partition: 'model-selector-fixture', backgroundThrottling: false } });
  win.webContents.on('console-message', event => console.error('Renderer:', event.message));
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await win.webContents.executeJavaScript(`window.api = {getChatModels:async()=>({ok:true,data:{state:'ready',models:[
    {id:'gpt-5-6',label:'5.6',efforts:['none']},
    {id:'gpt-5-6-thinking',label:'5.6',efforts:['medium','high','max'],effortLabels:{max:'Extra High'}},
    {id:'gpt-6-pro',label:'6',efforts:['medium'],effortLabels:{medium:'Pro'}},
    {id:'gpt-5-6-pro',label:'5.6',efforts:['medium']},
    {id:'gpt-5-5-instant',label:'5.5',efforts:['none']},
    {id:'gpt-5-5-thinking',label:'5.5',efforts:['medium','high','max']},
    {id:'gpt-5-5-pro',label:'5.5',efforts:['medium']}
  ]}}),onChatModelsChanged:()=>{}}; void 0;`);
  await win.webContents.executeJavaScript(outputFiles[0].text);
  await win.webContents.executeJavaScript(`models.initChatModels();models.applyChatModels({multiAgent:{},goal:{}});
    document.getElementById('modelMenu').open=true;
    document.getElementById('chatInput').value='Unsaved user draft stays intact.';`);
  const measurements = [];
  for (const width of [1400, 1100, 900]) {
    win.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width, height: 900 },
      viewPosition: { x: 0, y: 0 }, viewSize: { width, height: 900 }, deviceScaleFactor: 1, scale: 1 });
    await new Promise(resolve => setTimeout(resolve, 100));
    const result = await win.webContents.executeJavaScript(`(() => {
      const menu=document.querySelector('#modelMenu .composer-popover'), r=menu.getBoundingClientRect();
      for (const button of document.querySelectorAll('#composerModelChoices button')) button.click();
      document.querySelector('#composerModelChoices [data-model-id="gpt-5-6-thinking"]').click();
      document.querySelector('#composerPowerChoices [data-effort="max"]').click();
      return {width:innerWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom,visible:getComputedStyle(menu).display!=='none',
        models:document.querySelectorAll('#composerModelChoices button').length,selection:models.confirmedComposerModel(),
        draft:document.getElementById('chatInput').value,scrollable:menu.scrollHeight>menu.clientHeight};})()`);
    assert.equal(result.width, width); assert.equal(result.models, 7); assert.equal(result.visible, true);
    assert.ok(result.left >= 0 && result.right <= result.width + 1 && result.top >= 0 && result.bottom <= 900, JSON.stringify(result));
    assert.deepEqual(result.selection, { model: 'gpt-5-6-thinking', reasoningEffort: 'max' });
    assert.equal(result.draft, 'Unsaved user draft stays intact.'); measurements.push(result);
  }
  win.webContents.disableDeviceEmulation(); await new Promise(resolve => setTimeout(resolve, 100));
  const output = path.join(root, 'outputs/model-selector-r6.png'); fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({ ok: true, measurements, screenshot: output }, null, 2)); win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
