// Drives a real cos-app end to end on an isolated profile and prints one line per check.
// Every action goes through tools/drive.ps1, which touches only windows owned by the app's pid.
// usage (from the repository root): node rust/crates/cos-app/tools/verify.mjs [--exe <cos-app.exe>]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tools = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(tools, '../../../..');
const argv = process.argv.slice(2);
const exe = path.resolve(argv.includes('--exe') ? argv[argv.indexOf('--exe') + 1] : 'rust/target/release/cos-app.exe');
const out = path.join(repo, '.tmp', 'cos-app-verify');
fs.rmSync(out, { recursive: true, force: true });
const profile = path.join(out, 'profile');
const project = path.join(out, 'project');
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'README.md'), '# Fixture project\n');
const urls = path.join(out, 'mcp-urls.json');
const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const config = (ui = {}) => fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
  roots: [{ name: 'project', path: project }],
  capabilities: { browse: true, search: true, read: true, metadata: true, create: false, edit: false, move: false,
    deleteFile: false, command: false, screen: false, control: false, clipboardRead: false, clipboardWrite: false },
  readOnly: false,
  tunnel: { kind: 'manual', tunnelId: '', desktopTunnelId: '', pluginsTunnelId: '', binaryPath: '' },
  ui: { minimizeToTray: true, autoConnect: true, language: 'en', lastSeenVersion: version, turnNotifications: false,
    keepAwake: false, startAtLogin: false, localAppUsage: false, autoRefreshPlugins: false, autoRefreshPluginsAsked: true, ...ui },
  controlApi: { enabled: true, allowActions: false },
}, null, 2));
const env = { ...process.env, CLF_BRIDGE_PORTS: '0', COS_MCP_URLS_FILE: urls, COS_APP_AUTOMATION: '1',
  HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };
const skip = (name, why) => console.log(`SKIP ${name} (${why})`);

const ps = (script, args) => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(tools, script), ...args],
  { encoding: 'utf8' });
let pid = 0;
const drive = (action, extra = []) => {
  const run = ps('drive.ps1', ['-ProcId', String(pid), '-Action', action, ...extra]);
  return (run.stdout + run.stderr).trim();
};
const state = () => JSON.parse(drive('state'));
const tree = () => ps('uia.ps1', ['-ProcId', String(pid)]).stdout;
const shot = name => ps('shot.ps1', ['-ProcId', String(pid), '-Out', path.join(out, `${name}.png`)]).stdout.trim();
const until = async (probe, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await probe()) return true; await pause(100); } return false; };
const launch = (...args) => {
  const child = spawn(exe, [`--user-data-dir=${profile}`, ...args], { env, stdio: 'ignore', detached: true });
  child.unref();
  return child;
};
const second = (...args) => spawnSync(exe, [`--user-data-dir=${profile}`, ...args], { env }).status;
const visible = () => state().windows.some(w => w.class === 'Zed::Window' && w.visible);
const quit = async (label = 'Quit') => {
  second('--show-tray-menu');
  drive('menu-pick', ['-Name', label]);
  return until(() => !alive(pid), 15000);
};

config({ theme: 'dark' });
pid = launch().pid;
const configLog = () => fs.existsSync(path.join(profile, 'app.log')) && fs.readFileSync(path.join(profile, 'app.log'), 'utf8');
check('window opens', await until(visible, 15000));
check('the seeded config is accepted', !String(configLog()).includes('Settings file was invalid'));
await until(() => fs.existsSync(urls), 5000);
check('window title and tree', tree().includes('Window name="Chat On Steroids"'));
console.log(shot('1-dark-empty'));

