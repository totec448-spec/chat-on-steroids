// Arabic UI smoke test: isolated Electron renderer, never loads user settings,
// the COS backend, ChatGPT, browser extensions, or the installed application.
const { withoutScripts } = require('./ui-check-page.cjs');
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs', 'arabic-qa');
fs.mkdirSync(output, {recursive:true});
app.setPath('userData', path.join(output, 'isolated-electron-userdata'));

app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const script = `
    localStorage.setItem('cos.ui.language', 'ar');
    const { initLanguage, currentLanguage } = await import('/i18n.ts');
    initLanguage();
    const style = document.createElement('style');
    style.textContent='*,*::before,*::after{animation:none!important;transition:none!important}';
    document.head.append(style);
    window.__locale = currentLanguage;
    window.__ready = true;
  `;
  const server = await createServer({
    configFile:false,
    root:path.join(root,'src/renderer'),
    server:{host:'127.0.0.1',port:0},
    plugins:[{name:'arabic-test-fixture',configureServer(vite){
      vite.middlewares.use('/fixture-arabic.html',async (_req,res)=>{
        const html = withoutScripts(fs.readFileSync(path.join(root,'src/renderer/index.html'),'utf8'))
          .replace('</body>','<script type="module">'+script+'</script></body>');
        res.setHeader('Content-Type','text/html');
        res.end(await vite.transformIndexHtml('/fixture-arabic.html',html));
      });
    }}],
  });
  let win;
  const metrics=[];
  let failed=false;
  try {
    await server.listen();
    win=new BrowserWindow({show:false,width:1280,height:820,webPreferences:{sandbox:true,backgroundThrottling:false}});
    await win.loadURL(server.resolvedUrls.local[0]+'fixture-arabic.html');
    const evalJS=s=>win.webContents.executeJavaScript(s);
    for(let i=0;i<100 && !(await evalJS('window.__ready === true'));i++) await new Promise(r=>setTimeout(r,30));
    assert.equal(await evalJS('window.__ready === true'),true,'Arabic fixture must initialize');
    assert.equal(await evalJS('document.documentElement.dir'),'rtl');
    assert.equal(await evalJS('document.documentElement.lang'),'ar');
    assert.equal(await evalJS('document.getElementById("newChat").textContent.trim()'),'محادثة جديدة');
    const setPanel=async name=>{
      await evalJS(`(() => {
        const app=document.querySelector('.app');
        app.dataset.screen=${JSON.stringify(name==='chat'?'chat':'settings')};
        for(const panel of document.querySelectorAll('main .panel')) panel.classList.toggle('is-active',panel.dataset.panel===${JSON.stringify(name)});
      })()`);
    };
    const screens=['chat','appearance','setup','home','general','plugins','usage','activity','scheduled','skills','pets'];
    for(const width of [1280,900,760]){
      win.setSize(width,820);
      for(const name of screens){
        await setPanel(name);
        const m=await evalJS(`(() => {
          const sidebar=document.querySelector('.sidebar');
          const resize=document.getElementById('sidebarResize');
          const panel=document.querySelector('.panel.is-active');
          const rect=e=>{const r=e.getBoundingClientRect();return {left:Math.round(r.left),right:Math.round(r.right),width:Math.round(r.width),visible:!!r.width};};
          return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,
            sidebar:rect(sidebar),resize:rect(resize),panel:rect(panel),
            sidebarDirection:getComputedStyle(sidebar).direction,
            inputDirection:getComputedStyle(document.getElementById('chatInput')).direction,
            lang:document.documentElement.lang,dir:document.documentElement.dir,
            heading:panel.querySelector('h1')?.textContent||null,
            selection:document.getElementById('uiLanguage').value};
        })()`);
        metrics.push({width,name,...m});
        assert.equal(m.lang,'ar');
        assert.equal(m.dir,'rtl');
        assert.equal(m.selection,'ar');
        assert.ok(m.documentWidth<=m.viewport+2,`Page overflows at ${width} ${name}: ${m.documentWidth}`);
        assert.ok(m.sidebar.left >= (m.viewport/2)-8,`Sidebar should be right-aligned in Arabic ${width} ${name}`);
        assert.ok(Math.abs((m.resize.left+m.resize.right)/2-m.sidebar.left)<=6,
          `Arabic resize handle must sit on the sidebar's left edge: ${width} ${name}`);
        assert.ok(m.panel.visible,`Panel missing ${width} ${name}`);
        assert.ok(m.panel.left>=-2&&m.panel.right<=m.viewport+2,
          `Panel spills outside viewport: ${width} ${name}`);
        fs.writeFileSync(path.join(output,`arabic-${name}-${width}.png`),
          (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      }
    }
    // The real RTL composer uses a right-side sidebar. The mode popover must
    // grow inward from its trigger instead of hiding behind that sidebar.
    await setPanel('chat');
    for(const width of [1280,900,760]){
      win.setSize(width,820);
      await evalJS('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const placement=await evalJS(`(() => {
        const details=document.getElementById('composerSettings');
        details.classList.add('mode-picker');
        details.open=true;
        const menu=details.querySelector('.composer-popover').getBoundingClientRect();
        const trigger=details.querySelector('summary').getBoundingClientRect();
        const card=document.querySelector('.card.is-session').getBoundingClientRect();
        const buttons=[...details.querySelectorAll('#automationSwitch [role=radio]')];
        return {viewport:innerWidth,menu:{left:menu.left,right:menu.right,width:menu.width},trigger:{left:trigger.left,right:trigger.right},card:{left:card.left,right:card.right},
          buttonsFit:buttons.every(button=>{const r=button.getBoundingClientRect();return r.left>=menu.left-1&&r.right<=menu.right+1}),direction:document.documentElement.dir};
      })()`);
      assert.equal(placement.direction,'rtl');
      assert.ok(placement.menu.width>300,`The mode popover must be visible at ${width}: ${JSON.stringify(placement)}`);
      assert.ok(Math.abs(placement.menu.right-placement.trigger.right)<=2,
        `RTL mode menu must open inward from the right edge, not under the sidebar at ${width}: ${JSON.stringify(placement)}`);
      assert.ok(placement.menu.left>=placement.card.left-2&&placement.menu.right<=placement.card.right+2,
        `RTL mode options must fit the visible chat pane at ${width}: ${JSON.stringify(placement)}`);
      assert.ok(placement.buttonsFit,`RTL mode option buttons must fit their menu at ${width}`);
      if(width===1280) fs.writeFileSync(path.join(output,'arabic-composer-modes-1280.png'),
        (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    }
    await evalJS(`document.getElementById('composerSettings').open=false`);
    // Other toolbar popovers also mirror toward the chat pane: attachments
    // anchor on the right in RTL; the model chooser anchors on the left.
    for(const width of [1280,900,760]){
      win.setSize(width,820);
      await evalJS('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      for(const [id,side] of [['attachmentMenu','right'],['modelMenu','left']]){
        const placement=await evalJS(`(() => {
          const details=document.getElementById(${JSON.stringify(id)});details.open=true;
          const menu=details.querySelector('.composer-popover').getBoundingClientRect();
          const trigger=details.querySelector('summary').getBoundingClientRect();
          const pane=document.querySelector('.card.is-session').getBoundingClientRect();
          const result={viewport:innerWidth,menu:{left:menu.left,right:menu.right,width:menu.width},
            trigger:{left:trigger.left,right:trigger.right},pane:{left:pane.left,right:pane.right}};
          details.open=false;return result;
        })()`);
        assert.ok(placement.menu.width>=200,`RTL ${id} must be visible: ${JSON.stringify(placement)}`);
        assert.ok(Math.abs(placement.menu[side]-placement.trigger[side])<=2,
          `RTL ${id} must anchor to the ${side} of its trigger at ${width}: ${JSON.stringify(placement)}`);
        assert.ok(placement.menu.left>=placement.pane.left-2&&placement.menu.right<=placement.pane.right+2,
          `RTL ${id} must stay inside its chat pane at ${width}: ${JSON.stringify(placement)}`);
      }
    }
    await evalJS(`(() => {document.getElementById('uiLanguage').value='en';document.getElementById('uiLanguage').dispatchEvent(new Event('change'));})()`);
    assert.equal(await evalJS('document.documentElement.dir'),'ltr');
    assert.equal(await evalJS('document.getElementById("newChat").textContent.trim()'),'New chat');
    assert.equal(await evalJS('localStorage.getItem("cos.ui.language")'),'en');
    const englishGeometry=await evalJS(`(() => {
      const s=document.getElementById('sidebar').getBoundingClientRect();
      const r=document.getElementById('sidebarResize').getBoundingClientRect();
      return {sidebarLeft:s.left,sidebarRight:s.right,resizeX:r.left+r.width/2};
    })()`);
    assert.ok(Math.abs(englishGeometry.sidebarLeft)<2,'LTR sidebar must stay on the left');
    assert.ok(Math.abs(englishGeometry.sidebarRight-englishGeometry.resizeX)<6,
      'LTR sidebar drag handle must stay on its right edge');
    // Compare a safe, isolated sample screen in English and Arabic.
    await setPanel('general');
    assert.equal(await evalJS("document.querySelector('.panel.is-active').dataset.panel"), 'general');
    // The hidden Electron compositor may still hold the previous panel's frame.
    // Give it one short paint opportunity before recording the visual proof.
    await new Promise(resolve => setTimeout(resolve, 150));
    fs.writeFileSync(path.join(output,'english-general-760.png'),
      (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    await evalJS(`document.querySelector('[data-language="ar"]').click()`);
    assert.equal(await evalJS('document.documentElement.dir'),'rtl');
    assert.equal(await evalJS('localStorage.getItem("cos.ui.language")'),'ar');
    await setPanel('chat');
    const draftCheck = await evalJS(`(() => {
      const textarea=document.getElementById('chatInput');
      textarea.value='مرحبا ChatGPT — اختبار عربي';
      const arabicDirection=getComputedStyle(textarea).direction;
      textarea.value='Hello ChatGPT — English test';
      const englishDirection=getComputedStyle(textarea).direction;
      textarea.value='مرحبا ChatGPT — اختبار عربي';
      return {arabicDirection,englishDirection,text:textarea.value,dirAttribute:textarea.getAttribute('dir')};
    })()`);
    assert.deepEqual(draftCheck,{arabicDirection:'rtl',englishDirection:'ltr',
      text:'مرحبا ChatGPT — اختبار عربي',dirAttribute:'auto'},'Text direction must follow the typed message');
    fs.writeFileSync(path.join(output,'metrics.json'),JSON.stringify(metrics,null,2)+'\n');
    console.log(JSON.stringify({status:'PASS',screenshots:metrics.length,metrics:metrics.map(m=>({width:m.width,screen:m.name,sidebar:m.sidebar,resize:m.resize,heading:m.heading,bodyOverflow:m.documentWidth>m.viewport}))},null,2));
  }catch(e){
    console.error(e.stack||e);
    failed=true;
  }finally{
    win?.destroy();
    await server.close();
    if(failed) process.exit(1);
    app.quit();
  }
}).catch(e=>{console.error(e);app.exit(1);});
