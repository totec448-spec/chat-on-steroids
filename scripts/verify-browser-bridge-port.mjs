/** Development smoke: real Electron renderer/IPC and an isolated production MV3 companion. */
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import electron from 'electron';

if (!process.env.COS_TEST_CHROMIUM) throw new Error('Set COS_TEST_CHROMIUM to a Chromium binary that supports --load-extension.');
const run = path.resolve('outputs/browser-bridge-port', randomUUID());
await fs.mkdir(run, { recursive: true });
const fixture = path.join(run, 'fixture.cjs');
await build({ entryPoints: ['scripts/fixtures/browser-bridge-port.ts'], bundle: true, platform: 'node',
  format: 'cjs', packages: 'external', outfile: fixture });
const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete childEnv[key];
const child = spawn(electron, [fixture, run], { windowsHide: true, stdio: 'inherit', env: childEnv });
process.exitCode = await new Promise(resolve => { child.on('error', error => { console.error(error); resolve(1); }); child.on('exit', code => resolve(code ?? 1)); });
