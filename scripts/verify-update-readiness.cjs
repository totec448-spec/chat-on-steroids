// Production renderer in isolated Electron; synthetic evidence, no installed app or provider.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { fixtureConfigSource } = require('./fixtures/app-defaults.cjs');
const root = path.resolve(__dirname, '..');
const built = path.join(root, 'out/renderer');
const output = path.join(root, 'outputs/update-readiness');
const before = process.argv.includes('--before');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const fixture = `${fixtureConfigSource()}
    const p = new URLSearchParams(location.search);
    localStorage.setItem('cos.ui.language', p.get('lang') || 'en');
    const state = { config: fixtureConfig({ roots: [{name:'fixture',path:'/fixture/project'}],
      ui:{theme:p.get('theme')||'dark',lastSeenVersion:'2.1.31'}, multiAgent:{enabled:false} }),
      hasApiKey:true, hasGoalKey:false, hasCustomProviderKey:false, connectorSchemas:{core:'schema-a'},
      connectorRefresh:{core:{schemaId:'schema-a',state:'current'}},
      status:{state:'connected',detail:'',health:null,handshakeAt:Date.now(),lastRequestAt:Date.now(),lastToolCallAt:Date.now(),surfaces:[
        {id:'core',connectorName:'Chat On Steroids Core',description:'Core',cardSummary:'Files and terminal',optional:false,available:true,
          tools:['read'],state:'live',detail:'',localUrl:null,publicUrl:null,lastRequestAt:Date.now(),lastToolCallAt:Date.now()}]},
      bridge:{running:true,paired:true,present:true,extensionVersion:'2.1.31',externalExtension:{present:true,version:'2.1.31',signedIn:true}},
      update:{current:'2.1.31',latest:null,stage:'idle',checkedAt:Date.now(),error:null}};
    const ok=data=>Promise.resolve({ok:true,data}); let listener=()=>{};
    window.fixtureState=state; window.mutations=[];
    window.api=new Proxy({getState:()=>ok(state),getLog:()=>ok([]),listProjects:()=>ok([]),
      listSessions:()=>ok({sessions:[],activeId:null,pressure:[]}),listInputs:()=>ok([]),runningTools:()=>ok([]),listPausedHelpers:()=>ok([]),
      getSwarm:()=>ok({running:false,agents:[],pendingReports:0}),getChatModels:()=>ok({state:'unknown',models:[]}),
      onStateChanged:fn=>{listener=fn;return()=>{}},onSessionChanged:()=>()=>{},
      installUpdate:()=>{window.mutations.push('install');return ok(true)},connect:()=>{window.mutations.push('connect');return ok(state)},
      updateAll:()=>{window.mutations.push('update-all');return new Promise(resolve=>{window.fixtureFinishUpdate=()=>resolve({ok:true,data:'checking-connectors'})})}
    },{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:()=>ok(null)});
    window.fixturePush=next=>listener(next);`;
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/fixture.js') { response.setHeader('Content-Type','text/javascript'); response.end(fixture); return; }
    const file = path.resolve(built, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(built + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    const type = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.png':'image/png'}[path.extname(file)];
    if (type) response.setHeader('Content-Type',type);
    const data = fs.readFileSync(file);
    response.end(path.extname(file) === '.html' ? data.toString().replace('<head>','<head><script src="/fixture.js"></script>') : data);
  });
  let win;
  try {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); fs.mkdirSync(output,{recursive:true});
    win = new BrowserWindow({show:false,width:1100,height:850,webPreferences:{offscreen:true,sandbox:true}});
    const errors = [];
    win.webContents.on('console-message', event => { if (event.level === 'error' && !event.message.includes('ResizeObserver loop')) errors.push(event.message); });
    const js = expression => win.webContents.executeJavaScript(expression);
    const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
    const until = async expression => { const end=Date.now()+8000; while(Date.now()<end) { if(await js(expression)) return; await pause(40); } throw new Error('Timeout: '+expression); };
    const open = async query => {
      await win.loadURL('http://127.0.0.1:'+server.address().port+'/?'+query);
      await until(`document.getElementById('versionLine').textContent.length>0`);
      await js(`document.querySelector('#tabs [data-tab="activity"]').click()`); await pause(400);
      await until(`!document.querySelector('.toast')`);
    };
    const shot = async name => fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());
    if (before) { await open(''); await shot('before.png'); return; }
    for (const lang of ['en','ja','de']) for (const theme of ['dark','light']) {
      await open('lang='+lang+'&theme='+theme);
      await until(`document.getElementById('updateReadinessSummary').dataset.ready==='true'`);
      assert.equal(await js(`document.querySelectorAll('.update-readiness .check.is-ok').length`),3);
      const geometry = await js(`(()=>{const c=document.querySelector('.update-readiness'),a=document.getElementById('updateReviewSetup').getBoundingClientRect();
        return {clipped:[...c.querySelectorAll('strong,p,button')].some(e=>e.scrollWidth>e.clientWidth+1),sideways:c.scrollWidth>c.clientWidth,bottom:a.bottom,height:c.getBoundingClientRect().height,title:document.getElementById('updateReadinessTitle').textContent}})()`);
      assert.ok(!geometry.clipped && !geometry.sideways && geometry.bottom<=850 && geometry.height<600,JSON.stringify(geometry));
      if (lang==='ja') assert.equal(geometry.title,'更新状況');
      await shot('ready-'+lang+'-'+theme+'.png');
    }
    win.setContentSize(700,850);
    for (const lang of ['en','ja']) {
      await open('lang='+lang);
      await js(`(()=>{const next=structuredClone(window.fixtureState);next.connectorRefresh.core.state='manual';window.fixturePush(next)})()`);
      assert.equal(await js(`document.getElementById('updateReadinessSummary').dataset.ready`),'false');
      assert.equal(await js(`document.querySelector('.update-readiness').scrollWidth>document.querySelector('.update-readiness').clientWidth`),false);
      await pause(600); // DOM delivery precedes offscreen compositor publication.
      await shot('manual-'+lang+'-narrow.png');
    }
    win.setContentSize(700,460);
    await js(`document.getElementById('updateReviewSetup').scrollIntoView({block:'nearest'})`);
    const short = await js(`(()=>{const a=document.getElementById('updateReviewSetup').getBoundingClientRect();return {top:a.top,bottom:a.bottom,viewport:innerHeight}})()`);
    assert.ok(short.top>=0 && short.bottom<=short.viewport+1,'Short window action is reachable (subpixel scroll rounding): '+JSON.stringify(short));
    assert.equal(await js(`(()=>{const children=[...document.querySelector('.update-readiness').children].map(e=>e.getBoundingClientRect());return children.some((r,i)=>i>0&&r.top<children[i-1].bottom-1)})()`),false,'Short window does not compress text rows into each other');
    await pause(200);
    await shot('short-ja.png');
    // Keyboard focus and action remain stable while fresh bridge evidence arrives.
    await js(`document.getElementById('updateReviewSetup').focus();window.fixturePush(window.fixtureState)`);
    assert.equal(await js(`document.activeElement.id`),'updateReviewSetup');
    assert.deepEqual(await js('window.mutations'),[]);
    win.webContents.focus();
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
    win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
    await until(`document.querySelector('[data-panel="setup"]').classList.contains('is-active')`);
    win.setContentSize(1100,850); await open('lang=en');
    await js(`document.getElementById('updateAll').click();document.getElementById('updateAll').click();window.fixtureState.update.stage='checking';window.fixturePush(window.fixtureState)`);
    assert.deepEqual(await js('window.mutations'),['update-all'],'Explicit action only, with duplicate clicks joined');
    assert.equal(await js(`document.getElementById('updateAll').disabled`),true);
    await pause(400); await shot('updating-en-dark.png');
    await js('window.fixtureFinishUpdate()');
    await until(`!document.getElementById('updateAll').disabled`);
    assert.deepEqual(errors,[],'No production renderer errors');
    console.log('PASS: production update status, all three proofs, live transitions, stable keyboard action, no mutations, en/ja/de, both themes and narrow layout');
  } finally { win?.destroy(); await new Promise(resolve=>server.close(resolve)); app.quit(); }
}).catch(error=>{ console.error(error); app.exit(1); });
