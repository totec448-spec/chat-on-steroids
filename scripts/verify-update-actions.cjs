// Isolated production renderer, placeholder state, no installed app/provider mutations.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const root = process.env.COS_SPLIT_UI_ROOT || path.resolve(__dirname, '..');
const { fixtureConfigSource } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
const version = require(path.join(root, 'package.json')).version;
const built = path.join(root, 'out/renderer'), output = path.join(root, 'outputs/update-actions');
const before = process.argv.includes('--before'), lang = process.env.COS_SPLIT_UI_LANGUAGE || 'en';
const theme = process.env.COS_SPLIT_UI_THEME || 'dark', narrow = process.argv.includes('--narrow');
const suffix = lang + (theme === 'light' ? '-light' : '') + (narrow ? '-narrow' : '');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const fixture = `${fixtureConfigSource()}
    localStorage.setItem('cos.ui.language', ${JSON.stringify(lang)});
    const state={config:fixtureConfig({roots:[{name:'fixture',path:'/fixture/project'}],ui:{theme:'${theme}',lastSeenVersion:'${version}'},multiAgent:{enabled:false}}),
      hasApiKey:true,hasGoalKey:false,connectorSchemas:{core:'fixture-schema'},connectorRefresh:{core:{schemaId:'fixture-schema',state:'current'}},
      status:{state:'connected',detail:'',health:null,surfaces:[{id:'core',connectorName:'Chat On Steroids Core',description:'Core',cardSummary:'Local tools',optional:false,available:true,tools:['read'],state:'live',detail:'',localUrl:null,publicUrl:null,lastRequestAt:1,lastToolCallAt:1}]},
      bridge:{running:true,paired:true,present:true,extensionVersion:'${version}'},update:{current:'${version}',latest:null,stage:'idle',checkedAt:1,error:null}};
    const ok=data=>Promise.resolve({ok:true,data});let listener=()=>{};window.calls=[];window.fixtureState=state;
    window.api=new Proxy({getState:()=>ok(state),getLog:()=>ok(Array.from({length:200},(_,i)=>({time:Date.now()+i,level:'info',message:'Fixture event '+i}))),
      listProjects:()=>ok([]),listSessions:()=>ok({sessions:[],activeId:null,pressure:[]}),listInputs:()=>ok([]),runningTools:()=>ok([]),listPausedHelpers:()=>ok([]),
      getSwarm:()=>ok({running:false,agents:[],pendingReports:0}),getChatModels:()=>ok({state:'unknown',models:[]}),
      onStateChanged:fn=>{listener=fn;return()=>{}},updateAll:()=>{window.calls.push('update-all');return new Promise(resolve=>window.finish=resolve)}},
      {get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:()=>ok(null)});window.push=()=>listener(structuredClone(state));`;
  const server=http.createServer((request,response)=>{
    const pathname=new URL(request.url,'http://127.0.0.1').pathname;
    if(pathname==='/fixture.js'){response.setHeader('Content-Type','text/javascript');response.end(fixture);return;}
    const file=path.resolve(built,'.'+(pathname==='/'?'/index.html':pathname));
    if(!file.startsWith(built+path.sep)||!fs.existsSync(file)){response.writeHead(404);response.end();return;}
    const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)];if(type)response.setHeader('Content-Type',type);
    const data=fs.readFileSync(file);response.end(path.extname(file)==='.html'?data.toString().replace('<head>','<head><script src="/fixture.js"></script>'):data);
  });
  let win;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));fs.mkdirSync(output,{recursive:true});
    win=new BrowserWindow({show:false,width:narrow?640:1100,height:narrow?480:850,webPreferences:{offscreen:true,sandbox:true}});
    const js=s=>win.webContents.executeJavaScript(s),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const until=async s=>{const end=Date.now()+10000;while(Date.now()<end){if(await js(s))return;await pause(40);}throw Error('Timeout: '+s);};
    await win.loadURL('http://127.0.0.1:'+server.address().port);await until(`document.getElementById('versionLine').textContent.length>0`);
    if(narrow)await js(`const size=document.getElementById('appearanceSize');size.value='18';size.dispatchEvent(new Event('input',{bubbles:true}))`);
    await js(`document.querySelector('#tabs [data-tab="activity"]').click();const d=document.getElementById('updateReadinessDetails');if(d)d.open=true`);await until(`!document.querySelector('.toast')`);await pause(100);
    const shot=async name=>fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());
    const checkLayout=async()=>{const errors=await js(`(()=>{
      const card=document.getElementById('updateActions');if(!card)return [];
      const box=card.getBoundingClientRect(),style=getComputedStyle(card),children=[...card.children].filter(e=>!e.hidden),errors=[];
      const left=box.left+parseFloat(style.borderLeftWidth)+parseFloat(style.paddingLeft),top=box.top+parseFloat(style.borderTopWidth)+parseFloat(style.paddingTop);
      const bottom=box.bottom-parseFloat(style.borderBottomWidth)-parseFloat(style.paddingBottom);let previous=null;
      if(card.nextElementSibling.getBoundingClientRect().top<box.bottom+10)errors.push('log card overlaps update card');
      for(const child of children){const r=child.getBoundingClientRect();
        if(Math.abs(r.left-left)>1)errors.push('left alignment');
        if(!previous&&Math.abs(r.top-top)>1)errors.push('action top spacing');
        if(previous&&r.top-previous.bottom<10)errors.push('vertical overlap or missing gap');
        if(r.right>box.right-parseFloat(style.paddingRight)+1||r.bottom>bottom+1||child.scrollWidth>child.clientWidth+1)errors.push('clipped content');previous=r;
      }return errors;
    })()`);assert.deepEqual(errors,[],'Button and descriptions stay aligned, spaced and contained');};
    await shot((before?'before':'after')+'-'+suffix+'.png');
    if(before)return;
    await checkLayout();
    assert.deepEqual(await js('window.calls'),[],'State paints never trigger an update');
    assert.equal(await js(`(()=>{const b=document.getElementById('updateAll'),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`),true,'Action is visible and receives pointer input');
    await js(`document.getElementById('updateAll').click();document.getElementById('updateAll').click();window.push()`);
    assert.deepEqual(await js('window.calls'),['update-all']);assert.equal(await js(`document.getElementById('updateAll').disabled`),true);
    await js(`window.finish({ok:false,error:'Fixture network unavailable'+${JSON.stringify(narrow ? ': ' + 'long-diagnostic-'.repeat(12) : '')}})`);await until(`!document.getElementById('updateAll').disabled`);
    await js('window.push()');assert.equal(await js(`document.getElementById('updateAllError').hidden`),false);
    assert.ok(await js(`document.getElementById('updateAllError').textContent.includes('Fixture network unavailable')`));
    await until(`!document.querySelector('.toast')`);await pause(100);await checkLayout();
    if(narrow){await js(`document.getElementById('updateAllError').scrollIntoView({block:'end'})`);
      assert.equal(await js(`(()=>{const e=document.getElementById('updateAllError'),r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.left+r.width/2,r.bottom-2))})()`),true,'Long failure remains reachable by scrolling');}
    await shot('retained-error-'+suffix+'.png');
    await js(`document.getElementById('updateAll').scrollIntoView({block:'nearest'})`);
    assert.equal(await js(`(()=>{const b=document.getElementById('updateAll'),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`),true,'Retry stays reachable after a long failure');
    await js(`document.getElementById('updateAll').click();window.finish({ok:true,data:'checking-connectors'})`);await until(`!document.getElementById('updateAll').disabled`);
    assert.equal(await js(`document.getElementById('updateAllError').hidden`),true);assert.deepEqual(await js('window.calls'),['update-all','update-all']);
    console.log('Update action real-Electron checks passed: '+suffix);
  } finally {win?.destroy();server.close();app.quit();}
}).catch(error=>{console.error(error);process.exitCode=1;app.exit(1);});
