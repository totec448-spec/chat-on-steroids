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
fs.rmSync(path.join(output,'qa-last-error.txt'),{force:true});
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
    // Worktrees may link node_modules outside the repo. Explicitly allow its
    // real path or the icon font silently 403s and screenshots show tofu.
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules'))]}},
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
    // Keep the only supported language changes as fixed scripts. Building
    // executable JavaScript from a variable triggers CodeQL's code-injection
    // check even if the current caller iterates a fixed list of languages.
    const setFixtureLanguage=language=>{
      assert.ok(language==='ar'||language==='en','Unexpected fixture language');
      return evalJS(language==='ar'
        ? "(() => {const e=document.getElementById('uiLanguage');e.value='ar';e.dispatchEvent(new Event('change'));})()"
        : "(() => {const e=document.getElementById('uiLanguage');e.value='en';e.dispatchEvent(new Event('change'));})()");
    };
    for(let i=0;i<100 && !(await evalJS('window.__ready === true'));i++) await new Promise(r=>setTimeout(r,30));
    assert.equal(await evalJS('window.__ready === true'),true,'Arabic fixture must initialize');
    const font=await evalJS(`document.fonts.ready.then(() => ({
      loaded:[...document.fonts].some(face => face.family === 'CoS Phosphor' && face.status === 'loaded'),
      family:getComputedStyle(document.querySelector('.ph')).fontFamily
    }))`);
    assert.ok(font.loaded && font.family.includes('CoS Phosphor'),
      'Arabic visual QA must load the real Phosphor font, not screenshot missing-icon squares: '+JSON.stringify(font));
    assert.equal(await evalJS('document.documentElement.dir'),'rtl');
    assert.equal(await evalJS('document.documentElement.lang'),'ar');
    assert.equal(await evalJS('document.getElementById("newChat").textContent.trim()'),'محادثة جديدة');
    const setPanel=async name=>{
      await evalJS(`(() => {
        const app=document.querySelector('.app');
        app.dataset.screen=${JSON.stringify(name==='chat'?'chat':'settings')};
        for(const panel of document.querySelectorAll('main .panel')) panel.classList.toggle('is-active',panel.dataset.panel===${JSON.stringify(name)});
      })()`);
      // Screenshots must reflect the newly activated panel, not the previous
      // compositor frame. Hidden Electron windows can capture before a paint.
      // In a hidden Electron window, rAF may stop while zoom is changing.
      // Force one compositor capture instead of waiting indefinitely for rAF.
      await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      await new Promise(resolve => setTimeout(resolve, 65));
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
    // Arabic visual matrix in the light palette. Each panel is settled before
    // capture, and sidebar placement/overflow must remain valid at every width.
    await evalJS("document.documentElement.dataset.theme='light'");
    for(const width of [1280,900,760]){
      win.setSize(width,820);
      for(const name of screens){
        await setPanel(name);
        const m=await evalJS(`(() => {
          const sidebar=document.getElementById('sidebar').getBoundingClientRect();
          const panel=document.querySelector('.panel.is-active').getBoundingClientRect();
          return {viewport:innerWidth,bodyWidth:document.documentElement.scrollWidth,
            sidebarLeft:sidebar.left,panelLeft:panel.left,panelRight:panel.right,
            theme:document.documentElement.dataset.theme,dir:document.documentElement.dir};
        })()`);
        assert.equal(m.theme,'light');
        assert.equal(m.dir,'rtl');
        assert.ok(m.bodyWidth<=m.viewport+2 && m.sidebarLeft>=m.viewport/2-8,
          `Light RTL page or sidebar overflow at ${width} ${name}: ${JSON.stringify(m)}`);
        assert.ok(m.panelLeft>=-2 && m.panelRight<=m.viewport+2,
          `Light RTL panel overflow at ${width} ${name}: ${JSON.stringify(m)}`);
        fs.writeFileSync(path.join(output,`arabic-light-${name}-${width}.png`),
          (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      }
    }
    await evalJS("document.documentElement.dataset.theme='dark'");
    // Long Arabic labels must survive browser zoom, not just window resizing.
    // Only the main flow panels are sampled here; the full light/dark/width
    // matrix above already covers all 11 sections at 100% zoom.
    for(const zoom of [1.25,1.5]){
      win.webContents.setZoomFactor(zoom);
      for(const width of [1280,900,760]){
        win.setSize(width,820);
        for(const name of ['chat','general','setup','appearance','plugins']){
          await setPanel(name);
          const m=await evalJS(`(() => {
            const app=document.querySelector('.app').getBoundingClientRect();
            const sidebar=document.getElementById('sidebar').getBoundingClientRect();
            const panel=document.querySelector('.panel.is-active').getBoundingClientRect();
            return {viewport:innerWidth,bodyWidth:document.documentElement.scrollWidth,appRight:app.right,
              sidebarLeft:sidebar.left,panelLeft:panel.left,panelRight:panel.right};
          })()`);
          assert.ok(m.bodyWidth<=m.viewport+2 && m.panelLeft>=-2 && m.panelRight<=m.viewport+2,
            `RTL zoom ${zoom} panel overflow at ${width} ${name}: ${JSON.stringify(m)}`);
          assert.ok(m.sidebarLeft>=m.viewport/2-8,
            `RTL zoom ${zoom} sidebar should remain on the right: ${JSON.stringify(m)}`);
        }
      }
    }
    win.webContents.setZoomFactor(1);
    const navigation=await evalJS(`(() => Object.fromEntries(
      ['browserContinue','browserBack','resumeLastSummary','backToChat'].map(id=>{
        const node=document.getElementById(id).querySelector('.ph-arrow-left,.ph-arrow-right');
        return [id,getComputedStyle(node).transform];
      })
    ))()`);
    // Wizard steps and the resume control are initially hidden; Chromium may
    // return transform:none for descendants of display:none despite matching
    // an RTL CSS rule. Verify the rule is present, and assert computed layout
    // only for controls currently visible in the fixture.
    const hasRule=await evalJS(`[...document.styleSheets].some(sheet=>{
      try{return [...sheet.cssRules].some(rule=>rule.cssText.includes('browserContinue > .ph-arrow-right')
        && rule.cssText.includes('browserBack > .ph-arrow-left') && rule.cssText.includes('scaleX(-1)'))}
      catch{return false}
    })`);
    assert.ok(hasRule,'RTL wizard arrow rule must exist and mirror both navigation controls');
    assert.equal(navigation.backToChat,'none','The Arabic right-sidebar return to chat still points left');
    // The real RTL composer uses a right-side sidebar. The mode popover must
    // grow inward from its trigger instead of hiding behind that sidebar.
    await setPanel('chat');
    for(const width of [1280,900,760]){
      win.setSize(width,820);
      await new Promise(resolve=>setTimeout(resolve,70));
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
      await new Promise(resolve=>setTimeout(resolve,70));
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
    // Delivery choices share the send button's left edge in RTL. A right
    // anchor here used to extend the popover outside a narrow chat panel.
    for(const width of [1280,900,760]){
      win.setSize(width,820);
      await new Promise(resolve=>setTimeout(resolve,70));
      const placement=await evalJS(`(() => {
        const options=document.getElementById('sendOptions');
        const trigger=document.querySelector('.send-control');
        const pane=document.querySelector('.card.is-session');
        const wasHidden=options.hidden;
        options.hidden=false;options.style.display='block';
        const menu=options.getBoundingClientRect(),button=trigger.getBoundingClientRect(),area=pane.getBoundingClientRect();
        const result={left:menu.left,right:menu.right,buttonLeft:button.left,paneLeft:area.left,paneRight:area.right,viewport:innerWidth};
        options.style.display='';options.hidden=wasHidden;return result;
      })()`);
      assert.ok(Math.abs(placement.left-(placement.buttonLeft-8))<2,
        `RTL delivery choices should open from the send button's left edge: ${JSON.stringify(placement)}`);
      assert.ok(placement.left>=placement.paneLeft-2&&placement.right<=placement.paneRight+2,
        `RTL delivery choices should fit the chat pane at ${width}: ${JSON.stringify(placement)}`);
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
    // True paired comparison images: exactly the same production renderer,
    // synthetic data, viewport and palette in English (LTR) and Arabic (RTL).
    // Capture the English matrix here; the Arabic matrix was already captured
    // above before switching. Width 760 is the narrow-window comparison.
    for(const theme of ['dark','light']){
      await evalJS(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      for(const width of [1280,760]){
        win.setSize(width,820);
        for(const name of screens){
          await setPanel(name);
          const geometry=await evalJS(`(() => ({
            lang:document.documentElement.lang,dir:document.documentElement.dir,
            viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,
            theme:document.documentElement.dataset.theme,
            panelVisible:document.querySelector('.panel.is-active').getBoundingClientRect().width>0
          }))()`);
          assert.equal(geometry.dir,'ltr');
          assert.equal(geometry.lang,'en');
          assert.equal(geometry.theme,theme);
          assert.ok(geometry.panelVisible&&geometry.scrollWidth<=geometry.viewport+2,
            `English comparison screenshot overflows: ${JSON.stringify({name,width,...geometry})}`);
          fs.writeFileSync(path.join(output,`english-${theme}-${name}-${width}.png`),
            (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
        }
      }
    }
    // High contrast comparison, both languages and window widths. The user
    // palette is untouched: this is an isolated test profile.
    await evalJS("document.documentElement.dataset.highContrast='true'");
    for(const language of ['en','ar']){
      await setFixtureLanguage(language);
      for(const theme of ['dark','light']){
        await evalJS(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
        for(const width of [1280,760]){
          win.setSize(width,820);
          for(const name of ['chat','general']){
            await setPanel(name);
            assert.equal(await evalJS('document.documentElement.dataset.highContrast'),'true');
            fs.writeFileSync(path.join(output,`contrast-${language}-${theme}-${name}-${width}.png`),
              (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
          }
        }
      }
    }
    await evalJS("document.documentElement.dataset.highContrast='false'");
    await evalJS("document.documentElement.dataset.theme='dark'");
    // Paired real built-in dialog and composer menu captures. A dialog's real
    // markup and styles are used; no user messages or accounts are supplied.
    for(const language of ['en','ar']){
      await setFixtureLanguage(language);
      for(const width of [1280,760]){
        win.setSize(width,820);
        await setPanel('chat');
        for(const id of ['composerSettings','attachmentMenu','modelMenu']){
          const detail=await evalJS(`(() => {
            const menu=document.getElementById(${JSON.stringify(id)});menu.open=true;
            const rect=menu.querySelector('.composer-popover').getBoundingClientRect();
            return {left:rect.left,right:rect.right,viewport:innerWidth};
          })()`);
          assert.ok(detail.left>=-2&&detail.right<=detail.viewport+2,
            `Composer menu clipped: ${language}/${width}/${id} ${JSON.stringify(detail)}`);
          await new Promise(resolve=>setTimeout(resolve,80));
          fs.writeFileSync(path.join(output,`paired-${language}-${id}-${width}.png`),
            (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
          await evalJS(`document.getElementById(${JSON.stringify(id)}).open=false`);
        }
        for(const id of ['searchDialog','exportSettingsDialog','skillGithubDialog']){
          await setPanel(id==='skillGithubDialog'?'skills':'chat');
          const dialog=await evalJS(`(() => {
            const d=document.getElementById(${JSON.stringify(id)});d.showModal();
            const r=d.getBoundingClientRect();return {width:r.width,left:r.left,right:r.right,viewport:innerWidth};
          })()`);
          assert.ok(dialog.width>100&&dialog.left>=-2&&dialog.right<=dialog.viewport+2,
            `Dialog clipped: ${language}/${width}/${id} ${JSON.stringify(dialog)}`);
          await new Promise(resolve=>setTimeout(resolve,80));
          fs.writeFileSync(path.join(output,`paired-${language}-${id}-${width}.png`),
            (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
          await evalJS(`document.getElementById(${JSON.stringify(id)}).close()`);
        }
      }
    }
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
    console.error('COS_QA_TEST_FAILED:',e.stack||e);
    fs.writeFileSync(path.join(output,'qa-last-error.txt'),String(e.stack||e));
    failed=true;
  }finally{
    win?.destroy();
    await server.close();
    // Electron overrides Node process shutdown semantics on some Windows
    // builds: process.exit(1) was reported as exit 0 by the test supervisor.
    // app.exit(code) propagates the actual failure status to verify-ui.mjs.
    if(failed) app.exit(1);
    else app.quit();
  }
}).catch(e=>{console.error(e);app.exit(1);});
