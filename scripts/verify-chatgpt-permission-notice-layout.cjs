// Isolated Electron/Chromium fixture for the production permission-notice renderer.
// It never opens ChatGPT, the installed app, or a signed-in browser profile.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/chatgpt-permission-notice');
app.setPath('userData', path.join(output, 'runtime'));

app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  const bundle = buildSync({
    entryPoints: [path.join(root, 'src/renderer/chatgpt-permission-notice.ts')],
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'permissionNotice'
  }).outputFiles[0].text;
  const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
  const approvalSvg = fs.readFileSync(path.join(root, 'src/renderer/setup-images/tool-approval-example.svg'), 'utf8');
  const approvalData = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(approvalSvg);
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replaceAll('./setup-images/tool-approval-example.svg', approvalData)
    .replace('</head>', `<style>${css}</style></head>`);
  const win = new BrowserWindow({ show: false, width: 420, height: 760,
    webPreferences: { sandbox: true, backgroundThrottling: false } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await win.webContents.executeJavaScript(`(() => {
      const ok = data => Promise.resolve({ok:true,data});
      let listener = null;
      window.fixturePush = next => listener && listener(next);
      window.api = {
        getChatgptPermissionNotice: () => ok({pending:true,revision:1}),
        acknowledgeChatgptPermissionNotice: () => ok({pending:false,revision:2}),
        onChatgptPermissionNotice: next => { listener = next; return () => { if (listener === next) listener = null; }; }
      };
      const still = document.createElement('style');
      still.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
      document.head.append(still);
    })()`);
    await win.webContents.executeJavaScript(bundle);
    await win.webContents.executeJavaScript(`permissionNotice.initChatgptPermissionNotice(window.api); true`);

    const js = code => win.webContents.executeJavaScript(code);
    await js(`Promise.all([...document.images].map(image => image.complete ? Promise.resolve() : new Promise(resolve => { image.onload=resolve; image.onerror=resolve; })))`);
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const measurements = [];
    for (const theme of ['dark', 'light']) {
      await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      const measured = await js(`(() => {
        const dialog = document.getElementById('chatgptPermissionNotice');
        const title = document.getElementById('chatgptPermissionNoticeTitle');
        const action = document.getElementById('chatgptPermissionUnderstand');
        const image = dialog.querySelector('.chatgpt-permission-example img');
        const rect = dialog.getBoundingClientRect(), button = action.getBoundingClientRect(), picture = image.getBoundingClientRect();
        return {open:dialog.open,width:rect.width,height:rect.height,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,
          viewport:[innerWidth,innerHeight],scrollWidth:dialog.scrollWidth,clientWidth:dialog.clientWidth,
          button:{left:button.left,right:button.right,bottom:button.bottom},picture:{left:picture.left,right:picture.right,width:picture.width,naturalWidth:image.naturalWidth},title:title.textContent};
      })()`);
      assert.equal(measured.open, true, JSON.stringify({ theme, measured }));
      assert.ok(measured.left >= 0 && measured.right <= measured.viewport[0], JSON.stringify({ theme, measured }));
      assert.ok(measured.top >= 0 && measured.bottom <= measured.viewport[1], JSON.stringify({ theme, measured }));
      assert.ok(measured.scrollWidth <= measured.clientWidth, JSON.stringify({ theme, measured }));
      assert.ok(measured.button.left >= measured.left && measured.button.right <= measured.right && measured.button.bottom <= measured.bottom,
        JSON.stringify({ theme, measured }));
      assert.ok(measured.picture.naturalWidth > 0 && measured.picture.left >= measured.left && measured.picture.right <= measured.right,
        JSON.stringify({ theme, measured }));
      assert.match(measured.title, /waiting for approval/i);
      measurements.push({ theme, kind: 'popup', ...measured });
      fs.writeFileSync(path.join(output, `${theme}-420-popup.png`), (await win.webContents.capturePage()).toPNG());

      const closeRevision = theme === 'dark' ? 2 : 4;
      await js(`(() => {
        window.fixturePush({pending:false,revision:${closeRevision}});
        const source=document.querySelector('[data-panel="setup"] .chatgpt-permission-setup-notice');
        const host=document.createElement('div');host.id='permissionFooterFixture';
        host.style.cssText='position:fixed;inset:0;z-index:2147483646;padding:16px;overflow:auto;background:var(--page)';
        host.append(source.cloneNode(true));document.body.append(host);
        return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`);
      const footer = await js(`(() => {
        const node=document.querySelector('#permissionFooterFixture .chatgpt-permission-setup-notice'), image=node.querySelector('img'), r=node.getBoundingClientRect(), picture=image.getBoundingClientRect();
        return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,viewport:[innerWidth,innerHeight],
          overflow:node.scrollWidth>node.clientWidth,text:node.textContent,picture:{left:picture.left,right:picture.right,width:picture.width,naturalWidth:image.naturalWidth}};
      })()`);
      assert.ok(footer.left >= 0 && footer.right <= footer.viewport[0] && footer.top >= 0 && footer.bottom <= footer.viewport[1], JSON.stringify({ theme, footer }));
      assert.equal(footer.overflow, false, JSON.stringify({ theme, footer }));
      assert.ok(footer.picture.naturalWidth > 0 && footer.picture.left >= footer.left && footer.picture.right <= footer.right, JSON.stringify({ theme, footer }));
      assert.match(footer.text, /Allow once, Always allow or Deny/);
      measurements.push({ theme, kind: 'setup-footer', ...footer });
      fs.writeFileSync(path.join(output, `${theme}-420-setup-footer.png`), (await win.webContents.capturePage()).toPNG());

      // Re-arm only inside this isolated renderer fixture for the next theme screenshot.
      await js(`document.getElementById('permissionFooterFixture').remove(); window.fixturePush({pending:true,revision:${theme === 'dark' ? 3 : 5}}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    }
    fs.writeFileSync(path.join(output, 'measurements.json'), JSON.stringify(measurements, null, 2));
    console.log(JSON.stringify({ cases: measurements.length, screenshots: 4, output }, null, 2));
  } finally {
    win.destroy(); app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
