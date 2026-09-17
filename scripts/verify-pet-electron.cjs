// Full production main/preload/renderer in isolated userData. No API mock.
// Run: node_modules/.bin/electron scripts/verify-pet-electron.cjs [--manual|--restart]
const {app,BrowserWindow,nativeTheme}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),output=path.join(root,'outputs/tur-tur-pet/electron',process.argv.includes('--fresh')?'final-check':'');
const manual=process.argv.includes('--manual'),restart=process.argv.includes('--restart');
fs.mkdirSync(output,{recursive:true});
app.setName('COS Pet Acceptance');app.setPath('userData',path.join(output,'runtime'));app.setAppPath(root);
process.env.CLF_BRIDGE_PORTS='0';
const configFile=path.join(app.getPath('userData'),'config.json');
if(!fs.existsSync(configFile)){
  fs.mkdirSync(path.dirname(configFile),{recursive:true});
  fs.writeFileSync(configFile,JSON.stringify({roots:[],readOnly:true,capabilities:{},
    tunnel:{kind:'openai',tunnelId:'',desktopTunnelId:'',binaryPath:''},
    ui:{minimizeToTray:false,autoConnect:false,theme:'dark',autoContinue:false,backgroundChats:false},
    multiAgent:{enabled:false,allowUnattributedCalls:false,recoverAgentTabs:false},goal:{enabled:false}}));
}
const errors=[];let started=false;
app.on('web-contents-created',(_event,contents)=>{
  contents.on('console-message',(event,...legacy)=>{const level=event.level??legacy[0],message=event.message??legacy[1];if(level==='error'||level===3)errors.push(String(message));});
  contents.on('render-process-gone',(_e,details)=>errors.push('renderer gone: '+details.reason));
});
app.on('browser-window-created',(_event,win)=>{
  if(started)return;started=true;
  // Keep this isolated acceptance window's RAF at normal speed when the host
  // terminal takes focus; product background/visibility behavior stays intact.
  win.webContents.setBackgroundThrottling(false);
  win.webContents.once('did-finish-load',()=>setTimeout(()=>run(win).catch(error=>{fs.writeFileSync(path.join(output,'failure.txt'),error.stack);console.error(error);app.exit(1);}),600));
});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function run(win){
  const js=code=>win.webContents.executeJavaScript(code);
  const wait=async (code,timeout=6000)=>{const until=Date.now()+timeout;while(Date.now()<until){if(await js(code))return;await delay(25);}throw new Error('Timed out: '+code);};
  await wait('!!document.getElementById("petLauncher")');
  win.setTitle('Chat On Steroids — Pet Acceptance');win.unmaximize();win.setSize(1100,850);win.show();await delay(500);
  await js(`document.getElementById('newChat')?.click();`);await delay(400);
  const capture=async name=>{fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());};
  const record=async name=>{
    const folder=path.join(output,name+'-frames');fs.mkdirSync(folder,{recursive:true});
    const start=Date.now(),files=[];
    while(Date.now()-start<15000&&await js('!!document.getElementById("petLayer").dataset.action')){
      const file=String(files.length).padStart(3,'0')+'.png';
      fs.writeFileSync(path.join(folder,file),(await win.webContents.capturePage()).toPNG());files.push(file);await delay(75);
    }
    fs.writeFileSync(path.join(folder,'sequence.json'),JSON.stringify({files,elapsed:Date.now()-start}));
  };
  const bounds=selector=>js(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}})()`);
  const click=async (selector,button='left')=>{const b=await bounds(selector),zoom=win.webContents.getZoomFactor();const x=Math.round((b.x+b.width/2)*zoom),y=Math.round((b.y+b.height/2)*zoom);win.webContents.sendInputEvent({type:'mouseMove',x,y});win.webContents.sendInputEvent({type:'mouseDown',button,x,y,clickCount:1});await delay(25);win.webContents.sendInputEvent({type:'mouseUp',button,x,y,clickCount:1});await delay(40);};
  if(restart){
    await wait('!document.getElementById("petLayer").hidden');
    const actual=await js('JSON.parse(localStorage.getItem("cos.ui.turTurPet.v1"))');
    const expected=JSON.parse(fs.readFileSync(path.join(output,'restart-expected.json'),'utf8'));
    const viewport=await js('({w:innerWidth,h:innerHeight})');
    const clamped={...expected,x:Math.max(0,Math.min(expected.x,viewport.w-160)),y:Math.max(0,Math.min(expected.y,viewport.h-160))};
    assert.deepEqual(actual,clamped);await capture('restart-restored');
    fs.writeFileSync(path.join(output,'restart-result.json'),JSON.stringify({passed:true,saved:expected,viewport,preference:actual,errors},null,2));
    if(!manual)app.quit();return;
  }
  if(manual){await capture('manual-ready');console.log('Full app ready for native interaction.');return;}
  await js(`document.querySelector('[data-tab="appearance"]')?.click();const theme=document.getElementById('appearanceTheme');theme.value='dark';theme.dispatchEvent(new Event('change',{bubbles:true}));`);
  await delay(200);await js(`document.getElementById('newChat').click()`);await delay(200);
  // Start reproducibly via the public launcher, never by injecting machine state.
  if(await js('document.getElementById("petLauncher").getAttribute("aria-pressed")==="true"'))await click('#petLauncher');
  await click('#petLauncher');await wait('!document.getElementById("petLayer").hidden');
  await delay(700);await capture('idle-dark');
  fs.writeFileSync(path.join(output,'geometry-debug.json'),JSON.stringify({zoom:win.webContents.getZoomFactor(),bounds:win.getBounds(),content:win.getContentBounds(),actor:await bounds('#petActor'),viewport:await js('({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})')},null,2));
  await click('#petActor');assert.equal(await js('document.getElementById("petActor").dataset.state'),'poke');
  for(let i=0;i<3;i++)await click('#petActor');assert.equal(await js('document.getElementById("petActor").dataset.state'),'angry');await capture('angry');
  const b=await bounds('#petActor'),zoom=win.webContents.getZoomFactor();const x=Math.round((b.x+64)*zoom),y=Math.round((b.y+64)*zoom);
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',x,y});
  win.webContents.sendInputEvent({type:'mouseMove',x:250,y:280,movementX:250-x,movementY:280-y});await delay(80);
  assert.equal(await js('document.getElementById("petActor").dataset.state'),'held');await capture('held');
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',x:250,y:280,clickCount:1});await delay(30);
  assert.equal(await js('document.getElementById("petActor").dataset.state'),'landing');await delay(600);
  const action=async index=>{await click('#petActor','right');await click(`.pet-menu button:nth-child(${index})`);};
  await action(3);const openRecording=record('openai');await wait('document.getElementById("petActor").dataset.state==="punch"');await capture('openai-bat-combo');
  await wait('document.querySelector(".pet-target")?.textContent==="ClosedAI"');await capture('closedai-heavy');
  await wait('document.getElementById("petLayer").dataset.action===""');await openRecording;assert.equal(await js('document.querySelector(".pet-props").childElementCount'),0);
  await action(4);const anthropicRecording=record('anthropic');await wait('document.getElementById("petActor").dataset.state==="carry"');await capture('anthropic-carry');
  await wait('document.getElementById("petActor").dataset.state==="throw"');await delay(750);await capture('anthropic-throw');
  await wait('document.getElementById("petLayer").dataset.action===""');await anthropicRecording;assert.equal(await js('document.querySelector(".pet-props").childElementCount'),0);
  await action(3);await delay(1200);await click('#petActor','right');await click('.pet-menu button:first-child');
  assert.equal(await js('document.querySelector(".pet-props").childElementCount'),0);assert.equal(await js('document.getElementById("petLayer").hidden'),true);
  await click('#petLauncher');await delay(600);
  const geometry=[];
  for(const [width,height,zoom] of [[1100,850,1],[800,650,1.25],[700,650,1.5],[1100,850,.8]]){
    win.setSize(width,height);win.webContents.setZoomFactor(zoom);await delay(150);
    const value=await js(`(()=>{const r=document.getElementById('petActor').getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight}})()`);
    assert.ok(value.x>=0&&value.y>=0&&value.right<=value.w+1&&value.bottom<=value.h+1);geometry.push({zoom,...value});await capture('zoom-'+zoom);
  }
  win.webContents.setZoomFactor(1);win.setSize(1100,850);await delay(100);
  await js(`document.querySelector('[data-tab="appearance"]')?.click();const select=document.getElementById('appearanceTheme');select.value='light';select.dispatchEvent(new Event('change',{bubbles:true}));`);
  await delay(300);await capture('light-theme');
  await js(`document.querySelector('[data-tab="chat"]')?.click()`);
  // Chromium emulation verifies the same media-query listener as the OS preference.
  win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await delay(200);
  const frame=await js('document.getElementById("petActor").dataset.frame');await delay(600);assert.equal(await js('document.getElementById("petActor").dataset.frame'),frame);
  await capture('reduced-motion');await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});win.webContents.debugger.detach();
  await js(`document.getElementById('newChat').click()`);await click('#petActor','right');await click('.pet-menu button:nth-child(2)');
  const reset=await js('JSON.parse(localStorage.getItem("cos.ui.turTurPet.v1"))');
  const viewport=await js('({w:innerWidth,h:innerHeight})');
  assert.deepEqual(reset,{visible:true,x:viewport.w-200,y:viewport.h-230});await capture('reset-position');
  const preference=await js('JSON.parse(localStorage.getItem("cos.ui.turTurPet.v1"))');
  fs.writeFileSync(path.join(output,'restart-expected.json'),JSON.stringify(preference));
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,fullProductionApp:true,geometry,errors,preference},null,2));
  assert.deepEqual(errors,[]);console.log('Pet Electron acceptance passed.');app.quit();
}
require(path.join(root,'out/main/index.js'));
