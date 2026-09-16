/** Real Chromium + production extension backend + production RPC broker, in an isolated profile. */
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { WebSocket, WebSocketServer } from 'ws';
import sharp from 'sharp';

const output = path.resolve('outputs/browser-control');
const run = path.join(output,randomUUID());
await fs.mkdir(run,{recursive:true});
await build({entryPoints:['src/main/browser-control.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:path.join(run,'broker.mjs')});
const {BrowserControlBroker} = await import(pathToFileURL(path.join(run,'broker.mjs')).href);
const wakeClients = new Set();
const broker = new BrowserControlBroker(() => {for (const ws of wakeClients) ws.send('wake');});
const apiKey = randomUUID();
const page = `<!doctype html><meta charset=utf-8><title>Browser Control Fixture</title><style>body{font:18px system-ui;padding:35px;background:#f2f6fe}button,input,textarea,select{font:inherit;margin:12px;padding:12px}button:hover{background:#aacaff}#drag{width:80px;height:50px;background:#9be}#drop{width:180px;height:60px;border:2px dashed #368}iframe{width:500px;height:150px}</style>
<h1>Background fixture</h1><button id=click>Increment counter</button><output id=count>0</output><br><label>Notes<textarea id=notes></textarea></label><label>Choice<select id=choice><option value=one>One</option><option value=two>Two</option></select></label><div id=shadow></div><iframe id=child></iframe>
<script>let count=0;document.querySelector('#click').onclick=()=>{document.querySelector('#count').textContent=++count;console.log('fixture-click',count);fetch('/api',{method:'POST',body:'fixture-body'})};const shadow=document.querySelector('#shadow').attachShadow({mode:'open'});shadow.innerHTML='<button id=shadowButton>Shadow action</button>';shadow.querySelector('button').onclick=()=>console.warn('shadow-click');document.querySelector('#child').src=location.href.replace('127.0.0.1','localhost').replace('/fixture','/frame');</script>`;
const server = http.createServer(async (req,res) => {
  if (req.url === '/rpc' && req.headers['x-fixture-key'] === apiKey) {
    const chunks=[];for await (const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());let value;
    if(body.action==='poll') value={...broker.poll(body.browserId,body.name,body.enabled),policy:{read:true,write:true}};
    else if(body.action==='claim') value={command:await broker.claim(body.browserId,body.id,body.epoch)};
    else if(body.action==='check') value={allowed:await broker.check(body.browserId,body.id,body.epoch)};
    else if(body.action==='result') value={ok:broker.result(body.browserId,body.id,body.epoch,body.result)};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));return;
  }
  if (req.url === '/api') {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,fixture:'network-body'}));return;}
  res.writeHead(200,{'content-type':'text/html'});
  res.end(req.url === '/fixture' ? page : req.url === '/frame' ? '<title>Child</title><label>Frame note<input id=frameNote></label><button id=frameButton onclick="document.body.dataset.clicked=\'yes\'">Frame action</button>' : '<title>Foreground sentinel</title><h1>This tab must remain selected</h1>');
});
await new Promise(resolve => server.listen(0,'0.0.0.0',resolve));
const port=server.address().port,base=`http://127.0.0.1:${port}`;
const wss=new WebSocketServer({server});
wss.on('connection',ws=>{wakeClients.add(ws);ws.on('close',()=>wakeClients.delete(ws));});
const extension=path.join(run,'extension');await fs.mkdir(extension);
for(const file of ['browser-control.js','browser-control-page.js']) await fs.copyFile(path.resolve('extension',file),path.join(extension,file));
await fs.writeFile(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'CoS isolated browser fixture',version:'1.0.0',permissions:['debugger','tabs','storage','scripting'],host_permissions:[`${base}/*`,`http://localhost:${port}/*`],background:{service_worker:'fixture.js',type:'module'}}));
await fs.writeFile(path.join(extension,'fixture.js'),`import {createBrowserControl} from './browser-control.js';
const transport=async(_path,init)=>{try{const r=await fetch(${JSON.stringify(base+'/rpc')},{...init,headers:{'x-fixture-key':${JSON.stringify(apiKey)},'content-type':'application/json'}});return {ok:r.ok,status:r.status,data:await r.json()};}catch{return {ok:false,status:0};}};
globalThis.control=createBrowserControl(chrome,transport);
globalThis.restartControl=async()=>{globalThis.control=createBrowserControl(chrome,transport);await control.ready();await control.pump();};
chrome.debugger.onEvent.addListener((...args)=>void control.event(...args).catch(console.error));chrome.debugger.onDetach.addListener((...args)=>void control.detached(...args).catch(console.error));
const ws=new WebSocket(${JSON.stringify(`ws://127.0.0.1:${port}`)});ws.onopen=()=>void control.pump();ws.onmessage=()=>void control.pump().catch(console.error);`);
const executable = process.env.COS_TEST_CHROMIUM || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright','chromium-1243','chrome-win64','chrome.exe');
await fs.access(executable);
const profile=path.join(run,'profile');
const chrome=spawn(executable,[`--user-data-dir=${profile}`,'--remote-debugging-port=0','--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--site-per-process',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let stderr='';chrome.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-20000);});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,description,timeout=12000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(e){last=e;}await delay(100);}throw new Error(`${description}: ${last?.message || stderr}`);}
let connection;let seq=0;const pending=new Map();
async function cdp(method,params={},sessionId){const id=++seq;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});connection.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}: {})}));});}
const timings=[];
async function tool(name,args,owner='session:fixture'){const start=Date.now();const result=await broker.execute(name,args,owner,null,async()=>true);timings.push({tool:name,action:args.action,ms:Date.now()-start,error:result.error});if(result.error)throw new Error(`${name}: ${result.error}`);return result;}
async function snapshot(tabId){return until(async()=>{const r=await tool('browser_snapshot',{tabId,maxNodes:300,maxChars:16000});return r.value?.text ? r.value:null;},'snapshot');}
const refFor=(snap,name)=>{const line=snap.text.split('\n').find(line=>/^\s*\[/.test(line)&&line.includes(name));assert.ok(line,`Missing ${name} in ${snap.text}`);return /^\s*\[([^\]]+)\]/.exec(line)?.[1];};
const report={checks:[],run,timings};
try {
  const active=await until(async()=>{const s=await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8');return s.split('\n');},'Chromium startup');
  connection=new WebSocket(`ws://127.0.0.1:${active[0]}${active[1]}`);await new Promise((resolve,reject)=>{connection.on('open',resolve);connection.on('error',reject);});
  connection.on('message',raw=>{const m=JSON.parse(raw);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}});
  await until(()=>broker.browsers().length,'Extension connection');
  const sentinel=await cdp('Target.createTarget',{url:base+'/sentinel',background:false});
  await cdp('Target.createTarget',{url:base+'/fixture',background:true});
  await cdp('Target.activateTarget',{targetId:sentinel.targetId});
  const target=await until(async()=>{const list=await tool('browser_tabs',{action:'list'});return list.value.tabs.find(t=>t.url===base+'/fixture');},'Fixture navigation');
  const tabId=target.tabId;
  await tool('browser_tabs',{action:'attach',tabId});
  let snap=await snapshot(tabId);assert.ok(snap.text.includes('Background fixture'));assert.ok(refFor(snap,'Shadow action'));report.checks.push('existing tab attachment; DOM and shadow-root references');
  if(process.env.COS_BROWSER_FOCUS_PROBE==='1') {
    const worker=(await cdp('Target.getTargets')).targetInfos.find(t=>t.type==='service_worker'&&t.url.endsWith('/fixture.js'));
    const session=(await cdp('Target.attachToTarget',{targetId:worker.targetId,flatten:true})).sessionId;
    const probe=[];
    for(const enabled of [false,true]) {
      await cdp('Runtime.evaluate',{expression:`chrome.debugger.sendCommand({tabId:${Number(tabId.split(':').at(-1))}},'Emulation.setFocusEmulationEnabled',{enabled:${enabled}})`,awaitPromise:true},session);
      const before=Date.now();
      await tool('browser_action',{tabId,pageId:snap.pageId,action:'click',ref:refFor(snap,'Increment counter')});
      const elapsedMs=Date.now()-before;
      const state=(await tool('browser_evaluate',{tabId,pageId:snap.pageId,expression:'({count:document.querySelector("#count").textContent,visibility:document.visibilityState,focused:document.hasFocus()})'})).value.value;
      const active=(await tool('browser_tabs',{action:'list'})).value.tabs.find(t=>t.active);
      assert.equal(active.url,base+'/sentinel');probe.push({enabled,elapsedMs,state,active:active.url});
    }
    await fs.writeFile(path.join(output,'focus-probe.json'),JSON.stringify({run,probe},null,2));console.log(JSON.stringify(probe,null,2));
    await tool('browser_tabs',{action:'release',tabId});
    process.exitCode=0;
  } else {
  const foreign=await broker.execute('browser_snapshot',{tabId},'session:foreign',null,async()=>true);assert.match(foreign.error,/TAB_OWNED/);report.checks.push('foreign caller refused');
  assert.equal(snap.visibility,'visible');assert.equal(snap.focused,true);
  const clickStarted=Date.now();
  await tool('browser_action',{tabId,pageId:snap.pageId,action:'click',ref:refFor(snap,'Increment counter')});
  assert.ok(Date.now()-clickStarted<2000,'Hidden-tab input must not wait for the five-second compositor timeout');
  await tool('browser_action',{tabId,pageId:snap.pageId,action:'fill',ref:refFor(snap,'Notes'),text:'Hello\nworld'});
  await tool('browser_action',{tabId,pageId:snap.pageId,action:'select',ref:refFor(snap,'Choice'),values:['two']});
  const evaluated=await tool('browser_evaluate',{tabId,pageId:snap.pageId,expression:'({count:document.querySelector("#count").textContent,notes:document.querySelector("#notes").value,choice:document.querySelector("#choice").value})'});
  assert.deepEqual(evaluated.value.value,{count:'1',notes:'Hello\nworld',choice:'two'});report.checks.push('background click, multiline fill, select, main-world evaluate');
  await tool('browser_action',{tabId,pageId:snap.pageId,action:'fill',ref:refFor(snap,'Notes'),text:''});
  await tool('browser_action',{tabId,pageId:snap.pageId,action:'key',key:'A'});
  assert.equal((await tool('browser_evaluate',{tabId,pageId:snap.pageId,expression:'document.querySelector("#notes").value'})).value.value,'A');
  await tool('browser_action',{tabId,pageId:snap.pageId,action:'hover',ref:refFor(snap,'Increment counter')});
  assert.equal((await tool('browser_evaluate',{tabId,pageId:snap.pageId,expression:'document.querySelector("#click").matches(":hover")'})).value.value,true);
  report.checks.push('empty fill deletes selection; keyboard and hover are browser-local');
  // A heading/card's accessible name must not hide its nested action or editor.
  await tool('browser_evaluate',{tabId,pageId:snap.pageId,expression:`(()=>{
    const fixture=document.createElement('section');fixture.id='nestedFixture';
    fixture.innerHTML='<h2><a href="#nested" id="nestedLink">Nested heading link</a></h2><div tabindex="0" aria-label="Editor card"><label>Nested editor<input id="nestedEditor"></label></div><button id="holdTarget">Hold target</button><button id="partialTarget" style="position:relative;width:220px;height:80px">Partial target</button><div id="clickBlocker" style="position:absolute;z-index:100;width:60px;height:40px">Overlay blocker</div>';
    document.body.append(fixture);globalThis.fixtureKeys=[];
    document.querySelector('#nestedEditor').onkeydown=e=>fixtureKeys.push({key:e.key,code:e.code,trusted:e.isTrusted});
    const hold=document.querySelector('#holdTarget');hold.onkeydown=()=>globalThis.heldAt=performance.now();hold.onkeyup=()=>globalThis.heldFor=performance.now()-heldAt;
    const button=document.querySelector('#partialTarget');button.onclick=()=>globalThis.partialClicked=true;
    const rect=button.getBoundingClientRect();Object.assign(document.querySelector('#clickBlocker').style,{left:(rect.left+scrollX+rect.width/2-30)+'px',top:(rect.top+scrollY+rect.height/2-20)+'px'});
    return true;
  })()`});
  snap=await snapshot(tabId);assert.ok(refFor(snap,'link "Nested heading link"'));assert.ok(refFor(snap,'textbox "Nested editor"'));
  await tool('browser_action',{tabId,pageId:snap.pageId,action:'fill',ref:refFor(snap,'Nested editor'),text:'nested'});
  await tool('browser_action',{tabId,pageId:snap.pageId,action:'click',ref:refFor(snap,'Hold target')});
  await tool('browser_action',{tabId,pageId:snap.pageId,action:'key',ref:refFor(snap,'Nested editor'),key:'ENTER'});
  const keyState=(await tool('browser_evaluate',{tabId,pageId:snap.pageId,expression:'({id:document.activeElement.id,keys:fixtureKeys})'})).value.value;
  assert.equal(keyState.id,'nestedEditor');assert.deepEqual(keyState.keys,[{key:'Enter',code:'Enter',trusted:true}]);
  await tool('browser_action',{tabId,pageId:snap.pageId,action:'key',ref:refFor(snap,'Hold target'),key:'w',holdMs:150});
  const held=(await tool('browser_evaluate',{tabId,pageId:snap.pageId,expression:'heldFor'})).value.value;assert.ok(held>=140&&held<2000);
  const oldEditor=refFor(snap,'Nested editor');
  snap=await snapshot(tabId);
  const oldKey=await broker.execute('browser_action',{tabId,pageId:snap.pageId,action:'key',ref:oldEditor,key:'A'},'session:fixture',null,async()=>true);assert.match(oldKey.error,/REF_STALE/);
  await tool('browser_action',{tabId,pageId:snap.pageId,action:'click',ref:refFor(snap,'Partial target')});
  assert.equal((await tool('browser_evaluate',{tabId,pageId:snap.pageId,expression:'partialClicked'})).value.value,true);
  await tool('browser_evaluate',{tabId,pageId:snap.pageId,expression:`(()=>{const r=document.querySelector('#partialTarget').getBoundingClientRect();Object.assign(document.querySelector('#clickBlocker').style,{left:(r.left+scrollX)+'px',top:(r.top+scrollY)+'px',width:r.width+'px',height:r.height+'px'});return true})()`});
  const obstructed=await broker.execute('browser_action',{tabId,pageId:snap.pageId,action:'click',ref:refFor(snap,'Partial target')},'session:fixture',null,async()=>true);assert.match(obstructed.error,/OBSTRUCTED.*Overlay blocker/);
  await tool('browser_evaluate',{tabId,pageId:snap.pageId,expression:'(document.querySelector("#nestedFixture").remove(),true)'});
  report.checks.push('nested refs; case-insensitive trusted key targets; bounded held key; stale key target refusal; partial and complete obstruction');
  const buttonRect=(await tool('browser_evaluate',{tabId,pageId:snap.pageId,expression:'document.querySelector("#click").getBoundingClientRect().toJSON()'})).value.value;
  const shot=await tool('browser_screenshot',{tabId,fullPage:false});
  const bytes=Buffer.from(shot.image.data,'base64');const meta=await sharp(bytes).metadata();assert.equal(meta.width,shot.value.width);assert.equal(meta.height,shot.value.height);await fs.writeFile(path.join(output,'browser-control-fixture.jpg'),bytes);report.checks.push('native background screenshot; image geometry verified');
  const coordinateClick={tabId,pageId:shot.value.pageId,action:'click',screenshotId:shot.value.screenshotId,x:(buttonRect.left+buttonRect.width/2)*shot.value.scale,y:(buttonRect.top+buttonRect.height/2)*shot.value.scale};
  await tool('browser_action',coordinateClick);
  const staleShot=await broker.execute('browser_action',coordinateClick,'session:fixture',null,async()=>true);assert.match(staleShot.error,/SCREENSHOT/);
  assert.equal((await tool('browser_evaluate',{tabId,pageId:snap.pageId,expression:'document.querySelector("#count").textContent'})).value.value,'2');report.checks.push('viewport image coordinates click once; consumed screenshot is refused');
  await until(async()=>{const rows=(await tool('browser_network',{tabId,after:0,limit:50})).value.entries;return rows.some(row=>row.url.endsWith('/api')&&row.finished);},'network completion');
  const consoleRows=(await tool('browser_console',{tabId,after:0,limit:50,level:'all'})).value.entries;assert.ok(consoleRows.some(row=>row.message.includes('fixture-click')));
  const consolePage=(await tool('browser_console',{tabId,after:0,limit:1,level:'all'})).value;assert.equal(consolePage.entries.length,1);assert.equal(consolePage.truncated,true);
  const consoleNext=(await tool('browser_console',{tabId,after:consolePage.nextCursor,limit:50,level:'all'})).value;assert.ok(consoleNext.entries.length>=1);assert.ok(consoleNext.entries.every(row=>row.seq>consolePage.nextCursor));
  const traffic=(await tool('browser_network',{tabId,after:0,limit:50})).value.entries;
  const request=traffic.find(row=>row.url.endsWith('/api'));
  const detail=(await tool('browser_network',{tabId,requestId:request.requestId,body:true})).value;
  assert.equal(detail.status,200);assert.match(detail.body.text,/network-body/);report.checks.push('console events; request details and response body');
  const stillActive=(await tool('browser_tabs',{action:'list'})).value.tabs.find(t=>t.active);assert.equal(stillActive.url,base+'/sentinel');report.checks.push('foreground sentinel stayed selected throughout');
  await tool('browser_evaluate',{tabId,pageId:snap.pageId,expression:'(()=>{const d=document.createElement("div");d.id="longFixture";d.style.height="2400px";document.body.append(d);return true;})()'});
  const full=await tool('browser_screenshot',{tabId,fullPage:true});const fullMeta=await sharp(Buffer.from(full.image.data,'base64')).metadata();assert.equal(fullMeta.height,full.value.height);assert.ok(full.value.height<=1600&&full.value.height>shot.value.height);
  const fullInput=await broker.execute('browser_action',{...coordinateClick,screenshotId:full.value.screenshotId},'session:fixture',null,async()=>true);assert.match(fullInput.error,/SCREENSHOT/);
  await tool('browser_evaluate',{tabId,pageId:snap.pageId,expression:'(document.querySelector("#longFixture").remove(),true)'});report.checks.push('full-page capture bounds decoded pixels and cannot authorize viewport coordinates');
  snap=await snapshot(tabId);const child=snap.frames.find(f=>f.url.includes('/frame'));assert.ok(child);
  const childSnap=(await tool('browser_snapshot',{tabId,frameId:child.frameId,maxNodes:100,maxChars:8000})).value;
  await tool('browser_action',{tabId,pageId:childSnap.pageId,action:'fill',ref:refFor(childSnap,'Frame note'),text:'frame text'});
  const childValue=await tool('browser_evaluate',{tabId,pageId:childSnap.pageId,frameId:child.frameId,expression:'document.querySelector("#frameNote").value'});assert.equal(childValue.value.value,'frame text');report.checks.push('cross-origin frame DOM, fill and JavaScript');
  await tool('browser_action',{tabId,pageId:childSnap.pageId,action:'click',ref:refFor(childSnap,'Frame action')});
  await until(async()=>(await tool('browser_evaluate',{tabId,pageId:childSnap.pageId,frameId:child.frameId,expression:'document.body.dataset.clicked'})).value.value==='yes','Frame click effect',2500);report.checks.push('cross-origin frame reference click with parent viewport conversion');
  const bounded=(await tool('browser_evaluate',{tabId,pageId:snap.pageId,expression:'(()=>{const a=[];a[4000000000]="last";return {array:a,long:"x".repeat(1000000)};})()'})).value;
  assert.ok(JSON.stringify(bounded).length<25000);assert.deepEqual(bounded.value.array,['last']);report.checks.push('sparse arrays and large evaluation strings remain bounded');
  const worker=(await cdp('Target.getTargets')).targetInfos.find(t=>t.type==='service_worker'&&t.url.endsWith('/fixture.js'));assert.ok(worker);
  const workerSession=(await cdp('Target.attachToTarget',{targetId:worker.targetId,flatten:true})).sessionId;
  await cdp('Runtime.evaluate',{expression:'restartControl()',awaitPromise:true},workerSession);
  const restored=await snapshot(tabId);assert.notEqual(restored.pageId,snap.pageId);snap=restored;
  const restoredForeign=await broker.execute('browser_snapshot',{tabId},'session:foreign',null,async()=>true);assert.match(restoredForeign.error,/TAB_OWNED/);report.checks.push('worker state reconstruction retains exact tab custody and renews observations');
  await cdp('Runtime.evaluate',{expression:`chrome.debugger.detach({tabId:${Number(tabId.split(':').at(-1))}})`,awaitPromise:true},workerSession);
  const cancelled=await broker.execute('browser_snapshot',{tabId},'session:fixture',null,async()=>true);assert.match(cancelled.error,/DETACHED|NOT_OWNED/);
  assert.equal((await tool('browser_tabs',{action:'list'})).value.tabs.find(t=>t.tabId===tabId).claimed,false);
  await tool('browser_tabs',{action:'attach',tabId});snap=await snapshot(tabId);report.checks.push('lost native debugger attachment retires custody even without its notification');
  await tool('browser_evaluate',{tabId,pageId:snap.pageId,expression:'(history.pushState({},"","#spa"),true)'});
  snap=await snapshot(tabId);
  assert.equal((await tool('browser_evaluate',{tabId,pageId:snap.pageId,expression:'document.querySelectorAll("[data-cos-browser-control]").length'})).value.value,1);report.checks.push('SPA navigation retains a single blue ownership overlay');
  await tool('browser_evaluate',{tabId,pageId:snap.pageId,expression:'(setTimeout(()=>alert("fixture dialog"),50),true)'});
  snap=await until(async()=>{const s=(await tool('browser_snapshot',{tabId,maxNodes:100,maxChars:8000})).value;return s.dialog?s:null;},'JavaScript dialog');
  await tool('browser_action',{tabId,pageId:snap.pageId,action:'dialog',accept:true});snap=await snapshot(tabId);report.checks.push('pending JavaScript dialog can be inspected and accepted without DOM deadlock');
  const stalePage=snap.pageId,staleRef=refFor(snap,'Increment counter');
  await tool('browser_navigate',{tabId,pageId:snap.pageId,action:'url',url:base+'/other'});
  const stale=await broker.execute('browser_action',{tabId,pageId:stalePage,action:'click',ref:staleRef},'session:fixture',null,async()=>true);assert.match(stale.error,/STALE/);report.checks.push('navigation revokes stale input');
  const created=await tool('browser_tabs',{action:'new',url:base+'/fixture'});assert.ok(created.value.tabId);
  await snapshot(created.value.tabId);await tool('browser_tabs',{action:'close',tabId:created.value.tabId});report.checks.push('new background tab and exact owned close');
  const closed=await broker.execute('browser_snapshot',{tabId:created.value.tabId},'session:fixture',null,async()=>true);assert.match(closed.error,/BROWSER_TAB_CLOSED/);
  await tool('browser_tabs',{action:'release',tabId});const after=(await tool('browser_tabs',{action:'list'})).value.tabs.find(t=>t.tabId===tabId);assert.ok(after&&!after.claimed);report.checks.push('release retains existing user tab');
  const released=await cdp('Runtime.evaluate',{expression:`chrome.scripting.executeScript({target:{tabId:${Number(tabId.split(':').at(-1))}},func:()=>document.visibilityState})`,awaitPromise:true,returnByValue:true},workerSession);
  assert.equal(released.result.value[0].result,'hidden');report.checks.push('release removes focus emulation; closed targets are distinguished without recreation');
  assert.equal((await tool('browser_tabs',{action:'list'})).value.tabs.find(t=>t.active).url,base+'/sentinel');
  report.ok=true;await fs.writeFile(path.join(output,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }
} catch(e) {await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({error:e.stack,stderr,checks:report.checks,timings},null,2));throw e;}
finally {broker.reset();for(const ws of wakeClients)ws.terminate();connection?.close();chrome.kill();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));}
