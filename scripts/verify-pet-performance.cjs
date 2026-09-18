// Run: node scripts/verify-pet-performance.cjs <label> [--check]
// Builds the production pet and app CSS, then measures one isolated Electron
// window. CPU percentages are normalized to all logical processors, like Task
// Manager. No production userData, bridge, browser or provider is involved.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const label = process.argv[2] || 'current';
assert.match(label, /^[a-z0-9-]+$/i);
const output = path.join(root, 'outputs/pet-performance', label);
const check = process.argv.includes('--check');

async function buildAndRun() {
  const { build } = await import('vite');
  const fixture = path.join(output, 'fixture');
  fs.mkdirSync(fixture, { recursive: true });
  const renderer = path.join(root, 'src/renderer').replaceAll('\\', '/');
  fs.writeFileSync(path.join(fixture, 'entry.ts'), `
    import '${renderer}/styles.css';
    import { initPet } from '${renderer}/pet.ts';
    localStorage.clear();
    Math.random = () => 0.5;
    const nativeRaf = window.requestAnimationFrame.bind(window);
    window.petRafs = 0;
    window.requestAnimationFrame = callback => nativeRaf(now => { window.petRafs++; callback(now); });
    window.disposePet = initPet();
  `);
  fs.writeFileSync(path.join(fixture, 'index.html'), `<!doctype html><html lang="en"><head>
    <meta charset="utf-8"><title>CoS Pet CPU Verification</title></head>
    <body><div class="app"><aside class="sidebar">Chat On Steroids</aside>
    <main><h1>Pet rendering verification</h1><p>Production artwork, animation and CSS.</p>
    <form class="composer" style="position:fixed;bottom:16px;left:240px;right:16px">
    <textarea rows="1" placeholder="Ask anything"></textarea><div class="composer-toolbar">
    <div class="composer-options"></div></div></form></main></div>
    <script type="module" src="./entry.ts"></script></body></html>`);
  await build({ configFile: false, root: fixture, base: './', logLevel: 'warn',
    build: { outDir: path.join(output, 'site'), emptyOutDir: true } });
  const sources = ['pet.ts', 'pet.css', 'pet-machine.ts', 'pet-choreography.ts'];
  for (const source of sources) fs.copyFileSync(path.join(root, 'src/renderer', source), path.join(output, source));
  const { spawn } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, label, ...(check ? ['--check'] : [])],
    { cwd: root, env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}

async function measure() {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(output, 'runtime'));
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1100, height: 850,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', event => {
    if (event.level === 'error') errors.push(event.message);
  });
  win.webContents.on('render-process-gone', (_event, details) => errors.push(details.reason));
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code);
  const wait = async (condition, timeout = 12000) => {
    const end = Date.now() + timeout;
    while (!await js(condition)) { assert.ok(Date.now() < end, condition); await delay(40); }
  };
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  try {
    await win.loadFile(path.join(output, 'site/index.html'));
    win.webContents.setZoomFactor(1.17); win.showInactive();
    await wait('!!document.getElementById("petLauncher")'); await delay(700);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Performance.enable');
    const perf = async () => Object.fromEntries((await win.webContents.debugger.sendCommand('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const records = [];
    const sample = async (name, milliseconds) => {
      const before = await perf(), rafBefore = await js('window.petRafs');
      const processes = new Map(app.getAppMetrics().map(m => [m.pid, m.cpu.cumulativeCPUUsage]));
      const started = performance.now(); await delay(milliseconds);
      const seconds = (performance.now() - started) / 1000;
      const cpu = app.getAppMetrics().filter(m => processes.has(m.pid)).map(m => ({
        type: m.type, pid: m.pid,
        seconds: m.cpu.cumulativeCPUUsage - processes.get(m.pid)
      }));
      assert.ok(cpu.every(m => Number.isFinite(m.seconds)), 'Cumulative process CPU time is available');
      // Some Chromium process counters can reset during startup. Keep the raw
      // evidence, but never turn a negative delta or replaced process into a CPU
      // saving. Other phases and the frame/style counters remain independent.
      const cpuSampleValid=cpu.length===processes.size && cpu.every(m=>m.seconds>=0);
      const after = await perf();
      const result = { name, seconds, cpuSampleValid,
        cpuPercent: cpuSampleValid?cpu.reduce((sum, m) => sum + m.seconds, 0) / seconds / os.cpus().length * 100:null,
        rafPerSecond: (await js('window.petRafs') - rafBefore) / seconds,
        taskMsPerSecond: (after.TaskDuration - before.TaskDuration) * 1000 / seconds,
        styleRecalculationsPerSecond: (after.RecalcStyleCount - before.RecalcStyleCount) / seconds,
        layoutsPerSecond: (after.LayoutCount - before.LayoutCount) / seconds, cpu };
      records.push(result); console.log(JSON.stringify(result)); return result;
    };
    await sample('hidden', 5000);
    await click('#petLauncher'); await wait('!document.getElementById("petLayer").hidden');
    await wait('document.getElementById("petActor").dataset.state === "idle"');
    await sample('idle', 2200);
    await sample('autonomous', 16000);
    await js(`document.getElementById('petActor').dispatchEvent(new MouseEvent('contextmenu', {clientX:500,clientY:400,bubbles:true}));`);
    await delay(150); await sample('menu-paused', 5000);
    await click('.pet-menu button:nth-child(3)');
    await sample('openai', 8500); await wait('!document.getElementById("petLayer").dataset.action');
    await click('.pet-menu button:nth-child(4)');
    await sample('anthropic', 8500); await wait('!document.getElementById("petLayer").dataset.action');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await delay(150); await sample('reduced-motion', 2000);
    await click('#petLauncher'); await sample('hidden-again', 2000);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    await click('#petLauncher'); await delay(650);
    fs.writeFileSync(path.join(output, 'pet.png'), (await win.webContents.capturePage()).toPNG());
    const result = { label, electron: process.versions.electron, chrome: process.versions.chrome,
      processors: os.cpus().length, gpu: app.getGPUFeatureStatus(), records, errors };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    assert.deepEqual(errors, []);
    if (check) {
      assert.ok(records.find(r => r.name === 'idle').rafPerSecond < 12, 'Idle clock should follow sprite deadlines');
      assert.ok(records.find(r => r.name === 'idle').styleRecalculationsPerSecond < 12, 'Idle must not restyle at display refresh rate');
      for (const name of ['hidden', 'menu-paused', 'reduced-motion', 'hidden-again']) {
        assert.equal(records.find(r => r.name === name).rafPerSecond, 0, name + ' has no running animation clock');
      }
    }
  } finally { win.destroy(); app.quit(); }
}

if (process.versions.electron) measure().catch(error => { console.error(error); require('electron').app.exit(1); });
else buildAndRun().catch(error => { console.error(error); process.exitCode = 1; });
