// Related folders for a project (#1689): the project menu's item with its own icon, the dialog with
// its explanation, Add from approved folders, Remove, an Unavailable folder in words, the row's hover
// text, and no extra sidebar rows. Real production renderer with synthetic IPC; no app data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const feature = 'related-folders';
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', feature));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `(() => {
 localStorage.setItem('cos.ui.language','en');
 const old=window.api,ok=data=>Promise.resolve({ok:true,data});
 const roots=[{name:'web',path:'/Users/sample/code/web'},{name:'api',path:'/Users/sample/code/api'},{name:'shared-lib',path:'/Users/sample/code/shared-lib'},{name:'design',path:'/Users/sample/design'}];
 window.project={id:'0b6c8f52-4a7e-4d43-9f11-7a2d5c0e9a01',name:'web',path:'/Users/sample/code/web',createdAt:Date.now()-86400000};
 window.saved=[];
 const view=folder=>{const r=roots.find(x=>x.path===folder);return r&&!window.gone?.includes(folder)?{path:folder,name:r.name,virtual:'/'+r.name,available:true}:{path:folder,name:r?.name??null,virtual:null,available:false};};
 const views=()=>(window.project.relatedFolders??[]).map(view);
 const methods={
  markWhatsNewSeen:()=>ok(true),chatGroups:()=>ok({version:1,groups:[],members:{}}),
  listProjects:()=>ok([window.project]),
  // Main pushes session:changed after a save, so the sidebar rereads the project.
  onSessionChanged:fn=>{window.sessionChanged=fn;return old.onSessionChanged?.(fn)??(()=>{});},
  getState:()=>old.getState().then(r=>({...r,data:{...r.data,config:{...r.data.config,roots}}})),
  relatedFolders:()=>ok(views()),
  setRelatedFolders:(id,folders)=>{window.saved.push(folders);window.project={...window.project,...(folders.length?{relatedFolders:folders}:{})};if(!folders.length)delete window.project.relatedFolders;setTimeout(()=>window.sessionChanged?.({}),0);return ok(views());}
 };
 window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'), cacheDir: path.join(output, 'vite'), logLevel: 'error',
    resolve: { alias: { '@phosphor-icons/web': path.join(root, 'node_modules/@phosphor-icons/web/src') } },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules/@phosphor-icons/web/src')), fs.realpathSync(path.join(root, 'node_modules'))] } },
    plugins: [{ name: 'related-folders-fixture', transformIndexHtml: html => html.replace('</head>', '<script src="/related-folders-fixture.js"></script></head>'),
      configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url !== '/related-folders-fixture.js') return next(); res.setHeader('Content-Type', 'text/javascript');
        res.end(fixtureConfigSource() + fs.readFileSync(path.join(root, 'scripts/fixtures/composer-ui.js'), 'utf8') + fixture); }); } }] });
  await server.listen();
  win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });
  const errors = []; win.webContents.on('console-message', e => { if (e.level === 'error' && !BENIGN_RENDERER_ERRORS.includes(e.message)) errors.push(e.message); });
  const js = code => win.webContents.executeJavaScript(code).catch(error => { console.error('Renderer expression:', code); throw error; });
  const until = async expression => { for (const deadline = Date.now() + 15000; Date.now() < deadline;) { if (await js(expression)) return; await pause(40); } throw new Error('Timed out: ' + expression); };
  const shot = async name => { await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`); await pause(250);
    fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG()); };
  const dialog = `document.querySelector('dialog.related-folders-dialog')`;
  const openMenu = async () => {
    await js(`document.querySelector('.project-group .project-menu').click()`);
    await until(`!!document.querySelector('.row-menu-item[data-row-action="related-folders"]')`);
  };
  await win.loadURL(server.resolvedUrls.local[0]);
  await until(`!!document.querySelector('.project-group[data-project-id] .project-heading')`);
  // A project still looks like one folder: one row, its folder as hover text.
  assert.equal(await js(`document.querySelectorAll('.project-group').length`), 1);
  assert.equal(await js(`document.querySelector('.project-heading').title`), '/Users/sample/code/web');

  await openMenu();
  const item = await js(`(() => { const b=document.querySelector('.row-menu-item[data-row-action="related-folders"]'); return {text:b.textContent.trim(), icon:b.querySelector('i')?.className, glyph:getComputedStyle(b.querySelector('i'),'::before').content, groups:document.querySelector('.row-menu-item[data-row-action="group-new"] i')?.className ?? ''}; })()`);
  assert.equal(item.text, 'Related folders…');
  assert.match(item.icon, /ph-link-simple/);
  assert.notEqual(item.icon, item.groups);
  // The glyph is in the app's icon font, not an empty box.
  assert.ok(item.glyph && item.glyph !== 'none' && item.glyph !== 'normal', 'the icon draws');
  await shot('menu.png');
  await js(`document.querySelector('.row-menu-item[data-row-action="related-folders"]').click()`);
  await until(`!!${dialog}?.open`);
  const empty = await js(`(() => { const d=${dialog}; return {title:d.querySelector('h2').textContent, intro:d.querySelector('.related-folders-intro').textContent, empty:!d.querySelector('.related-folders-empty').hidden, options:[...d.querySelectorAll('option')].map(o=>o.textContent)}; })()`);
  assert.equal(empty.title, 'Related folders');
  assert.equal(empty.intro, 'Adds context for ChatGPT; does not change the working directory or grant access.');
  assert.ok(empty.empty);
  // Only approved folders, never the project's own.
  assert.deepEqual(empty.options, ['api — /Users/sample/code/api', 'shared-lib — /Users/sample/code/shared-lib', 'design — /Users/sample/design']);
  await shot('dialog-empty.png');

  await js(`(() => { const d=${dialog}; d.querySelector('select').value='/Users/sample/code/api'; d.querySelector('.related-folders-add .btn').click(); })()`);
  await until(`${dialog}.querySelectorAll('.related-folders-item').length===1`);
  await js(`(() => { const d=${dialog}; d.querySelector('select').value='/Users/sample/code/shared-lib'; d.querySelector('.related-folders-add .btn').click(); })()`);
  await until(`${dialog}.querySelectorAll('.related-folders-item').length===2`);
  assert.deepEqual(await js('window.saved.at(-1)'), ['/Users/sample/code/api', '/Users/sample/code/shared-lib']);
  // A chosen folder leaves the picker, so it can never be added twice.
  assert.deepEqual(await js(`[...${dialog}.querySelectorAll('option')].map(o=>o.value)`), ['/Users/sample/design']);
  await shot('dialog-two.png');
  // A long folder keeps the dropdown on one line, and its tooltip names it in full (2.1.51 polish pass,
  // seen on Windows with a server folder).
  const longLine = await js(`(() => { const s=${dialog}.querySelector('select'); if (!s || s.closest('[hidden]')) return null;
    const o=document.createElement('option'); o.value='/long'; o.textContent='cos-ssh-live — homelab-dev:/home/someone/projects/a-rather-long-folder-name/and-deeper';
    s.append(o); s.value='/long'; s.dispatchEvent(new Event('change')); const h=s.getBoundingClientRect().height, title=s.title; o.remove(); return { h, title }; })()`);
  if (longLine) {
    assert.ok(longLine.h <= 44, `the folder dropdown stays one line: ${longLine.h}px`);
    assert.match(longLine.title, /a-rather-long-folder-name/);
  }
  await js(`${dialog}.querySelector('.file-entry-dialog-actions .btn-solid').click()`);
  await until(`!${dialog}`);
  // Done hands the keyboard back to the project's own menu button, not to the page.
  assert.equal(await js(`document.activeElement?.classList.contains('project-menu') ?? false`), true);
  // The row's hover text names them; still no extra rows.
  await until(`document.querySelector('.project-heading').title.includes('Related folders: api, shared-lib')`);
  assert.equal(await js(`document.querySelectorAll('.project-group').length`), 1);

  // One folder's approval was removed: Unavailable in words and with an icon, and still removable.
  await js(`window.gone=['/Users/sample/code/shared-lib']`);
  await openMenu();
  await js(`document.querySelector('.row-menu-item[data-row-action="related-folders"]').click()`);
  await until(`!!${dialog}?.querySelector('.related-folders-item.is-unavailable')`);
  const unavailable = await js(`(() => { const row=${dialog}.querySelector('.related-folders-item.is-unavailable'); return {state:row.querySelector('.related-folders-state').textContent, icon:row.querySelector('i').className, title:row.title}; })()`);
  assert.equal(unavailable.state, 'Unavailable');
  assert.match(unavailable.icon, /ph-warning/);
  assert.match(unavailable.title, /ChatGPT is not told about it/);
  await shot('dialog-unavailable.png');
  win.setContentSize(420, 760); await until('innerWidth===420'); await pause(200);
  const fits = await js(`(() => { const r=${dialog}.getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth; })()`);
  assert.ok(fits, 'the dialog fits a narrow window');
  await shot('dialog-narrow.png');
  win.setContentSize(1280, 900); await until('innerWidth===1280');
  await js(`${dialog}.querySelector('.related-folders-item.is-unavailable .related-folders-remove').click()`);
  await until(`${dialog}.querySelectorAll('.related-folders-item').length===1`);
  assert.deepEqual(await js('window.saved.at(-1)'), ['/Users/sample/code/api']);
  // Escape closes it like Done, and also hands the keyboard back to the project's menu.
  await js(`${dialog}.dispatchEvent(new Event('cancel',{cancelable:true}))`);
  await until(`!${dialog}`);
  assert.equal(await js(`document.activeElement?.classList.contains('project-menu') ?? false`), true);
  // The project goes away while its dialog is open: closing still works, and no other element is
  // focused in its place (CodeRabbit on #2092).
  await openMenu();
  await js(`document.querySelector('.row-menu-item[data-row-action="related-folders"]').click()`);
  await until(`!!${dialog}`);
  await js(`document.querySelector('.project-group[data-project-id]').remove()`);
  await js(`${dialog}.querySelector('.file-entry-dialog-actions .btn-solid').click()`);
  await until(`!${dialog}`);
  assert.equal(await js(`!!document.activeElement?.closest('[data-row-menu]')`), false);
  assert.deepEqual(errors, []);
  console.log('PASS: ' + feature + ' menu item and icon, dialog text, Add, no duplicates, Unavailable, Remove, hover text, narrow window');
  win.destroy(); await server.close(); app.exit(0);
}).catch(async error => { fs.mkdirSync(output, { recursive: true }); if (win && !win.isDestroyed()) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG()); console.error(error); await server?.close(); app.exit(1); });
