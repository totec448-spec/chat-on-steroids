// Isolated Chromium layout check of the actual Skills markup, styles and renderer module.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/skills-ui');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cos-skills-ui-')));

app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    const ok = data => Promise.resolve({ok:true,data});
    let skills = [
      {id:'review',name:'Code Review',description:'Read the complete change, verify behavior and explain the result.',path:'/skills/review/SKILL.md',origin:{kind:'github',url:'https://github.com/example/skills/tree/main/review',ref:'main',directory:'review',commit:'a'.repeat(40),revision:'b'.repeat(64),skillSha256:'c'.repeat(64)}},
      {id:'design-check',name:'Design Check',description:'Inspect hierarchy, alignment, contrast and interaction states before shipping.',path:'/skills/design-check/SKILL.md',origin:{kind:'github',url:'https://github.com/example/skills/tree/main/design-check',ref:'main',directory:'design-check',commit:'a'.repeat(40),revision:'d'.repeat(64),skillSha256:'e'.repeat(64)}},
      {id:'handoff',name:'Clear Handoff',description:'Summarize completed work, evidence and the next safe step.',path:'/skills/handoff/SKILL.md',origin:null}
    ];
    window.api = {
      listManagedSkills:()=>ok(skills),
      skillsImport:()=>ok(skills),
      skillsImportGithub:()=>ok(skills),
      skillsLinkGithub:()=>ok(skills),
      skillsCheckGithub:()=>ok([
        {id:'review',originRevision:'b'.repeat(64),state:'available',checkedAt:Date.now()},
        {id:'design-check',originRevision:'d'.repeat(64),state:'current',checkedAt:Date.now()}
      ]),
      skillsUpdateGithub:()=>ok({status:'current',skills}),
      skillsRemove:id=>{skills=skills.filter(skill=>skill.id!==id);return ok(skills)}
    };
    document.querySelector('.app').dataset.screen='library';
    document.querySelectorAll('.panel').forEach(panel=>panel.classList.toggle('is-active',panel.dataset.panel==='skills'));
    document.querySelector('#sidebarSkills').classList.add('is-sel');
    const {initSkillsLibrary}=await import('/skills-library.ts');
    initSkillsLibrary(window.api)();
    window.fixtureReady=true;
  `;
  const server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'),
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'skills-fixture', configureServer(vite) {
      vite.middlewares.use('/fixture.html', async (_request, response) => {
        const source = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace('</head>', '<link rel="stylesheet" href="/icons.css" /></head>')
          .replace('</body>', `<script type="module">${fixture}</script></body>`);
        response.setHeader('Content-Type', 'text/html');
        response.end(await vite.transformIndexHtml('/fixture.html', source));
      });
    }}] });
  let win;
  try {
    await server.listen(); fs.mkdirSync(output, { recursive: true });
    win = new BrowserWindow({ show: false, width: 1100, height: 800,
      webPreferences: { sandbox: true, backgroundThrottling: false } });
    await win.loadURL(server.resolvedUrls.local[0] + 'fixture.html');
    const js = code => win.webContents.executeJavaScript(code);
    for (let i = 0; i < 100 && !(await js('!!window.fixtureReady && document.querySelectorAll(".skill-library-card").length === 3 && document.querySelector(".skill-library-source.is-available")')); i++)
      await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(await js('document.querySelectorAll(".skill-library-card").length'), 3);
    assert.equal(await js('document.querySelectorAll(".skill-library-source.is-available").length'), 1);
    assert.equal(await js('document.querySelectorAll(".skill-library-source.is-local").length'), 1);
    const entrance = await js(`(() => { const style = getComputedStyle(document.querySelector('[data-panel="skills"]'));
      return { name: style.animationName, duration: style.animationDuration, timing: style.animationTimingFunction }; })()`);
    assert.deepEqual(entrance, { name: 'surface-in', duration: '0.16s', timing: 'ease-out' });
    for (const [width, height, name] of [[1100, 800, 'desktop.png'], [850, 700, 'compact.png']]) {
      win.setSize(width, height);
      await new Promise(resolve => setTimeout(resolve, 150));
      const layout = await js(`(() => {const panel=document.querySelector('[data-panel="skills"]');const cards=[...document.querySelectorAll('.skill-library-card')].map(card=>card.getBoundingClientRect());return {panel:panel.getBoundingClientRect().toJSON(),cards:cards.map(box=>box.toJSON()),overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth}})()`);
      assert.equal(layout.overflow, false);
      assert.ok(layout.cards.every(box => box.width > 200 && box.height > 100));
      fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
      console.log(JSON.stringify({ name, layout }));
    }
    await js(`document.querySelector('.skill-import-menu').open=true`);
    const menu = await js(`(() => {const box=document.querySelector('.skill-import-menu .plugin-menu-actions').getBoundingClientRect();const panel=document.querySelector('[data-panel="skills"]').getBoundingClientRect();return {box:box.toJSON(),panel:panel.toJSON()}})()`);
    assert.ok(menu.box.left >= menu.panel.left && menu.box.right <= menu.panel.right);
    fs.writeFileSync(path.join(output, 'import-menu.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    await js(`document.querySelector('#skillsImportGithub').click()`);
    assert.equal(await js(`document.querySelector('#skillGithubDialog').open`), true);
    await new Promise(resolve => setTimeout(resolve, 150));
    fs.writeFileSync(path.join(output, 'github-import.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    await js(`document.querySelector('#skillGithubDialog').close(); document.querySelector('.skill-import-menu').open=false; document.querySelector('[data-skill-id="handoff"] .plugin-menu-actions button').click()`);
    assert.equal(await js(`document.querySelector('#skillGithubTitle').textContent.includes('Link Clear Handoff')`), true);
    await new Promise(resolve => setTimeout(resolve, 150));
    fs.writeFileSync(path.join(output, 'github-link.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    await js(`document.querySelector('#skillGithubDialog').close(); document.querySelector('.skill-import-menu').open=false; document.querySelector('.skill-library-card .plugin-menu').open=true; document.querySelector('.skill-library-card .plugin-menu-actions button').click()`);
    assert.equal(await js(`document.querySelector('#skillUpdateDialog').open`), true);
    await new Promise(resolve => setTimeout(resolve, 150));
    fs.writeFileSync(path.join(output, 'github-update.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  } finally {
    win?.destroy(); await server.close(); app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
