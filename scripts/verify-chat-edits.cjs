// Real Electron/production renderer, with synthetic chats and IPC.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = process.env.COS_UI_OUTPUT;
const baseline = process.argv.includes('--before');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-review-chat-'));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();

const fixture = `(() => {
  localStorage.setItem('cos.ui.language','en');
  const base=window.api,f=composerFixture,now=Date.now(),ok=data=>Promise.resolve({ok:true,data});
  const project={id:'sample-project',name:'Demo project',path:'/home/you/project',createdAt:1};
  Object.assign(f.summary,{title:'Update the dashboard',projectId:project.id,contextTokens:0,estimatedTokens:0});
  const empty={...f.summary,id:'chat-with-no-edits',title:'Plan the next update',conversationId:'other-chat',chatIds:['other-chat']};
  const stored=text=>({text,chars:text.length,truncated:false});
  const files=['src/dashboard.ts','docs/legacy-notes.md','docs/old-guide.md'];
  const rows=files.map((path,i)=>({path,callId:'00000000-0000-4000-8000-00000000000'+(i+2),index:0,position:i+2,
    state:['changed','deleted','missing'][i],reviewable:i!==2}));
  f.events[0].message=stored('Update the dashboard heading and clean up the old notes.');
  f.events.at(-1).message=stored('The dashboard now shows the project name. I removed the legacy notes.');
  f.events.at(-1).seq=5;
  f.events.splice(1,0,...rows.map((row,i)=>({seq:row.position,time:now+row.position,source:'mcp',kind:'tool_call',turnId:'t-1',
    call:{callId:row.callId,tool:'apply_patch',args:stored('{}'),result:stored('Applied patch'),summary:{kind:i===1?'delete':'edit',
    title:(i===1?'Deleted ':'Edited ')+row.path,tone:'good'},outcome:'ok',attribution:'request_id',attributionMethod:'request_id',
    conversationId:f.summary.conversationId,durationMs:120,changes:[{path:'/demo/'+row.path,added:i===1?0:1,removed:1,approximate:false,
    ...(row.reviewable?{reviewAssetId:'synthetic-edit'}:{reviewUnavailable:'not-kept'})}]}})));
  const methods={
    getState:async()=>{const reply=await base.getState();reply.data.config=fixtureMerge(fixtureDefaults,reply.data.config);return reply;},
    listProjects:()=>ok([project]),
    listSessions:()=>ok({sessions:[f.summary,empty],activeId:f.summary.id,pressure:[]}),
    getSession:id=>id===empty.id?ok({summary:empty,events:[{...f.events[0],message:stored('What should we do next?')}],total:1,nextFrom:2}):base.getSession(id),
    turnTraces:()=>ok({}), watchProjectFiles:()=>ok(true), markWhatsNewSeen:()=>ok(true),
    chatGroups:()=>ok({version:1,groups:[],members:{}}),
    getSessionControls:id=>ok({...f.controls,sessionId:id}),
    getProjectGitSnapshot:()=>ok({projectId:project.id,state:'ready',revision:'sample',currentBranch:'main',branches:[],truncated:false,
      changes:[{status:'M',path:'README.md',additions:2,deletions:1,binary:false},{status:'U',path:'notes.txt',additions:3,deletions:0,binary:false}]}),
    getProjectGitDiff:(_id,path)=>ok({projectId:project.id,path,status:'M',binary:false,tooLarge:false,additions:2,deletions:1,
      baseText:'Before Git edit\\n',currentText:'After Git edit\\n'}),
    getChatEdits:(id,p)=>{if(p!==project.id)throw Error('wrong project');return ok({rows:id===f.summary.id?rows:[],limited:false});},
    getToolEditReview:(id,callId,changeIndex,p)=>{
      if(id!==f.summary.id||p!==project.id||changeIndex!==0)throw Error('wrong review owner');
      const row=rows.find(row=>row.callId===callId);
      return ok({callId,changeIndex,path:row.path,added:1,removed:1,
        baseText:'export const title = "Dashboard";\\n',currentText:'export const title = "Project dashboard";\\n'});
    }
  };
  window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:base[key]});
})();`;

