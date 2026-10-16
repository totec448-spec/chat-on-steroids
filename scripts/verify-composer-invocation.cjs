// Production renderer interaction proof for inline Skills and local-project file references.
// Uses synthetic project data and the isolated IPC fixture; no account or user files.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.tmp', 'composer-invocation');
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require('./fixtures/app-defaults.cjs');
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const injected = `(() => {
  const old = window.api;
  const ok = data => Promise.resolve({ ok: true, data: structuredClone(data) });
  const project = { id: 'sample-project', name: 'Sample project', path: '/home/you/project', createdAt: 1 };
  window.composerFixture.summary.projectId = project.id;
  window.api = new Proxy({
    listProjects: () => ok([project]),
    markWhatsNewSeen: () => ok(true),
    listProjectFiles: (projectId, directory) => ok({
      projectId, projectName: project.name, directory, truncated: false,
      entries: directory
        ? [{ name: 'main.ts', path: directory + '/main.ts', kind: 'file', bytes: 120 }]
        : [
          { name: 'src', path: 'src', kind: 'directory', bytes: null },
          { name: 'README.md', path: 'README.md', kind: 'file', bytes: 80 }
        ]
    })
  }, { get: (target, key) => key in target ? target[key] : old[key] });
})();`;

let server, win;
const js = source => win.webContents.executeJavaScript(source);
const until = async (source, timeout = 5000) => {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (await js(source)) return;
    await pause(50);
  }
  throw new Error(`Timed out: ${source}`);
};
const capture = async name => {
  win.webContents.invalidate();
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await pause(700);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG());
};
const typeAt = async (text, position) => js(`(() => {
  const input = document.getElementById('chatInput');
  input.value = ${JSON.stringify(text)};
  input.focus();
  input.setSelectionRange(${position}, ${position});
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);

app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile: false, root: path.join(root, 'src', 'renderer'),
    cacheDir: path.join(output, 'vite'), logLevel: 'error',
    resolve: { alias: { '@phosphor-icons/web': path.join(root, 'node_modules', '@phosphor-icons/web', 'src') } },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
    plugins: [{ name: 'composer-invocation-fixture', transformIndexHtml(html) {
      return html.replace('</head>', '<script src="/composer-invocation-fixture.js"></script></head>');
    }, configureServer(vite) { vite.middlewares.use((req, res, next) => {
      if (req.url !== '/composer-invocation-fixture.js') return next();
      res.setHeader('Content-Type', 'text/javascript');
      res.end(fixtureConfigSource() + fs.readFileSync(path.join(root, 'scripts', 'fixtures', 'composer-ui.js'), 'utf8') + injected);
    }); } }]
  });
  await server.listen();
  win = new BrowserWindow({ show: true, width: 1440, height: 960,
    webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error' && !BENIGN_RENDERER_ERRORS.includes(event.message)) errors.push(event.message); });
  await win.loadURL(server.resolvedUrls.local[0]);
  win.webContents.setZoomFactor(1);
  await until(`!!document.querySelector('#sessionList [data-id="composer-preview"]')`);
  await js(`document.querySelector('#sessionList [data-id="composer-preview"]').click()`);
  await until(`!document.getElementById('chatInput').disabled`);

  const slash = 'Please use /rev while checking this project.';
  await typeAt(slash, 'Please use /rev'.length);
  await until(`!!document.querySelector('#skillPicker [data-skill-id="code-review"]')`);
  await js(`document.getElementById('skillPicker').hidden = true`);
  assert.equal(await js(`document.getElementById('chatInput').value`), slash);
  await capture('before.png');
  await typeAt(slash, 'Please use /rev'.length);
  await until(`!!document.querySelector('#skillPicker [data-skill-id="code-review"]')`);
  assert.equal(await js(`!document.getElementById('skillPicker').hidden`), true);
  assert.equal(await js(`document.getElementById('chatInput').value`), slash);
  await capture('slash-picker.png');
  await js(`document.querySelector('#skillPicker [data-skill-id="code-review"]').click()`);
  await until(`document.getElementById('chatInput').value === 'Please use code-review while checking this project.'`);
  assert.equal(await js(`document.querySelector('#composerSelectedSkills [data-skill-id="code-review"]') !== null`), true);
  await js(`document.querySelector('#composerSelectedSkills .composer-selected-skill-remove').click()`);
  await until(`!document.querySelector('#composerSelectedSkills [data-skill-id="code-review"]')`);

  const mention = 'Please inspect @src in this project.';
  await typeAt(mention, 'Please inspect @src'.length);
  await until(`!!document.querySelector('#skillPicker [data-file-path="src"]')`);
  assert.equal(await js(`!document.getElementById('skillPicker').hidden`), true);
  assert.equal(await js(`document.getElementById('chatInput').value`), mention);
  await capture('file-picker.png');
  await js(`document.querySelector('#skillPicker [data-file-path="src"]').click()`);
  await until(`!!document.querySelector('#skillPicker [data-file-path="src/main.ts"]')`);
  await js(`document.querySelector('#skillPicker [data-file-path="src/main.ts"]').click()`);
  await until(`document.getElementById('chatInput').value === 'Please inspect @src/main.ts in this project.'`);
  assert.deepEqual(errors, []);
  console.log('PASS: inline Skill and local-project file pickers preserve surrounding composer text');
  win.destroy(); await server.close(); app.exit(0);
}).catch(async error => {
  if (win && !win.isDestroyed()) {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  }
  console.error(error);
  await server?.close(); app.exit(1);
});