const call = spawnSync(process.execPath, [path.join(tools, 'mcp-call.mjs'), urls, 'read', JSON.stringify({ paths: ['/project/README.md'] })], { encoding: 'utf8' });
check('a Core tool call answers', call.stdout.includes('Fixture project'));
check('the session list updates live', await until(() => /ListItem name="[^"]+"/.test(tree()), 5000));

check('tabs are reachable', drive('invoke', ['-Name', 'workspaceSettings']).startsWith('invoked') && drive('invoke', ['-Name', 'tab-appearance']).startsWith('invoked'));
check('the selected tab shows its page', await until(() => tree().includes('Group name="Appearance"'), 3000));
console.log(shot('2-settings-appearance'));
drive('invoke', ['-Name', 'backToChat']);

check('the capsule reads Connected', await until(() => tree().includes('Button name="Connected" id="sidebarConnection"'), 5000));
drive('invoke', ['-Name', 'sidebarConnection']);
check('the capsule opens the connection popover', await until(() => tree().includes('id="connectionPopoverToggle"'), 3000));
console.log(shot('3-popover'));
drive('invoke', ['-Name', 'connectionPopoverToggle']);
check('Disconnect from the popover reaches the Core', await until(() => tree().includes('Button name="Not connected" id="sidebarConnection"'), 5000));
drive('invoke', ['-Name', 'sidebarConnection']);
check('Connect from the capsule reaches the Core', await until(() => tree().includes('Button name="Connected" id="sidebarConnection"'), 5000));

drive('close');
check('close hides to the tray', await until(() => !visible(), 3000) && alive(pid));
second('--show-tray-menu');
if (await until(() => state().windows.some(w => w.class === '#32768'), 3000)) console.log(shot('5-tray-menu'));
const picked = drive('menu-pick', ['-Name', 'Open']);
check('the tray menu lists status, Open, Disconnect and Quit', picked.includes('Connected |  | Open | Disconnect |  | Quit'), picked.split('\n')[0]);
check('tray Open shows the window again', await until(visible, 3000));

drive('close');
await until(() => !visible(), 3000);
check('a second launch exits 0', second() === 0);
check('a second launch shows the hidden window', await until(visible, 3000));
check('a background second launch exits 0 and changes nothing', second('--background') === 0 && visible());

drive('normal');
await pause(300);
drive('move', ['-X', '200', '-Y', '150']);
await pause(300);
const resize = drive('resize', ['-X', '1200', '-Y', '800']);
await pause(800);
const savedFile = path.join(profile, 'state', 'window-bounds.json');
const saved = fs.existsSync(savedFile) ? JSON.parse(fs.readFileSync(savedFile, 'utf8')) : null;
check('moving and resizing saves the normal rectangle', saved?.maximized === false && saved.bounds.width < 1200, `${resize}; ${JSON.stringify(saved)}`);
const placed = state().windows[0].rect;
const f11 = drive('f11');
if (f11.startsWith('sent')) {
  const fullscreen = await until(() => state().windows[0]?.rect !== placed, 2000);
  check('F11 toggles full screen while the window is in front', fullscreen, `${f11}; ${placed} -> ${state().windows[0]?.rect}`);
  if (fullscreen) { drive('f11'); await until(() => state().windows[0]?.rect === placed, 2000); }
} else skip('F11 toggles full screen', f11);

const reached = new Set();
let tabbed = '';
for (let i = 0; i < 6; i++) {
  tabbed = drive('tab');
  if (!tabbed.startsWith('sent')) break;
  await pause(150);
  reached.add(drive('focused'));
}
if (tabbed.startsWith('sent')) {
  const names = [...reached];
  check('Tab reaches the sidebar toggle, Settings and the connection capsule', ['sidebarToggle', 'workspaceSettings', 'sidebarConnection'].every(id => names.some(n => n.includes(id))), names.join(' | '));
} else skip('Tab moves keyboard focus', tabbed);

check('tray Quit ends the process', await quit());
pid = launch().pid;
await until(visible, 15000);
const restored = state().windows[0]?.rect;
const near = (a, b) => a && b && a.split(',').every((v, i) => Math.abs(Number(v) - Number(b.split(',')[i])) <= 2);
check('the window reopens where it was left', near(placed, restored), `${placed} -> ${restored}`);
check('tray Quit ends the restarted process', await quit());

config({ theme: 'light', language: 'de' });
pid = launch('--background').pid;
await pause(2500);
check('--background starts with no window', alive(pid) && !visible());
second();
check('a launch opens the window of a background start', await until(visible, 5000));
check('German texts', tree().includes('Button name="Einstellungen"'));
console.log(shot('4-light-de'));
const german = JSON.parse(fs.readFileSync(path.join(repo, 'src', 'renderer', 'locales', 'de.json'), 'utf8'));
check('the German tray Quit ends the process', await quit(german.Quit));

console.log(`${results.filter(Boolean).length}/${results.length} checks passed; screenshots in ${out}`);
process.exit(results.every(Boolean) ? 0 : 1);
