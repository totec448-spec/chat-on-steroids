// Real Chromium, production Usage renderer and CSS; isolated data, no provider or app backend.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/usage-weekly');
app.setPath('userData', path.join(output, 'runtime'));

app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    localStorage.setItem('cos.usage.weekStart', '6');
    localStorage.setItem('cos.ui.language', 'en');
    const model = {model:'gpt-5.6-sol',reasoningEffort:'high',assumed:false,tokens:1000000};
    const data = {contextTokenCap:400000, tokens:10000000,
      days:Array.from({length:10},(_,i)=>({date:'2026-09-'+String(12+i).padStart(2,'0'),tokens:1000000,models:[model]})),
      models:[{...model,tokens:10000000}], sessions:3,
      limits:[{model:'deep_research',scope:'feature',remaining:250,remainingPercent:null,resetAt:null,windowSeconds:null,observedAt:Date.now()},
        {model:'image_gen',scope:'feature',remaining:1000,remainingPercent:null,resetAt:null,windowSeconds:null,observedAt:Date.now()}],
      messages:{through:new Date(2026,8,21,12).getTime(),days:[
        {date:'2026-09-19',gpt56:24,gpt6:12}, {date:'2026-09-20',gpt56:10,gpt6:3}, {date:'2026-09-21',gpt56:1,gpt6:1}
      ]}};
    window.api = {getUsage:async()=>({ok:true,data}),getChatModels:async()=>({ok:true,data:{models:[]}})};
    const language = await import('/i18n.ts'); language.initLanguage(); window.setFixtureLanguage=language.setLanguage;
    const usage = await import('/usage.ts'); usage.initUsage(); await usage.refreshUsage();
    const panel = document.querySelector('[data-panel="usage"]'); panel.classList.add('is-active');
    document.body.replaceChildren(panel); panel.style.height='100vh';
    document.documentElement.dataset.theme='dark';
    window.fixtureReady=true;
  `;
  const server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'),
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'usage-week-fixture', configureServer(vite) {
      vite.middlewares.use('/fixture.html', async (_request, response) => {
        const source = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace('</body>', '<script type="module">' + fixture + '</script></body>');
        response.setHeader('Content-Type', 'text/html'); response.end(await vite.transformIndexHtml('/fixture.html', source));
      });
    } }] });
  let win;
  try {
    fs.mkdirSync(output, { recursive: true }); await server.listen();
    win = new BrowserWindow({ show: false, width: 1040, height: 850, webPreferences: { sandbox: true, backgroundThrottling: false } });
    const js = source => win.webContents.executeJavaScript(source);
    await win.loadURL(server.resolvedUrls.local[0] + 'fixture.html');
    for (let i = 0; i < 100 && !await js('!!window.fixtureReady'); i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(await js('!!window.fixtureReady'), true, 'Fixture loads the production Usage module');
    assert.deepEqual(await js(`[document.getElementById('usageMessages56').textContent,document.getElementById('usageMessages6').textContent]`), ['35', '16']);
    assert.equal(await js(`document.querySelector('.settings-heading').nextElementSibling.id`), 'usageSummary', 'Usage opens directly with the summary');
    assert.equal(await js(`document.querySelector('.usage-panel').lastElementChild.contains(document.getElementById('usageMessageCounts'))`), true, 'Message counts belong to the bottom section');
    assert.equal(await js(`document.getElementById('usageStatus').getBoundingClientRect().height`), 0, 'Successful loading leaves no status gap');
    const capture = async (name, bottom = true) => {
      await js(bottom ? `document.querySelector('.usage-messages').scrollIntoView({block:'end'})` : `document.querySelector('.usage-panel').scrollTop=0`);
      const bounds = await js(`(() => {
        const section=document.querySelector('.usage-messages'), button=document.getElementById('usageWeekStart');
        const a=section.getBoundingClientRect(), b=button.getBoundingClientRect(), rows=document.getElementById('usageMessageCounts').getBoundingClientRect();
        return {fits:section.scrollWidth<=section.clientWidth, buttonInside:b.left>=a.left-1&&b.right<=a.right+1,
          buttonHeight:b.height, buttonAboveRows:b.bottom<=rows.top+1,
          width:innerWidth, section:[a.left,a.right], button:[b.left,b.right]};
      })()`);
      await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      await new Promise(resolve => setTimeout(resolve, 100));
      fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
      console.log(name, bounds);
      assert.equal(bounds.fits, true, name + ': no horizontal overflow');
      assert.equal(bounds.buttonInside, true, name + ': weekday button remains inside its section');
      assert.ok(bounds.buttonHeight >= 42, name + ': weekday button has a usable hit target');
      assert.equal(bounds.buttonAboveRows, true, name + ': weekday control sits above the model rows');
    };
    await capture('wide-dark-top', false);
    await capture('wide-dark');
    await js(`document.getElementById('usageWeekStart').focus()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    assert.equal(await js(`document.getElementById('usageMessages6').textContent`), '4', 'Native keyboard activation selects Sunday');
    assert.equal(await js(`localStorage.getItem('cos.usage.weekStart')`), '0');
    win.setSize(560, 850); win.webContents.setZoomFactor(1.25);
    await js(`window.setFixtureLanguage('ja'); document.documentElement.dataset.theme='light'`);
    await capture('narrow-japanese-light');
    console.log('Usage week: bottom placement, compact rows, exact counts, native keyboard, persistence and two layouts passed.');
  } finally { win?.destroy(); await server.close(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
