// Static subprocess fixture: paths are data arguments, never generated JavaScript.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFunction, constants } from 'node:vm';
import { runUiCheck } from '../ui-check-process.mjs';

const script = fileURLToPath(import.meta.url);
const [role, ownerFile, readyFile, profilePath] = process.argv.slice(2);
if (role === 'grandchild') {
  process.send('ready');
  setInterval(() => {}, 1000);
} else if (role === 'parent') {
  const child = spawn(process.execPath, [script, 'grandchild'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  child.once('message', () => {
    console.log('LIVE_STDOUT'); console.error('LIVE_STDERR');
    writeFileSync(readyFile, String(child.pid));
  });
  setInterval(() => {}, 1000);
} else if (role === 'runner' || role === 'direct') {
  process.on('message', action => {
    if (action === 'exit') process.exit(0);
    else if (action === 'failure') throw new Error('Synthetic wrapper failure');
    else if (action === 'SIGINT' || action === 'SIGTERM') process.emit(action);
  });
  const profile = { path: profilePath, markChild(pid) { if (pid) writeFileSync(ownerFile, String(pid)); }, cleanup() {} };
  if (role === 'runner') {
    runUiCheck(process.execPath, [script, 'parent', ownerFile, readyFile, profilePath], {
      env: process.env, timeoutMs: 30000, profile
    }).then(() => process.exit(2));
  } else {
    // Execute the actual direct-entry source, substituting only Electron/profile fixtures.
    // Its child runs this static Node fixture, never a real app or user-data directory.
    const filename = fileURLToPath(new URL('../verify-workspace-terminal.cjs', import.meta.url));
    const require = createRequire(filename);
    const fixtureRequire = name => name === 'electron' ? process.execPath
      : name === './ui-check-profile.cjs' ? { createProfile: () => profile } : require(name);
    process.argv = [process.execPath, filename, 'parent', ownerFile, readyFile, profilePath];
    compileFunction(readFileSync(filename, 'utf8'), ['require', '__filename', '__dirname'], {
      filename, importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER
    })(fixtureRequire, script, path.dirname(filename));
  }
} else {
  throw new Error('Unknown UI check fixture role');
}
