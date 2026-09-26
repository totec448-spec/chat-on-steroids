/** Read-only Chromium rendering of synthetic recorded actions; no project/Git/tool execution. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
if (!process.versions.electron) {
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], {env,encoding:'utf8',windowsHide:true,timeout:60000});
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);
}
const {app,BrowserWindow}=require('electron');
app.whenReady().then(async()=>{
  const root=path.join(__dirname,'..');
  const bundle=(await require('esbuild').build({entryPoints:[path.join(root,'src/renderer/action-details.ts')],bundle:true,write:false,platform:'browser',format:'iife',globalName:'actions'})).outputFiles[0].text;
  const css=['styles.css','action-details.css'].map(name=>fs.readFileSync(path.join(root,'src/renderer',name),'utf8')).join('\n');
  const win=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{offscreen:true,sandbox:true,partition:'action-details-fixture',backgroundThrottling:false}});
  await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<style>${css}</style><main style="margin:30px;max-width:940px" id="fixture"></main>`));
  await win.webContents.executeJavaScript(bundle);
  await win.webContents.executeJavaScript(`(()=>{
    const stored=value=>({text:typeof value==='string'?value:JSON.stringify(value),chars:typeof value==='string'?value.length:JSON.stringify(value).length,truncated:false});
    const call=(tool,args,result)=>({tool,callId:'fixture',attribution:'request_id',requestId:'fixture',conversationId:'fixture',attributionMethod:'request_id',
      args:stored(args),result:stored(result),outcome:'ok',durationMs:12,summary:{kind:'other',tone:'good',title:'Synthetic action'}});
    const patch=['*** Begin Patch','*** Update File: src/example.ts','@@','-return oldValue;','+return newValue;',' context','*** End Patch'].join('\\n');
    for(const value of [call('apply_patch',{patch},'Applied'),call('exec_command',{cmd:'npm test',workdir:'/project'},{output:'12 tests passed',exit_code:0}),
      call('read',{paths:['/project/src/example.ts:1-40']},'Recorded source'),call('browser_navigate',{url:'https://example.com/documentation',tabId:'owned-tab'},{url:'https://example.com/documentation',title:'Documentation',readyState:'complete'})])
      document.getElementById('fixture').append(actions.renderActionDetails(value));
  })()`);
  const measurements=[];
  for(const width of [1200,900,520]) {
    win.webContents.enableDeviceEmulation({screenPosition:'desktop',screenSize:{width,height:850},viewPosition:{x:0,y:0},viewSize:{width,height:850},deviceScaleFactor:1,scale:1});
    await new Promise(resolve=>setTimeout(resolve,50));
    const result=await win.webContents.executeJavaScript(`(()=>{
      const nodes=[...document.querySelectorAll('.action-details')],add=document.querySelector('.action-details-line-added'),remove=document.querySelector('.action-details-line-removed');
      return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,count:nodes.length,
        inside:nodes.every(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}),
        added:add.textContent,removed:remove.textContent,differentColors:getComputedStyle(add).color!==getComputedStyle(remove).color,
        interactive:document.querySelectorAll('#fixture a,#fixture button,#fixture script,#fixture iframe').length,
        facts:document.getElementById('fixture').textContent};})()`);
    assert.equal(result.count,4);assert.equal(result.overflow,false);assert.equal(result.inside,true);assert.equal(result.interactive,0);
    assert.equal(result.differentColors,true);assert.match(result.added,/^\+/);assert.match(result.removed,/^-/);
    assert.match(result.facts,/Exit code/);assert.match(result.facts,/Recorded URL/);assert.match(result.facts,/Requested path/);
    delete result.facts;measurements.push(result);
  }
  const output=path.join(root,'outputs','r8-action-layout.json');fs.writeFileSync(output,JSON.stringify({ok:true,measurements},null,2));
  console.log(JSON.stringify({ok:true,measurements},null,2));win.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
