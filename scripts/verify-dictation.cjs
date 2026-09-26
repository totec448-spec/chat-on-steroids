/** Isolated Chromium acceptance: fake audio device, synthetic transcript, no account or paid API. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
if (!process.versions.electron) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-dictation-fixture-'));
  const env = { ...process.env, COS_DICTATION_FIXTURE_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = require('node:child_process').spawnSync(require('electron'), [__filename], { env, encoding:'utf8',windowsHide:true,timeout:90000 });
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    process.exitCode = result.status ?? 1;
  } finally { fs.rmSync(profile, { recursive:true,force:true }); }
} else {
  const {app,BrowserWindow,dialog,systemPreferences} = require('electron');
  app.setPath('userData',process.env.COS_DICTATION_FIXTURE_PROFILE);
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
  app.whenReady().then(async()=>{
    const root=path.join(__dirname,'..'), output=path.join(root,'outputs','dictation-chromium');fs.mkdirSync(output,{recursive:true});
    const esbuild=require('esbuild');
    const bundle=async(entry,options={})=>(await esbuild.build({entryPoints:[path.join(root,entry)],bundle:true,write:false,...options})).outputFiles[0].text;
    const main=await bundle('src/main/dictation-ipc.ts',{platform:'node',format:'cjs',external:['electron'],plugins:[{
      name:'fixture-secrets-only',setup(build){build.onResolve({filter:/^\.\/secrets\.js$/},()=>({path:'secrets',namespace:'fixture'}));
      build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export async function hasSecret(key){if(key!=='dictationApiKey')throw Error('Wrong secret slot');return true;}
        export async function getSecret(key){if(key!=='dictationApiKey')throw Error('Wrong secret slot');return 'synthetic-key';}
        export async function setSecret(){throw Error('Fixture must not change credentials');}`}));}
    }]});
    const mainFile=path.join(output,'main.cjs');fs.writeFileSync(mainFile,main);
    const preload=await bundle('src/preload/index.ts',{platform:'node',format:'cjs',external:['electron']});
    const preloadFile=path.join(output,'preload.cjs');fs.writeFileSync(preloadFile,preload);
    const renderer=(await esbuild.build({stdin:{resolveDir:root,contents:
      "export * from './src/renderer/dictation.ts'; export { setLanguage } from './src/renderer/i18n.ts';"},
      bundle:true,write:false,platform:'browser',format:'iife',globalName:'dictation'})).outputFiles[0].text;
    let requests=0, consent=0;
    dialog.showMessageBox=async()=>{consent++;return{response:0,checkboxChecked:false};};
    // Fake-device acceptance must not change the test machine's macOS microphone
    // consent. OS prompting is a separate manual gate, not part of this fixture.
    if (process.platform==='darwin') systemPreferences.askForMediaAccess=async type=>{assert.equal(type,'microphone');return true;};
    globalThis.fetch=async(url,options)=>{
      assert.equal(url,'https://api.openai.com/v1/audio/transcriptions');assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
      const body=options.body, file=body.get('file');assert.equal(file.type,'audio/webm');assert.ok(file.size>100);assert.ok(file.size<8*1024*1024);
      assert.equal(body.get('model'),'gpt-4o-mini-transcribe');assert.equal(body.has('prompt'),false);requests++;
      return new Response(new ReadableStream({start(controller){
        controller.enqueue(new TextEncoder().encode('data: {"type":"transcript.text.delta","delta":"Synthetic dictation"}\n\n'));
        setTimeout(()=>{controller.enqueue(new TextEncoder().encode('data: {"type":"transcript.text.done","text":"Synthetic dictation result."}\n\n'));controller.close();},150);
      }}),{headers:{'content-type':'text/event-stream'}});
    };
    const win=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{preload:preloadFile,sandbox:true,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
    // The hidden fixture must not take the user's foreground window. Model focus
    // only; real sender/frame URLs and Chromium media permission details remain intact.
    const target=new Proxy(win,{get(object,key){if(key==='isFocused'||key==='isVisible')return()=>true;const value=Reflect.get(object,key);return typeof value==='function'?value.bind(object):value;}});
    require(mainFile).registerDictationIpc(()=>target);
    const styles=['styles.css','dictation.css'].map(file=>fs.readFileSync(path.join(root,'src/renderer',file),'utf8')).join('\n');
    const html=`<!doctype html><html><head><meta charset="UTF-8"><style>${styles}</style></head><body><form style="margin:80px"><textarea id="chatInput">Existing draft</textarea><button type="button" id="dictationButton">Voice</button></form></body></html>`;
    const htmlFile=path.join(output,'fixture.html');fs.writeFileSync(htmlFile,html);await win.loadFile(htmlFile);
    const evaluate=script=>win.webContents.executeJavaScript(script,true);
    await evaluate(renderer);
    await evaluate(`(()=>{const get=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia=async opts=>{const stream=await get(opts);if(opts.audio&&!opts.video)window.fixtureStream=stream;return stream;};
      window.submits=0;document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();window.submits++;});
      const input=document.getElementById('chatInput');input.setSelectionRange(input.value.length,input.value.length);
      window.dictationControl=dictation.initDictation({input,button:document.getElementById('dictationButton'),owner:()=> 'synthetic-draft:1',api:window.api,copy:async()=>{}});
      document.getElementById('dictationButton').click();})()`);
    const wait=async expected=>{const end=Date.now()+15000;while(Date.now()<end){const phase=await evaluate(`document.getElementById('dictationDialog').dataset.phase`);if(phase===expected)return;if(phase==='error')throw Error(await evaluate(`document.getElementById('dictationStatus').textContent`));await new Promise(resolve=>setTimeout(resolve,30));}throw Error('Timed out waiting for '+expected);};
    await wait('ready');assert.equal(requests,0);
    await evaluate(`document.getElementById('dictationRecord').click()`);await wait('recording');
    const video=await evaluate(`navigator.mediaDevices.getUserMedia({video:true,audio:false}).then(s=>{s.getTracks().forEach(t=>t.stop());return 'incorrectly allowed';},()=> 'denied')`);
    assert.equal(video,'denied');await new Promise(resolve=>setTimeout(resolve,900));
    await evaluate(`document.getElementById('dictationFinish').click()`);await wait('review');
    const result=await evaluate(`({draft:document.getElementById('chatInput').value,transcript:document.getElementById('dictationPreview').value,
      tracks:window.fixtureStream.getTracks().map(t=>t.readyState),submits:window.submits})`);
    assert.equal(result.draft,'Existing draft');assert.equal(result.transcript,'Synthetic dictation result.');assert.ok(result.tracks.every(value=>value==='ended'));assert.equal(result.submits,0);
    const contrast=[];
    for (const theme of ['light','dark']) {
      const colors=await evaluate(`(()=>{document.documentElement.dataset.theme=${JSON.stringify(theme)};const style=getComputedStyle(document.getElementById('dictationInsert'));return{foreground:style.color,background:style.backgroundColor};})()`);
      const luminance=rgb=>{
        const channels=rgb.match(/[\d.]+/g).slice(0,3).map(value=>{const s=Number(value)/255;return s<=0.04045?s/12.92:((s+0.055)/1.055)**2.4;});
        return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;
      };
      const a=luminance(colors.foreground),b=luminance(colors.background),ratio=(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
      assert.ok(ratio>=4.5,`Primary text lacks contrast in ${theme}: ${ratio}`);
      contrast.push({theme,ratio});
    }
    await evaluate("document.documentElement.dataset.theme='light'");
    const geometry=[];
    for(const locale of ['en','es','fr','ja','tr','zh-CN','zh-TW']) for(const width of [1200,900,520]){
      await evaluate(`dictation.setLanguage(${JSON.stringify(locale)})`);
      win.webContents.enableDeviceEmulation({screenPosition:'desktop',screenSize:{width,height:850},viewPosition:{x:0,y:0},viewSize:{width,height:850},deviceScaleFactor:1,scale:1});
      await new Promise(resolve=>setTimeout(resolve,50));
      const rect=await evaluate(`(()=>{const d=document.getElementById('dictationDialog'),r=d.getBoundingClientRect();return{width:innerWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom,scrollWidth:d.scrollWidth,clientWidth:d.clientWidth};})()`);
      assert.ok(rect.left>=10&&rect.right<=width-10&&rect.top>=10&&rect.bottom<=840,JSON.stringify(rect));
      assert.ok(Math.abs((rect.left+rect.right)/2-width/2)<2,'Dialog must be centered, not reset to the top-left');
      assert.ok(rect.scrollWidth<=rect.clientWidth+1);geometry.push({locale,...rect});
    }
    await evaluate("dictation.setLanguage('en')");
    win.webContents.disableDeviceEmulation();await new Promise(resolve=>setTimeout(resolve,50));
    fs.writeFileSync(path.join(output,'review.png'),(await win.webContents.capturePage()).toPNG());
    await evaluate(`document.getElementById('dictationInsert').click()`);
    assert.equal(await evaluate(`document.getElementById('chatInput').value`),'Existing draft Synthetic dictation result.');assert.equal(requests,1);
    await evaluate(`document.getElementById('dictationButton').click()`);await wait('ready');
    await evaluate(`document.getElementById('dictationRecord').click()`);await wait('recording');
    await evaluate(`document.getElementById('dictationClose').click()`);await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(requests,1);assert.equal(consent,1);assert.equal(await evaluate(`window.fixtureStream.getTracks().every(t=>t.readyState==='ended')`),true);
    const receipt={ok:true,syntheticAudio:true,paidRequests:0,uploads:requests,cameraDenied:true,draftOnly:true,cancelStopsTracks:true,geometry,contrast};
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
    await evaluate('window.dictationControl.dispose()');win.destroy();app.quit();
  }).catch(error=>{console.error(error);app.exit(1);});
}
