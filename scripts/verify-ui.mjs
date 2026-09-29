// Runs every real-Electron UI check in scripts/verify-*.cjs and prints one summary.
//
// These checks render the production renderer in isolated windows and fixtures; none touches the
// installed app, its data or ChatGPT. They are not part of `npm test`, which is why they rotted
// unnoticed before. Run after `npm run build`:  npm run verify:ui [-- name-filter]
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');
const filter = process.argv[2] ?? '';
const TIMEOUT_MS = 6 * 60_000;

// How each check has to be started, where that differs from `electron <script>`.
const special = {
  'verify-shell-runtime.cjs': { command: process.execPath, args: [] },
  'verify-pet-performance.cjs': { command: process.execPath, args: ['current', '--check'] }
};

const scripts = readdirSync(path.join(root, 'scripts'))
  .filter(name => /^verify-.*\.cjs$/.test(name) && name.includes(filter)).sort();
const results = [];
for (const name of scripts) {
  const how = special[name] ?? { command: electron, args: [] };
  const started = Date.now();
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const outcome = await new Promise(resolve => {
    const child = spawn(how.command, [path.join('scripts', name), ...how.args], { cwd: root, env, windowsHide: true });
    let output = '';
    const keep = chunk => { output = (output + chunk).slice(-4000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: 'timeout', output }); }, TIMEOUT_MS);
    child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
  const ok = outcome.code === 0;
  results.push({ name, ok, seconds: Math.round((Date.now() - started) / 1000) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${results.at(-1).seconds}s)`);
  if (!ok) {
    const reason = outcome.output.split('\n').filter(line =>
      /Error|assert|Timeout|timed out|expected|actual/i.test(line) && !/sandbox_extension|task_policy|js2c/.test(line)).slice(0, 6);
    console.log((reason.length ? reason : outcome.output.split('\n').slice(-6)).map(line => `      ${line.slice(0, 240)}`).join('\n'));
  }
}
const failed = results.filter(result => !result.ok);
console.log(`\n${results.length - failed.length} of ${results.length} UI checks passed.`);
process.exit(failed.length ? 1 : 0);
