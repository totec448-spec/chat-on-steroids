// Built production renderer in isolated Electron; placeholder state, no provider or installed app.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { fixtureConfigSource } = require('./fixtures/app-defaults.cjs');
const root = path.resolve(__dirname, '..'), built = path.join(root, 'out/renderer');
const output = path.join(root, 'outputs/plugin-refresh-recovery');
const before = process.argv.includes('--before');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const fixture = `${fixtureConfigSource()}
    localStorage.setItem('cos.ui.language', new URLSearchParams(location.search).get('lang') || 'en');
    const state = {config:fixtureConfig({ui:{theme:'dark',autoRefreshPlugins:true,lastSeenVersion:'${require('../package.json').version}'}}),
      pluginRefreshUnreadable:true,connectorSchemas:{},hasApiKey:false,hasGoalKey:false,
      status:{state:'disconnected',detail:'',publicUrl:null,localUrl:null,health:null,surfaces:[]},
      bridge:{running:false,paired:false,present:false},update:{current:'${require('../package.json').version}',latest:null,stage:'idle',error:null}};
    const ok=data=>Promise.resolve({ok:true,data}); let listener=()=>{};
    window.fixtureState=state; window.resetCalls=0;
    window.api=new Proxy({getState:()=>ok(state),getLog:()=>ok([]),listProjects:()=>ok([]),
      listSessions:()=>ok({sessions:[],activeId:null,pressure:[]}),listInputs:()=>ok([]),runningTools:()=>ok([]),
      getSwarm:()=>ok({running:false,agents:[],pendingReports:0}),getChatModels:()=>ok({state:'unknown',models:[]}),
      onStateChanged:fn=>{listener=fn;return()=>{}},
      resetPluginRefresh:()=>{window.resetCalls++;return new Promise(resolve=>window.finishReset=resolve)}
    },{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:()=>ok(null)});
    window.fixturePush=()=>listener(structuredClone(state));`;
  const server=http.createServer((req,res)=>{
    const pathname=new URL(req.url,'http://127.0.0.1').pathname;
    if(pathname==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(fixture);return;}
    const file=path.resolve(built,'.'+(pathname==='/'?'/index.html':pathname));
    if(!file.startsWith(built+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
    const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.webp':'image/webp'}[path.extname(file)];
    if(type)res.setHeader('Content-Type',type);
    const data=fs.readFileSync(file);
    res.end(path.extname(file)==='.html'?data.toString().replace('<head>','<head><script src="/fixture.js"></script>'):data);
  });
  let win;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); fs.mkdirSync(output,{recursive:true});
    win=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{offscreen:true,sandbox:true}});
    const errors=[]; win.webContents.on('console-message',event=>{if(event.level==='error'&&!event.message.includes('ResizeObserver loop'))errors.push(event.message)});
    const js=code=>win.webContents.executeJavaScript(code),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const until=async code=>{const end=Date.now()+8000;while(Date.now()<end){if(await js(code))return;await pause(30)}throw new Error('Timeout: '+code)};
    const shot=async name=>fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());
    const open=async lang=>{
      await win.loadURL('http://127.0.0.1:'+server.address().port+'/?lang='+lang);
      await until(`document.getElementById('versionLine').textContent.length>0`);
      await js(`document.querySelector('#tabs [data-tab="settings"]').click();document.getElementById('autoRefreshPlugins').closest('.setting').scrollIntoView({block:'center'})`);
      await pause(250);
    };
    await open('en');
    if(before){assert.equal(await js(`!!document.getElementById('pluginRefreshRecovery')`),false);await shot('before.png');return;}
    assert.equal(await js('window.resetCalls'),0);
    assert.equal(await js(`document.getElementById('pluginRefreshRecovery').hidden`),false);
    await shot('after.png');
    await js(`document.getElementById('pluginRefreshReset').click();document.getElementById('pluginRefreshReset').click();window.fixturePush()`);
    assert.equal(await js('window.resetCalls'),1);
    assert.equal(await js(`document.getElementById('pluginRefreshReset').disabled`),true);
    await js(`window.finishReset({ok:false,error:'Fixture write failed'})`);
    await until(`!document.getElementById('pluginRefreshReset').disabled`);
    assert.match(await js(`document.getElementById('pluginRefreshRecoveryError').textContent`),/Could not reset/);
    await shot('failed.png');
    await js(`document.getElementById('pluginRefreshReset').click();window.fixtureState.pluginRefreshUnreadable=false;window.finishReset({ok:true,data:structuredClone(window.fixtureState)})`);
    await until(`document.getElementById('pluginRefreshRecovery').hidden`);
    assert.equal(await js('window.resetCalls'),2); await shot('recovered.png');
    for(const lang of ['en','de','es','fr','ja','ko','pt-BR','pt-PT','ru','tr','vi','zh-CN','zh-TW']){
      win.setSize(700,600); await open(lang);
      await js(`document.getElementById('appearanceSize').value='18';document.getElementById('appearanceSize').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('pluginRefreshRecovery').scrollIntoView({block:'center'})`);
      const bounds=await js(`(()=>{const row=document.getElementById('pluginRefreshRecovery'),b=row.querySelector('button').getBoundingClientRect();return {overflow:row.scrollWidth>row.clientWidth+1,width:b.width,left:b.left,right:b.right,viewport:innerWidth,text:row.querySelector('b').textContent}})()`);
      assert.equal(bounds.overflow,false,lang);assert.ok(bounds.width>0&&bounds.left>=0&&bounds.right<=bounds.viewport,lang);
      if(lang!=='en')assert.notEqual(bounds.text,'Could not read plugin-refresh state',lang);
      if(lang==='ja')await shot('after-ja-narrow.png');
    }
    assert.deepEqual(errors,[]); console.log('PASS: plugin refresh recovery, failure/retry, single click and 13 languages at 700x600 / 18px');
  } finally {if(win)win.destroy();await new Promise(resolve=>server.close(resolve));app.quit();}
}).catch(error=>{console.error(error);app.exit(1)});