let server, win;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const icons = path.join(root, 'node_modules/@phosphor-icons/web/src');
  server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'), cacheDir: path.join(profile, 'vite'),
    logLevel: 'error', resolve: { alias: { '@phosphor-icons/web': icons } }, server: { host: '127.0.0.1', port: 0,
      fs: { allow: [root, fs.realpathSync(icons)] } }, plugins: [{
      name: 'chat-edits-fixture', transformIndexHtml: html => html.replace('</head>', '<script src="/review-fixture.js"></script></head>'),
      configureServer(vite) {
        vite.middlewares.use('/review-fixture.js', (_req, res) => {
          res.setHeader('Content-Type', 'text/javascript');
          res.end(fixtureConfigSource() + fs.readFileSync(path.join(root, 'scripts/fixtures/composer-ui.js'), 'utf8') + fixture);
        });
      }
    }]
  });
  await server.listen();
  win = new BrowserWindow({ show: false, width: 1200, height: 760,
    webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error' && !BENIGN_RENDERER_ERRORS.includes(event.message)) errors.push(event.message); });
  const js = code => win.webContents.executeJavaScript(code);
  const until = async expression => {
    for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
      if (await js(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error('Timed out: ' + expression + ' ' + errors.join('; ') + ' ' + await js(`JSON.stringify({ dock: document.querySelector('#workDockRight')?.hidden, panel: document.querySelector('.review-panel')?.hidden, list: document.querySelector('.review-panel .review-chat-edits')?.textContent, title: document.querySelector('.chat-title')?.textContent })`));
  };
  const open = async id => {
    await until(`!!document.querySelector('.sess[data-id="${id}"]')`);
    await js(`document.querySelector('.sess[data-id="${id}"]').click()`);
  };
  await win.loadURL(server.resolvedUrls.local[0]);
  await open('composer-preview');
  const quick = '#workDockRight .work-dock-quick[data-view=review]';
  await until(`document.querySelector('${quick}')?.disabled === false`);
  await js(`document.getElementById('rightDockToggle').click(); document.querySelector('${quick}').click()`);
  await until(`!!document.querySelector('.review-panel [data-path="README.md"]')`);
  const rows = '.review-panel .review-chat-edits button';
  if (!baseline) await until(`document.querySelectorAll('${rows}').length === 3`);
  const shot = async name => {
    if (!output) return;
    fs.mkdirSync(output, { recursive: true });
    await until(`!document.querySelector('#workDockRight').hidden && !document.querySelector('#workDockRight').classList.contains('is-moving')`);
    await until(`!document.querySelector('.toast')`);
    await js('document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})');
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  };
  await shot(baseline ? 'before' : 'after');
  if (!baseline) {
    assert.equal(await js(`document.querySelector('.review-panel .review-chat-edits [data-path="docs/legacy-notes.md"]').textContent.endsWith('Deleted')`), true);
    assert.equal(await js(`document.querySelector('.review-panel .review-chat-edits [data-path="docs/old-guide.md"]').textContent.endsWith('Missing')`), true);
    await js(`document.querySelector('${rows}').click()`);
    await until(`document.querySelector('.review-panel .cm-editor')?.textContent.includes('Project dashboard')`);
    await shot('recorded-diff');
    await js(`document.querySelector('.review-panel button[aria-label="Go to recorded edit"]').click()`);
    await until(`!!document.querySelector('#timeline .ev-tool_call.is-search-hit')`);
    assert.equal(await js(`document.activeElement.closest('.ev-tool_call')?.classList.contains('is-search-hit')`), true);
    await open('chat-with-no-edits');
    await until(`!document.querySelector('.review-panel .review-chat-edits').closest('[hidden]') && document.querySelector('.review-panel .review-chat-edits').textContent.includes('No recent recorded edits.')`);
    assert.equal(await js(`document.querySelectorAll('${rows}').length`), 0);
    await js(`document.querySelector('.review-panel [data-path="README.md"]').click()`);
    await until(`document.querySelector('.review-panel .cm-editor')?.textContent.includes('After Git edit')`);
    await js(`document.querySelector('.review-panel .file-changes-back').click()`);
    await open('composer-preview');
    await until(`document.querySelectorAll('${rows}').length===3`);
    win.setContentSize(760, 860);
    await until('innerWidth===760');
    assert.equal(await js(`[...document.querySelectorAll('${rows}')].every(row=>row.scrollWidth<=row.clientWidth+1)`), true);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: Review dock ' + (baseline ? 'baseline' : 'recorded edits, source jump, chat switch, Git diff, narrow dock'));
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  win?.destroy();
  await server?.close();
  app.exit(process.exitCode || 0);
});
app.on('quit', () => { fs.rmSync(profile, { recursive: true, force: true }); });
