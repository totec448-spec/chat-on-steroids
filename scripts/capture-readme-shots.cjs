// Maintainer tool: renders the README screenshots from the production renderer with synthetic
// data only (a demo project, placeholder paths, made-up chat), so they can be redone whenever the
// app changes. Writes docs/images/{workspace,model-picker,settings}.png.
//
//   npx electron scripts/capture-readme-shots.cjs [outDir]
const fs = require('node:fs');
const path = require('node:path');
const { fixtureServer, root } = require('./fixtures/readme-fixture.cjs');
const { app, BrowserWindow } = require('electron');

const output = path.resolve(process.argv[2] || path.join(root, 'docs/images'));
app.setPath('userData', path.join(root, 'outputs/readme-shots-runtime'));

app.whenReady().then(async () => {
  const server = await fixtureServer();
  let win;
  try {
    fs.mkdirSync(output, { recursive: true });
    win = new BrowserWindow({ show: false, width: 1440, height: 940, webPreferences: { sandbox: true, backgroundThrottling: false, zoomFactor: 1 } });
    win.webContents.on('console-message', event => { if (event.level === 'error') console.error('renderer:', event.message); });
    await win.loadURL(server.resolvedUrls.local[0] + 'fixture.html');
    const js = code => win.webContents.executeJavaScript(code);
    const until = async (predicate, what) => { for (let i = 0; i < 300; i++) { if (await js(predicate)) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('timed out: ' + what); };
    const settle = () => js('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 300)))))');
    const shot = async (name, rect) => { await settle(); fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage(rect, { stayHidden: true, stayAwake: true })).toPNG()); console.log('wrote', name); };

    await until('window.ready && document.querySelector("#sessionList [data-id=\\"demo\\"]")', 'session list');
    await js('document.querySelector("#sessionList [data-id=\\"demo\\"]").click()');
    await until('document.querySelector(".said.is-user") && document.querySelector(".ev-assistant_message")', 'chat');
    // The work as a person would open it: the tool calls, the plan and the workers beside the chat.
    await js(`(() => { const group = document.querySelector('#timeline details.tool-group'); if (group) group.open = true;
      const plan = document.querySelector('.agent-plan-shell'); if (plan) plan.open = true; })()`);
    await js(`document.getElementById('rightDockToggle').click()`);
    await new Promise(r => setTimeout(r, 600));
    await js(`[...document.querySelectorAll('button, [role=button]')].find(node => node.getClientRects().length && /^Sub-agents/.test(node.textContent.trim()))?.click()`);
    await new Promise(r => setTimeout(r, 600));
    await js(`document.getElementById('chatBody').scrollTop = 0`);
    await shot('workspace.png');

    // The model picker, open above the composer.
    await js(`document.getElementById('rightDockToggle').click(); const plan = document.querySelector('.agent-plan'); if (plan) plan.hidden = true;`);
    await new Promise(r => setTimeout(r, 400));
    await js(`document.querySelector('#modelMenu > summary').click()`);
    await until('document.getElementById("modelMenu").open && document.querySelector("#modelMenu .composer-popover").getClientRects().length', 'model picker');
    await settle();
    const picker = await js(`(() => { const a = document.getElementById('composer').getBoundingClientRect(), b = document.querySelector('#modelMenu .composer-popover').getBoundingClientRect();
      const x = Math.min(a.left, b.left) - 16, y = Math.min(a.top, b.top) - 16, right = Math.max(a.right, b.right) + 16, bottom = Math.max(a.bottom, b.bottom) + 16;
      return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), width: Math.round(right - x), height: Math.round(bottom - y) }; })()`);
    await shot('model-picker.png', picker);
    await js(`document.querySelector('#modelMenu > summary').click()`);

    // Settings: the folders ChatGPT may use and what it may do there.
    await js(`document.getElementById('workspaceSettings').click()`);
    await until('document.querySelector(".app").dataset.screen === "settings"', 'settings');
    await js(`document.querySelector('[data-tab="home"]')?.click()`);
    await settle();
    // Permissions and folders; the Health box below them is live status, not a setting.
    const settingsHeight = await js(`(() => { const health = [...document.querySelectorAll('.panel.is-active h2, .panel.is-active h3')].find(node => node.textContent.trim() === 'Health');
      return health ? Math.round(health.getBoundingClientRect().top - 28) : innerHeight; })()`);
    await shot('settings.png', { x: 0, y: 0, width: 1440, height: settingsHeight });
  } finally { win?.destroy(); await server.close(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
