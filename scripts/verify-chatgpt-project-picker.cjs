// Production renderer and real Chromium layout/input; synthetic projects only (#1133).
// #1756: the empty Projects section says what a project is; adding a folder offers the account's
// existing ChatGPT Projects next to a new one; closing that keeps the default (a new one); a
// project without one offers the same choice from its menu, where closing it changes nothing.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', 'chatgpt-project-picker'));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
fs.rmSync(path.join(output, 'profile'), { recursive: true, force: true });
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `(() => {
 const old=window.api,ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
 const projects=[]; window.__calls=[];
 const fresh={id:'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',name:'Kundenprojekt',path:'/Users/me/Kundenprojekt',createdAt:Date.now()};
 const choices=[{id:'g-p-'+'a'.repeat(32),name:'Website relaunch',linkedTo:null},{id:'g-p-'+'b'.repeat(32),name:'Kundenprojekt (2025)',linkedTo:null},
  {id:'g-p-'+'c'.repeat(32),name:'Mobile app',linkedTo:{id:'aaaaaaaa-bbbb-4ccc-8ddd-000000000009',name:'mobile'}}];
 const methods={
  getState:async()=>{const r=await old.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);r.data.config.ui={...r.data.config.ui,language:'en',theme:'dark'};return r;},
  listSessions:()=>ok({sessions:[],activeId:null,pressure:[],blocked:[],trusted:[]}),
  markWhatsNewSeen:()=>ok(true),
  chatGroups:()=>ok({version:1,groups:[],members:{}}),
  listProjects:()=>ok(projects),
  chatgptProjectChoices:()=>{window.__calls.push('choices');return ok(choices);},
  addProject:options=>{window.__calls.push('add:'+JSON.stringify(options??null));projects.push({...fresh});return ok(fresh);},
  createChatgptProject:id=>{window.__calls.push('create:'+id);const p=projects.find(r=>r.id===id);p.chatgpt={state:'requested',requestId:'cccccccc-bbbb-4ccc-8ddd-000000000001',updatedAt:Date.now()};return ok(p);},
  linkChatgptProject:(id,chatgptId)=>{window.__calls.push('link:'+chatgptId);const p=projects.find(r=>r.id===id);p.chatgpt={state:'linked',id:chatgptId,updatedAt:Date.now()};return ok(p);}
 };
 window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile:false, root:path.join(root,'src/renderer'), cacheDir:path.join(output,'vite'), logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},
    plugins:[{name:'chatgpt-project-picker-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/timeline-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/timeline-fixture.js')return next();res.setHeader('Content-Type','text/javascript');res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);});}}] });
  await server.listen();
  win = new BrowserWindow({show:false,width:1280,height:800,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',e=>{if(e.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(e.message))errors.push(e.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(const deadline=Date.now()+15000;Date.now()<deadline;){if(await js(expression))return;await pause(40);}throw new Error('Timed out: '+expression);};
  const settle=async()=>{await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`);await pause(180);};
  const capture=async name=>{await settle();fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  await win.loadURL(server.resolvedUrls.local[0]);
  win.show(); win.focus(); win.webContents.focus();
  await until(`!!document.getElementById('uiLanguage')`);
  await js(`(()=>{const s=document.getElementById('uiLanguage');s.value='en';s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`);
  await until(`/A project is a folder/.test(document.getElementById('projectsEmpty')?.textContent||'')`);

  // 1. The empty section explains what a project is, inside the sidebar.
  await until(`(()=>{const e=document.getElementById('projectsEmpty');return e&&!e.hidden&&e.getClientRects().length>0;})()`);
  const empty=await js(`(()=>{const e=document.getElementById('projectsEmpty'),s=e.closest('aside,nav,.sidebar')||e.parentElement,a=e.getBoundingClientRect(),b=s.getBoundingClientRect();return {text:e.textContent,left:a.left,right:a.right,sLeft:b.left,sRight:b.right,scroll:e.scrollWidth,client:e.clientWidth};})()`);
  assert.match(empty.text,/A project is a folder on this computer/,'The empty Projects section explains projects');
  assert.ok(empty.left>=empty.sLeft-0.5&&empty.right<=empty.sRight+0.5&&empty.scroll<=empty.client+1,'The explanation wraps inside the sidebar: '+JSON.stringify(empty));
  await capture('empty.png');

  // 2. Adding a folder offers a new ChatGPT Project and the existing ones, one already in use.
  await js(`document.getElementById('addProject').click()`); await settle();
  await js(`document.querySelector('[data-row-action="add-local-project"]').click()`);
  await until(`!!document.querySelector('.chatgpt-project-picker')`); await settle();
  const picker=await js(`(()=>{const m=document.querySelector('.chatgpt-project-picker'),r=m.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,w:innerWidth,h:innerHeight,label:m.getAttribute('aria-label'),
    options:[...m.querySelectorAll('[role=option]')].map(o=>({text:o.textContent,disabled:o.disabled})),focus:document.activeElement?.className};})()`);
  assert.equal(picker.label,'ChatGPT Project for Kundenprojekt');
  assert.equal(await js(`document.querySelector('.chatgpt-project-picker .file-branch-heading')?.textContent`),'ChatGPT Project for Kundenprojekt','A visible heading says what the choice is for');
  assert.deepEqual(picker.options.map(o=>o.text),['New ChatGPT Project “Kundenprojekt”','Website relaunch','Kundenprojekt (2025)','Mobile appLinked to mobile']);
  assert.deepEqual(picker.options.map(o=>o.disabled),[false,false,false,true]);
  assert.ok(picker.top>=0&&picker.bottom<=picker.h&&picker.left>=0&&picker.right<=picker.w,'The choice stays inside the window: '+JSON.stringify(picker));
  assert.match(picker.focus,/file-branch-search/,'The search field has focus');
  await capture('picker.png');
  // Typing narrows the list.
  await win.webContents.insertText('relaunch'); await pause(120);
  assert.deepEqual(await js(`[...document.querySelectorAll('.chatgpt-project-picker [role=option]')].map(o=>o.textContent)`),['Website relaunch']);
  await capture('picker-search.png');
  // 3. Closing it keeps the default: a new ChatGPT Project.
  await win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); await win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await until(`window.__calls.some(c=>c.startsWith('create:'))`);
  assert.deepEqual(await js(`window.__calls.filter(c=>!c.startsWith('choices'))`),['add:{"chatgpt":"later"}','create:aaaaaaaa-bbbb-4ccc-8ddd-000000000001']);
  assert.equal(await js(`!!document.querySelector('.chatgpt-project-picker:not(.is-leaving)')`),false,'The choice closed');
  assert.deepEqual(errors,[]);
  console.log('PASS: the empty Projects section explains projects; adding a folder offers new or existing ChatGPT Projects (one in use shown, not choosable), search narrows it, and closing keeps a new one');
  win.destroy();await server.close();app.exit(0);
}).catch(async error=>{fs.mkdirSync(output,{recursive:true});if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error);await server?.close();app.exit(1);});
