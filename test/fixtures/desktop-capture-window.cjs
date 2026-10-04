// Owned, inert native windows for the serial Desktop acceptance tests. No provider/backend.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.setPath('userData', process.env.COS_DESKTOP_FIXTURE_DIR);
const windows = [];
app.on('window-all-closed', () => app.quit());
// Electron's GUI executable does not guarantee a readable stdin pipe on Windows.
// A sentinel in this fixture's private temporary directory owns graceful shutdown.
const shutdown = setInterval(() => {
  if (fs.existsSync(path.join(process.env.COS_DESKTOP_FIXTURE_DIR, 'close'))) app.quit();
}, 100);
app.on('will-quit', () => clearInterval(shutdown));
app.whenReady().then(async () => {
  app.setAccessibilitySupportEnabled(true);
  for (let index = 0; index < 2; index++) {
    const window = new BrowserWindow({
      show: false, frame: false, width: 400 + index * 3, height: 260 + index * 3, x: 80 + index * 220, y: 80 + index * 80,
      skipTaskbar: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false }
    });
    windows.push(window);
    const painted = new Promise(resolve => window.once('ready-to-show', resolve));
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<!doctype html><html><head><title>CoS owned desktop fixture ' + index + '</title></head>' +
      '<body style="margin:0;height:100vh;overflow:hidden"><h1 style="padding-top:60px">Desktop test fixture</h1><button>Fixture action</button>' +
      '<button aria-label="Fixture origin red" style="position:absolute;left:8px;top:8px;width:32px;height:32px;border:0;padding:0;background:rgb(240,30,50)"></button>' +
      '<button aria-label="Fixture corner green" style="position:absolute;right:8px;bottom:8px;width:32px;height:32px;border:0;padding:0;background:rgb(20,180,70)"></button>' +
      '<label>Fixture text <input value="Synthetic content only"></label></body></html>'
    ));
    await painted;
    window.showInactive();
  }
  const ids = windows.map(window => {
    const bytes = window.getNativeWindowHandle();
    return bytes.length >= 8 ? Number(bytes.readBigUInt64LE()) : bytes.readUInt32LE();
  });
  process.stdout.write('COS_DESKTOP_FIXTURE:' + JSON.stringify(ids) + '\n');
}).catch(error => { process.stderr.write(String(error)); app.exit(1); });
