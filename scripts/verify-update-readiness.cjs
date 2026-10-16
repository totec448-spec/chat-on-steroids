// Production renderer in isolated Electron; synthetic evidence, no installed app or provider.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { fixtureConfigSource } = require('./fixtures/app-defaults.cjs');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const built = path.join(root, 'out/renderer');
const output = path.join(root, 'outputs/update-readiness');
const before = process.argv.includes('--before');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const fixture = `${fixtureConfigSource()}
    const p = new URLSearchParams(location.search);
    localStorage.setItem('cos.ui.language', p.get('lang') || 'en');
    const state = { config: fixtureConfig({ roots: [{name:'fixture',path:'/fixture/project'}],
      ui:{theme:p.get('theme')||'dark',lastSeenVersion:'${version}'}, multiAgent:{enabled:false} }),
      hasApiKey:true, hasGoalKey:false, hasCustomProviderKey:false, connectorSchemas:{core:'schema-a'},
      connectorRefresh:{core:{schemaId:'schema-a',state:'current'}},
      status:{state:'connected',detail:'',health:null,handshakeAt:Date.now(),lastRequestAt:Date.now(),lastToolCallAt:Date.now(),surfaces:[
        {id:'core',connectorName:'Chat On Steroids Core',description:'Core',cardSummary:'Files and terminal',optional:false,available:true,
          tools:['read'],state:'live',detail:'',localUrl:null,publicUrl:null,lastRequestAt:Date.now(),lastToolCallAt:Date.now()}]},
      bridge:{running:true,paired:true,present:true,extensionVersion:'${version}',externalExtension:{present:true,version:'${version}',signedIn:true}},
      update:{current:'${version}',latest:null,stage:'idle',checkedAt:Date.now(),error:null}};
    const ok=data=>Promise.resolve({ok:true,data}); let listener=()=>{};
    window.fixtureState=state; window.mutations=[];
    window.api=new Proxy({getState:()=>ok(state),getLog:()=>ok(Array.from({length:200},(_,i)=>({time:Date.now()+i,level:'info',message:'Fixture event '+(i+1)+': local operation completed'}))),listProjects:()=>ok([]),
      listSessions:()=>ok({sessions:[],activeId:null,pressure:[]}),listInputs:()=>ok([]),runningTools:()=>ok([]),listPausedHelpers:()=>ok([]),
      getSwarm:()=>ok({running:false,agents:[],pendingReports:0}),getChatModels:()=>ok({state:'unknown',models:[]}),
      onStateChanged:fn=>{listener=fn;return()=>{}},onSessionChanged:()=>()=>{},
      installUpdate:()=>{window.mutations.push('install');return ok(true)},connect:()=>{window.mutations.push('connect');return ok(state)},
      saveDiagnosticsReport:()=>{window.mutations.push('diagnostics-report');return ok({saved:false})},
      updateAll:()=>{window.mutations.push('update-all');return new Promise((resolve,reject)=>{
        window.fixtureFinishUpdate=(reply={ok:true,data:'checking-connectors'})=>resolve(reply);
        window.fixtureRejectUpdate=reason=>reject(new Error(reason));
      })}
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
      assert.equal(await js(`document.getElementById('updateReadinessDetails').open`),false,'Completed status is compact');
      assert.ok(await js(`document.querySelector('.update-readiness').getBoundingClientRect().height`) < 100,'Completed status uses one compact row');
      assert.equal(await js(`(()=>{const b=document.getElementById('updateAll'),r=b.getBoundingClientRect();return r.height>0&&b.contains(document.elementFromPoint(r.left+r.width/2,r.bottom-4))})()`),true,'Update all remains visible and receives pointer input');
      if(lang==='en') await shot('compact-'+theme+'.png');
      await js(`document.getElementById('updateReadinessSummary').click()`);
      assert.equal(await js(`document.getElementById('updateReadinessDetails').open`),true,'The compact status line opens the full card');
      const geometry = await js(`(()=>{const c=document.querySelector('.update-readiness'),a=document.getElementById('updateReviewSetup').getBoundingClientRect();
        return {clipped:[...c.querySelectorAll('strong,p:not(.sr-only),button')].some(e=>e.scrollWidth>e.clientWidth+1),sideways:c.scrollWidth>c.clientWidth,bottom:a.bottom,height:c.getBoundingClientRect().height,title:document.getElementById('updateReadinessTitle').textContent}})()`);
      assert.ok(!geometry.clipped && !geometry.sideways && geometry.bottom<=850 && geometry.height<600,JSON.stringify(geometry));
      assert.equal(await js(`(()=>{const b=document.getElementById('updateAll'),n=document.getElementById(b.getAttribute('aria-describedby'));return n.id==='updateAllNotice'&&n.classList.contains('sr-only')&&n.textContent===b.title})()`),true,'Restart explanation remains linked for assistive technology and pointer users');
      if (lang==='ja') assert.equal(geometry.title,'更新状況');
      // The open card's blocks keep their 12 px rhythm: grid on <details> itself never reaches its
      // children (Chromium lays them out in ::details-content), so the note sat flush under the list.
      const tightest = await js(`(()=>{const d=[...document.getElementById('updateReadinessDetails').children].filter(e=>e.tagName!=='SUMMARY'&&e.getClientRects().length).map(e=>e.getBoundingClientRect());return Math.min(...d.slice(1).map((r,i)=>r.top-d[i].bottom))})()`);
      assert.ok(tightest >= 8, lang+' '+theme+' readiness blocks have room between them: '+tightest);
      await shot('ready-'+lang+'-'+theme+'.png');
    }
    await open('lang=en');
    await js(`document.getElementById('updateReadinessToggle').focus()`);
    win.webContents.focus();
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
    win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
    await until(`document.getElementById('updateReadinessDetails').open`);
    assert.equal(await js(`document.getElementById('updateReadinessToggle').getAttribute('aria-expanded')`),'true');
    await js(`window.fixturePush(structuredClone(window.fixtureState))`);
    assert.equal(await js(`document.getElementById('updateReadinessDetails').open`),true,'Identical pushes preserve manual expansion');
    await js(`(()=>{const next=structuredClone(window.fixtureState);next.connectorRefresh.core={schemaId:'schema-a',state:'unknown',responding:true};window.fixturePush(next)})()`);
    assert.equal(await js(`document.getElementById('updateReadinessDetails').open`),true,'Operational but unverified schemas need attention');
    await pause(600); await shot('schema-unverified-expanded-en.png');
    win.setContentSize(700,850);
    for (const lang of ['en','ja']) {
      await open('lang='+lang);
      await js(`(()=>{const next=structuredClone(window.fixtureState);next.connectorRefresh.core.state='manual';window.fixturePush(next)})()`);
      assert.equal(await js(`document.getElementById('updateReadinessSummary').dataset.ready`),'false');
      assert.equal(await js(`document.querySelector('.update-readiness').scrollWidth>document.querySelector('.update-readiness').clientWidth`),false);
      await pause(600); // DOM delivery precedes offscreen compositor publication.
      await shot('manual-'+lang+'-narrow.png');
    }
    // Activity keeps main's fixed page and lets the event feed use the remaining height.
    win.setContentSize(700,600); await pause(200);
    assert.equal(await js(`(()=>{const p=document.querySelector('[data-panel="activity"]');return p.scrollHeight<=p.clientHeight+1})()`),true,'Long history does not add page scrolling');
    const expandedFeedHeight = await js(`document.getElementById('fullFeed').clientHeight`);
    await js(`document.querySelector('#updateReadinessDetails > summary').click()`);
    assert.ok(await js(`document.getElementById('fullFeed').clientHeight`) > expandedFeedHeight,'Collapsing details returns height to the event feed');
    assert.ok(await js(`document.getElementById('fullFeed').scrollHeight>document.getElementById('fullFeed').clientHeight`),'The event feed owns long-history scrolling');
    assert.equal(await js(`(()=>{const cards=[...document.querySelector('.activity-content').children].map(e=>e.getBoundingClientRect());return cards.some((r,i)=>i>0&&r.top<cards[i-1].bottom-1)})()`),false,'Short Activity page does not overlap its cards');
    await shot('manual-events-narrow.png');
    // The completed compact card must also retain its action at short heights.
    await js(`window.fixturePush(window.fixtureState);document.getElementById('updateAll').scrollIntoView({block:'nearest'})`);
    assert.equal(await js(`(()=>{const b=document.getElementById('updateAll'),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.left+r.width/2,r.bottom-4))})()`),true,'Compact Update all is not covered by the event card');
    await js(`(()=>{const next=structuredClone(window.fixtureState);next.connectorRefresh.core.state='manual';window.fixturePush(next)})()`);
    win.setContentSize(700,460);
    await until(`innerWidth===700&&innerHeight===460`);
    const short = await js(`(()=>{const b=document.getElementById('updateReviewSetup');b.scrollIntoView({block:'nearest'});const a=b.getBoundingClientRect();return {top:a.top,bottom:a.bottom,viewport:innerHeight,reachable:b.contains(document.elementFromPoint(a.left+a.width/2,a.top+a.height/2))}})()`);
    assert.ok(short.top>=0 && short.bottom<=short.viewport+1,'Short window action is reachable (subpixel scroll rounding): '+JSON.stringify(short));
    assert.equal(short.reachable,true,'Short window action receives pointer input');
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
    await js(`(()=>{const next=structuredClone(window.fixtureState);next.update.latest='99.0.0';next.update.stage='ready';window.fixturePush(next)})()`);
    // A ready update is asked about in the app's own dialog, Keep working first (2.1.38).
    for (const theme of ['light','dark']) {
      await open('lang=en&theme='+theme);
      await js(`(()=>{const next=structuredClone(window.fixtureState);next.update.latest='99.0.0';next.update.stage='ready';window.fixturePush(next)})()`);
      await js(`document.getElementById('updateAll').click();window.fixtureFinishUpdate({ok:true,data:'confirm'})`);
      await until(`!!document.getElementById('updateRestartDialog')?.open`);
      assert.equal(await js(`document.activeElement.textContent`),'Keep working','Keep working is the focused default');
      assert.ok(await js(`document.getElementById('updateRestartDialog').textContent.includes('Version 99.0.0')`),'The dialog names the version');
      await pause(900); await shot('restart-dialog-'+theme+'.png');
      if (theme === 'dark') { await js(`document.querySelector('#updateRestartDialog .update-restart-keep').click()`); break; }
    }
    await until(`!document.getElementById('updateAll').disabled`);
    assert.equal(await js(`document.getElementById('updateAllError').hidden`),true,'Cancelling restart is not an error');
    assert.equal(await js(`document.getElementById('updateReadinessSummary').dataset.ready`),'false','A postponed update is still pending');
    assert.ok(await js(`document.querySelector('.toast').textContent.includes('Update postponed. You can keep working.')`));
    assert.deepEqual(await js('window.mutations'),['update-all'],'Keep working invokes no installer or connection');
    await open('lang=en');
    await js(`document.getElementById('updateAll').click();document.getElementById('updateAll').click();window.fixtureState.update.stage='checking';window.fixturePush(window.fixtureState)`);
    assert.deepEqual(await js('window.mutations'),['update-all'],'Explicit action only, with duplicate clicks joined');
    assert.equal(await js(`document.getElementById('updateAll').disabled`),true);
    await pause(400); await shot('updating-en-dark.png');
    await js('window.fixtureFinishUpdate()');
    await until(`!document.getElementById('updateAll').disabled`);
    // Owner failures explain both the known cause and the next explicit action.
    for (const lang of ['en','ja','de']) {
      await open('lang='+lang);
      await js(`(()=>{const next=structuredClone(window.fixtureState);
        next.update.stage='failed';next.update.error='GitHub returned 503';
        next.bridge.extensionVersion='2.1.32';
        next.connectorRefresh.core={schemaId:'schema-a',state:'failed',failure:'inspection'};
        window.fixturePush(next)})()`);
      assert.equal(await js(`document.getElementById('updateReadinessSummary').dataset.ready`),'false');
      assert.ok(await js(`document.querySelector('[data-update-part="app"]').textContent.includes('GitHub returned 503')`));
      const core = await js(`document.querySelector('[data-update-part="core"]').textContent`);
      assert.ok(core.includes(lang==='ja'?'確認できませんでした':lang==='de'?'nicht geprüft':'Could not inspect'),core);
      assert.deepEqual(await js('window.mutations'),[],'Error guidance starts no provider work');
      await js(`document.getElementById('updateAll').click();window.fixtureFinishUpdate({ok:false,error:'Network unavailable'})`);
      await until(`!document.getElementById('updateAll').disabled`);
      assert.equal(await js(`document.getElementById('updateAllError').hidden`),false);
      await until(`!document.querySelector('.toast')`);
      await pause(600);
      await shot('errors-'+lang+'-dark.png');
      await js(`window.fixturePush(window.fixtureState)`);
      assert.equal(await js(`document.getElementById('updateAllError').hidden`),false,'Pushes cannot erase operation failures');
      assert.equal(await js(`document.getElementById('updateReadinessSummary').dataset.ready`),'false','Healthy component pushes do not claim a failed operation passed');
      await js(`document.getElementById('updateAll').click()`);
      assert.equal(await js(`document.getElementById('updateAllError').hidden`),true,'Explicit retry clears the old operation error');
      await js(`window.fixtureRejectUpdate('Network unavailable')`);
      await until(`!document.getElementById('updateAll').disabled`);
      assert.equal(await js(`document.getElementById('updateAllError').hidden`),false,'Rejected IPC is presented and re-enables retry');
      await js(`document.getElementById('updateAll').click();window.fixtureFinishUpdate()`);
      await until(`!document.getElementById('updateAll').disabled`);
      assert.equal(await js(`document.getElementById('updateAllError').hidden`),true);
      assert.equal(await js(`document.getElementById('updateReadinessSummary').dataset.ready`),'true');
    }
    // Manual macOS updates and native permission verdicts reuse the existing owners only.
    const macState = () => `(()=>{const next=structuredClone(window.fixtureState);
      next.platform={family:'macos',name:'macOS',desktopAutomation:true};
      next.config.capabilities.screen=next.config.capabilities.control=true;next.config.readOnly=false;
      next.update.latest='99.0.0';next.update.stage='idle';
      next.status.surfaces.push({...next.status.surfaces[0],id:'desktop',connectorName:'Chat On Steroids Desktop',optional:true,tools:['screen_capture']});
      next.connectorSchemas.desktop='desktop-a';next.connectorRefresh.desktop={schemaId:'desktop-a',state:'current'};
      next.desktopAccess={screen:'missing',accessibility:'missing',checkedAt:Date.now(),error:null};
      window.fixtureMacState=next;window.fixturePush(next)})()`;
    await open('lang=en'); await js(macState());
    assert.equal(await js(`document.getElementById('updateReadinessSummary').dataset.ready`),'false');
    await pause(600); await shot('macos-manual-permissions-en.png');
    // All locales must keep failures and recovery actions accessible outside closed details.
    win.setContentSize(700,600);
    for (const lang of ['en','ja','de','es','fr','ko','pt-BR','pt-PT','ru','tr','vi','zh-CN','zh-TW']) {
      await open('lang='+lang);
      await js(`(()=>{const size=document.getElementById('appearanceSize');size.value='18';size.dispatchEvent(new Event('input',{bubbles:true}))})()`);
      await js(macState());
      const catalog = lang==='en' ? null : JSON.parse(fs.readFileSync(path.join(root,'src/renderer/locales',lang+'.json'),'utf8'));
      const copy = key => catalog ? catalog[key] : key;
      assert.ok(await js(`document.getElementById('updateConnectionNotice').textContent.includes(${JSON.stringify(copy("After updating, the app connects once to finish plugin checks, even if automatic connection is off."))})`),lang+' one-shot connection explained');
      // A live inspection failure must remain explicit even if a tool call worked.
      // The provider's current management page need not display a tool list.
      await js(`(()=>{const next=structuredClone(window.fixtureState);next.connectorRefresh.core={schemaId:'schema-a',state:'failed',failure:'inspection',responding:true};window.fixturePush(next)})()`);
      const inspectionCopy = await js(`document.querySelector('[data-update-part="core"]').textContent`);
      assert.ok(inspectionCopy.includes(copy("Plugin check failed")),lang+' inspection is not called a failed Refresh');
      assert.ok(inspectionCopy.includes(copy("Open this plugin's settings in ChatGPT, then choose Update all to recheck. If the check still fails, save a Diagnostics report from Activity.")),lang+' current management settings and diagnostic guidance');
      assert.equal(await js(`document.getElementById('updateReadinessSummary').dataset.ready`),'false',lang+' successful use cannot erase failed inspection');
      assert.equal(await js(`document.getElementById('updateReadinessDetails').open`),true);
      assert.equal(await js(`(()=>{const c=document.querySelector('.update-readiness');return c.scrollWidth<=c.clientWidth+1&&[...c.querySelectorAll('p:not(.sr-only),button')].every(e=>e.scrollWidth<=e.clientWidth+1)})()`),true,lang+' inspection copy is not horizontally clipped');
      assert.deepEqual(await js('window.mutations'),[],'Displaying inspection failure never retries');
      if(lang==='en'){await pause(200);await shot('inspection-failure-max-text-en.png');}
      await js(`(()=>{const next=structuredClone(window.fixtureState);next.connectorRefresh.core={schemaId:'schema-a',state:'failed',failure:'migration',responding:true};window.fixturePush(next)})()`);
      const migrationCopy = await js(`document.querySelector('[data-update-part="core"]').textContent`);
      assert.ok(migrationCopy.includes(copy("Could not verify the saved plugin against the current tool definitions.")),lang+' saved connector failure');
      assert.ok(migrationCopy.includes(copy("In ChatGPT, refresh this existing plugin, then choose Update all to recheck. If Refresh is unavailable, save a Diagnostics report from Activity.")),lang+' existing-connector manual refresh guidance');
      assert.equal(await js(`document.getElementById('updateReadinessSummary').dataset.ready`),'false',lang+' operational use cannot erase failed migration');
      assert.deepEqual(await js('window.mutations'),[],'Migration guidance never retries');
      assert.equal(await js(`(()=>{const c=document.querySelector('.update-readiness');return c.scrollWidth<=c.clientWidth+1&&[...c.querySelectorAll('p:not(.sr-only),button')].every(e=>e.scrollWidth<=e.clientWidth+1)})()`),true,lang+' migration guidance wraps at maximum text size');
      if(lang==='ja'){await pause(200);await shot('legacy-migration-ja.png');}
      await js(`(()=>{const next=structuredClone(window.fixtureMacState);next.bridge.extensionVersion='99.0.1';window.fixturePush(next)})()`);
      assert.ok(await js(`document.querySelector('[data-update-part="extension"]').textContent.includes(${JSON.stringify(copy('Choose Update all to check for updates and update the app.'))})`),lang+' newer extension directs the person to update the app');
      for (const [present, key] of [
        [true, 'Let active chats finish, then reload the browser extension in your browser.'],
        [false, 'Open ChatGPT with the browser extension enabled, then choose Review setup.']
      ]) {
        await js(present
          ? `(()=>{const next=structuredClone(window.fixtureState);next.bridge.present=true;next.bridge.extensionVersion='0.0.1';window.fixturePush(next)})()`
          : `(()=>{const next=structuredClone(window.fixtureState);next.bridge.present=false;window.fixturePush(next)})()`);
        assert.ok(await js(`document.querySelector('[data-update-part="extension"]').textContent.includes(${JSON.stringify(copy(key))})`),lang+' browser extension recovery');
        assert.doesNotMatch(await js(`document.querySelector('.update-readiness').textContent`), /\bconnectors?\b|\bcompanion extension\b/i, lang+' current visible terminology');
        if(lang==='en'){await pause(200);await shot(present?'older-browser-extension-en.png':'missing-browser-extension-en.png');}
      }
      await js(`window.fixturePush(window.fixtureMacState)`);
      assert.ok(await js(`document.querySelector('[data-update-part="app"]').textContent.includes(${JSON.stringify(copy('Finish active work and fully quit Chat On Steroids. Replace the app in /Applications, then open the updated app from there.'))})`),lang+' manual replacement instructions');
      assert.ok(await js(`document.querySelector('[data-update-part="desktop"]').textContent.includes(${JSON.stringify(copy('Choose Review setup to check macOS permissions, then fully quit and reopen the app.'))})`),lang+' permission instructions');
      assert.equal(await js(`document.querySelector('[data-update-part="desktop"]').classList.contains('is-bad')`),true);
      await js(`document.getElementById('updateReviewSetup').scrollIntoView({block:'nearest'})`);
      assert.equal(await js(`(()=>{const b=document.getElementById('updateReviewSetup'),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`),true,lang+' macOS setup action is reachable');
      assert.equal(await js(`(()=>{const c=document.querySelector('.update-readiness');return c.scrollWidth<=c.clientWidth+1&&[...c.querySelectorAll('p:not(.sr-only),button')].every(e=>e.scrollWidth<=e.clientWidth+1)})()`),true,lang+' macOS copy is not horizontally clipped');
      assert.deepEqual(await js('window.mutations'),[],'Native consent is never requested by a state push');
      await js(`(()=>{const next=structuredClone(window.fixtureMacState);next.update.latest=null;next.desktopAccess.screen=next.desktopAccess.accessibility='granted';window.fixturePush(next)})()`);
      assert.equal(await js(`document.getElementById('updateReadinessSummary').dataset.ready`),'true',lang+' granted permissions restore readiness');
      await js(`(()=>{const size=document.getElementById('appearanceSize');size.value='18';size.dispatchEvent(new Event('input',{bubbles:true}));
        const next=structuredClone(window.fixtureState);next.connectorRefresh.core.state='manual';
        next.status.surfaces.push({...next.status.surfaces[0],id:'plugins',connectorName:'Chat On Steroids Plugins',optional:true,tools:[]});
        window.fixturePush(next)})()`);
      const noTools = lang==='en' ? 'No tools published' : JSON.parse(fs.readFileSync(path.join(root,'src/renderer/locales',lang+'.json'),'utf8'))['No tools published'];
      assert.equal(await js(`Number(getComputedStyle(document.documentElement).getPropertyValue('--text-scale'))`),18/14,lang+' maximum text size is applied');
      assert.ok(await js(`document.querySelector('[data-update-part="plugins"]').textContent.includes(${JSON.stringify(noTools)})`),lang);
      await js(`document.getElementById('updateReviewSetup').scrollIntoView({block:'nearest'})`);
      assert.equal(await js(`(()=>{const b=document.getElementById('updateReviewSetup'),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`),true,lang+' setup is reachable at maximum text size');
      await js(`document.getElementById('updateReadinessDetails').scrollTop=0;document.querySelector('#updateReadinessDetails > summary').click();
        document.getElementById('updateAll').click();window.fixtureFinishUpdate({ok:false,error:'Could not read plugin-refresh state'})`);
      await until(`!document.getElementById('updateAll').disabled`);
      await until(`!document.querySelector('.toast')`);
      assert.equal(await js(`document.getElementById('updateReadinessDetails').open`),true,'A new failure expands the card');
      await js(`document.getElementById('updateReadinessToggle').click()`);
      const accessible=await js(`(()=>{const card=document.querySelector('.update-readiness'),b=document.getElementById('updateAll'),r=b.getBoundingClientRect(),e=document.getElementById('updateAllError'),n=document.getElementById('updateAllNotice'),d=document.getElementById('updateReadinessDetails');return {closed:!d.open,visible:e.checkVisibility(),outside:!d.contains(e)&&!d.contains(n),errorBottom:e.getBoundingClientRect().bottom,buttonVisible:r.bottom<=innerHeight&&b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)),sideways:card.scrollWidth>card.clientWidth+1,clipped:[...card.querySelectorAll('p:not(.sr-only),button')].filter(x=>x.checkVisibility()&&x.scrollWidth>x.clientWidth+1).map(x=>x.id),text:e.textContent,viewport:innerHeight}})()`);
      assert.ok(accessible.closed&&accessible.visible&&accessible.outside&&accessible.buttonVisible&&!accessible.sideways&&!accessible.clipped.length&&accessible.errorBottom<=accessible.viewport,lang+': '+JSON.stringify(accessible));
      assert.ok(!accessible.text.includes('Could not read plugin-refresh state'),lang+' authored diagnostic is translated');
      assert.deepEqual(await js('window.mutations'),['update-all'],'No implicit retry');
      const recovery = await js(`(()=>{const b=document.getElementById('updateDiagnosticsReport'),r=b.getBoundingClientRect(),d=document.getElementById('updateReadinessDetails');return {visible:b.checkVisibility(),outside:!d.contains(b),bottom:r.bottom,reachable:b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)),viewport:innerHeight}})()`);
      assert.ok(recovery.visible&&recovery.outside&&recovery.reachable&&recovery.bottom<=recovery.viewport,lang+' recovery action: '+JSON.stringify(recovery));
      if(lang==='en'){await pause(600);await shot('collapsed-failure-max-text-en.png');}
      await js(`document.getElementById('updateDiagnosticsReport').click()`);
      await until(`!document.getElementById('updateDiagnosticsReport').disabled`);
      assert.deepEqual(await js('window.mutations'),['update-all','diagnostics-report'],'Saving a report cannot retry the update');
      await js(`window.fixturePush(window.fixtureState)`);
      assert.equal(await js(`document.getElementById('updateAllError').checkVisibility()`),true);
      assert.deepEqual(await js('window.mutations'),['update-all','diagnostics-report']);
      // The updater owns network classification; both release-check and download banners
      // must use the same translated reason as the card and retained operation error.
      const networkReason = copy('GitHub could not be reached. Check your connection');
      for (const program of [
        `(()=>{const next=structuredClone(window.fixtureState);next.update={...next.update,stage:'failed',latest:null,error:'GitHub could not be reached'};window.fixturePush(next)})()`,
        `(()=>{const next=structuredClone(window.fixtureState);next.update={...next.update,stage:'failed',latest:'99.0.0',error:'GitHub could not be reached'};window.fixturePush(next)})()`
      ]) {
        await js(program);
        assert.ok(await js(`document.querySelector('[data-update-part="app"]').textContent.includes(${JSON.stringify(networkReason)})`),lang+' readable network reason in app row');
        for (const id of ['updateText','updateLine']) {
          assert.ok(await js(`document.getElementById('${id}').textContent.includes(${JSON.stringify(networkReason)})`),lang+' translated network reason in '+id);
        }
      }
      await js(`document.getElementById('updateAll').click();window.fixtureFinishUpdate({ok:false,error:'GitHub could not be reached'})`);
      await until(`!document.getElementById('updateAll').disabled`);
      await until(`!document.querySelector('.toast')`);
      assert.ok(await js(`document.getElementById('updateAllError').textContent.includes(${JSON.stringify(networkReason)})`),lang+' translated operation failure');
      assert.ok(await js(`document.getElementById('updateAllError').textContent.includes(${JSON.stringify(copy('Choose Update all to retry.'))})`),lang+' explicit network retry');
      assert.equal(await js(`(()=>{const c=document.querySelector('.update-readiness');return c.scrollWidth<=c.clientWidth+1&&[...c.querySelectorAll('p:not(.sr-only),button')].every(e=>e.scrollWidth<=e.clientWidth+1)})()`),true,lang+' network recovery copy wraps');
      await js(`document.getElementById('updateReadinessToggle').click()`);
      assert.equal(await js(`(()=>{const e=document.getElementById('updateAllError'),b=document.getElementById('updateAll'),r=b.getBoundingClientRect();return e.checkVisibility()&&e.getBoundingClientRect().bottom<=innerHeight&&r.bottom<=innerHeight&&b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`),true,lang+' network failure and retry stay reachable with closed details');
      if(['en','ja','de'].includes(lang)){await pause(200);await shot('network-after-'+lang+'.png');}
      await js(`document.getElementById('updateAll').click();window.fixtureFinishUpdate();window.fixturePush(window.fixtureState)`);
      await until(`!document.getElementById('updateAll').disabled`);
      assert.equal(await js(`document.getElementById('updateAllError').hidden`),true,lang+' explicit successful retry clears network error');
      assert.equal(await js(`document.getElementById('updateReadinessSummary').dataset.ready`),'true');
      console.log('PASS locale: '+lang+'; closed details, translated failure, both actions reachable, no implicit retry');
    }
    assert.deepEqual(errors,[],'No production renderer errors');
    console.log('PASS: production update status, proofs, transitions, keyboard action, read-only pushes, persistent reply/IPC failures and explicit retry; all 13 locales at 700x600 and 18px, translated recovery guidance and diagnostics action outside collapsed details');
  } finally { win?.destroy(); await new Promise(resolve=>server.close(resolve)); app.quit(); }
}).catch(error=>{ console.error(error); app.exit(1); });
