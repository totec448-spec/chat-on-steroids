// Static subprocess fixture: paths are data arguments, never generated JavaScript.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runUiCheck } from '../ui-check-process.mjs';

const script = fileURLToPath(import.meta.url);
const [role, ownerFile, readyFile, profilePath] = process.argv.slice(2);
if (role === 'grandchild') {
  process.send('ready');
  setInterval(() => {}, 1000);
} else if (role === 'parent') {
  const child = spawn(process.execPath, [script, 'grandchild'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  child.once('message', () => writeFileSync(readyFile, String(child.pid)));
  setInterval(() => {}, 1000);
} else if (role === 'runner') {
  process.on('message', action => {
    if (action === 'exit') process.exit(0);
    else if (action === 'SIGINT' || action === 'SIGTERM') process.emit(action);
  });
  runUiCheck(process.execPath, [script, 'parent', ownerFile, readyFile, profilePath], {
    env: process.env, timeoutMs: 30000,
    profile: { path: profilePath, markChild(pid) { if (pid) writeFileSync(ownerFile, String(pid)); }, cleanup() {} }
  }).then(() => process.exit(2));
} else {
  throw new Error('Unknown UI check fixture role');
}
