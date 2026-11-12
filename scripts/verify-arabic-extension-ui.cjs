// Isolated Arabic Chrome popup renderer; no browser profile or live application.
const { JSDOM } = require('jsdom');
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root,'outputs','arabic-qa');
fs.mkdirSync(output,{recursive:true});
app.setPath('userData',path.join(output,'extension-test-userdata'));

function popupHtml(language) {
  const html=fs.readFileSync(path.join(root,'extension','popup.html'),'utf8');
  const messages=JSON.parse(fs.readFileSync(path.join(root,'extension','_locales',language,'messages.json'),'utf8'));
  const doc=new JSDOM(html).window.document;
  doc.documentElement.lang=language;
  doc.documentElement.dir=language==='ar'?'rtl':'ltr';
  for(const script of doc.querySelectorAll('script'))script.remove();
  const fields=[['i18n','textContent'],['i18nTitle','title'],['i18nAriaLabel','aria-label']];
  for(const [attribute,destination] of fields){
    for(const el of doc.querySelectorAll('[data-'+attribute.replace(/[A-Z]/g,x=>'-'+x.toLowerCase())+']')){
      const key=el.dataset[attribute];
      if(!key||!messages[key])continue;
      if(destination==='textContent')el.textContent=messages[key].message;
      else el.setAttribute(destination,messages[key].message);
    }
  }
  const sheet=doc.querySelector('link[href="popup.css"]');
  sheet.href=path.relative(output,path.join(root,'extension','popup.css')).replace(/\\/g,'/');
  for(const icon of doc.querySelectorAll('img[src^="icons/"]')){
    icon.src=path.relative(output,path.join(root,'extension',icon.getAttribute('src'))).replace(/\\/g,'/');
  }
  return doc.documentElement.outerHTML;
}
app.whenReady().then(async()=>{
  let win;
  try{
    win=new BrowserWindow({show:false,width:410,height:850,webPreferences:{sandbox:true,backgroundThrottling:false}});
    for(const lang of ['en','ar']){
      const file=path.join(output,'isolated-extension-'+lang+'.html');
      fs.writeFileSync(file,'<!doctype html>'+popupHtml(lang));
      await win.loadFile(file);
      const metrics=await win.webContents.executeJavaScript("(() => { const d=document, e=d.documentElement, shell=d.querySelector('.shell'); const r=shell.getBoundingClientRect(); const call=d.createElement('div');call.className='call';const id=d.createElement('span');id.className='id';id.textContent='abc-123-def';call.append(id);shell.append(call);const technicalIds=['#d-chat','#d-req','.call .id'].map(sel=>{const s=getComputedStyle(d.querySelector(sel));return {selector:sel,dir:s.direction,bidi:s.unicodeBidi};});call.remove();return {lang:e.lang,dir:e.dir,direction:getComputedStyle(shell).direction,viewport:innerWidth,scrollWidth:e.scrollWidth,popupWidth:Math.round(r.width),title:d.querySelector('h1')?.textContent,localized:d.querySelectorAll('[data-i18n]').length,cssLoaded:getComputedStyle(shell).paddingTop,technicalIds}; })()");
      assert.equal(metrics.lang,lang);
      assert.equal(metrics.dir,lang==='ar'?'rtl':'ltr');
      assert.equal(metrics.direction,lang==='ar'?'rtl':'ltr');
      assert.ok(metrics.scrollWidth<=metrics.viewport,'Popup overflow '+lang+': '+JSON.stringify(metrics));
      assert.ok(metrics.localized>5,'Popup should contain localizable messages');
      assert.notEqual(metrics.cssLoaded,'0px','Popup stylesheet should load');
      if(lang==='ar') assert.ok(metrics.technicalIds.every(item=>item.dir==='ltr'&&item.bidi==='isolate'),
        'All raw extension IDs must be isolated from RTL: '+JSON.stringify(metrics.technicalIds));
      fs.writeFileSync(path.join(output,'extension-popup-'+lang+'.png'),
        (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      console.log('PASS popup:',JSON.stringify(metrics));
    }
  }catch(e){console.error(e.stack||e);process.exitCode=1;}
  finally{win?.destroy();app.quit();}
}).catch(e=>{console.error(e);app.exit(1);});
