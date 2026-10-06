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
// CI runners have no real GPU and slower timers, so checks that compare pixels or watch an animation
// fail there although they pass on a real machine. CI names them here; they still run locally.
const skip = new Set((process.env.VERIFY_UI_SKIP ?? '').split(',').map(name => name.trim()).filter(Boolean));
const TIMEOUT_MS = 6 * 60_000;

// How each check has to be started, where that differs from `electron <script>`.
const special = {
  'verify-shell-runtime.cjs': { command: process.execPath, args: [] },
  'verify-pet-performance.cjs': { command: process.execPath, args: ['current', '--check'] }
};

const scripts = readdirSync(path.join(root, 'scripts'))
  .filter(name => /^verify-.*\.cjs$/.test(name) && name.includes(filter)).sort();
// CI runners are shared and uneven: a different check timed out on each run while all of them
// passed on a real machine. With VERIFY_UI_RETRY a failed check runs once more; a pass on retry
// counts, and is named as a flake (a GitHub warning in CI) so it stays visible.
const retries = Number(process.env.VERIFY_UI_RETRY) || 0;
const flaky = [];
const results = [];
// macOS runners print Electron Helper XPC/sandbox complaints on every check. They are never the
// reason, and as the last lines of a silent failure they used to hide it completely.
const noise = /sandbox_extension|task_policy|js2c|XPC error|com\.apple\.|Connection invalid/;
// A check's own result line is JSON whose keys can read like a reason ("actualPty"); it is never one.
const resultLine = /^\s*[{[]/;
// Windows reports a crash as an NTSTATUS such as 3221225477; in hex (0xC0000005) it can be looked up.
const exitStatus = code => code === 'timeout' ? 'timed out'
  : typeof code === 'number' ? `exited with ${code}${code > 0xffff ? ` (0x${(code >>> 0).toString(16).toUpperCase()})` : ''}` : String(code);
const reasonFor = outcome => {
  const lines = outcome.output.split('\n').filter(line => line.trim() && !noise.test(line));
  const reason = lines.filter(line => !resultLine.test(line) && /Error|assert|Timeout|timed out|expected|actual/i.test(line)).slice(0, 6);
  const shown = reason.length ? reason : lines.slice(-8);
  // A check that printed its full result and still failed died on the way out; only the status says so.
  return [...shown, shown.length ? exitStatus(outcome.code) : `${exitStatus(outcome.code)} and no output`]
    .map(line => `      ${line.slice(0, 800)}`).join('\n');
};
for (const name of scripts) {
  if (skip.has(name)) { console.log(`SKIP  ${name}  (needs a real GPU and display timing; run it locally)`); continue; }
  // The app starts in the system language on a first start. Checks assert English text, so pin the
  // locale; otherwise they fail on any machine whose system language the app also speaks.
  const how = special[name] ?? { command: electron, args: ['--lang=en-US'] };
  const started = Date.now();
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const run = () => new Promise(resolve => {
    const child = spawn(how.command, [path.join('scripts', name), ...how.args], { cwd: root, env, windowsHide: true });
    let output = '';
    // A check that throws inside its async body and then quits in a finally block exits 0: its
    // failure only shows as an unhandled rejection. Two checks passed that way for weeks (#1144).
    let unhandled = false;
    const keep = chunk => { unhandled ||= /UnhandledPromiseRejection/.test(String(chunk)); output = (output + chunk).slice(-4000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: 'timeout', output }); }, TIMEOUT_MS);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: code === 0 && unhandled ? 'unhandled rejection' : code ?? `signal ${signal}`, output }); });
  });
  let outcome = await run();
  const first = outcome;
  for (let attempt = 0; outcome.code !== 0 && attempt < retries; attempt++) {
    const retried = await run();
    if (retried.code === 0) { flaky.push(name); outcome = retried; }
  }
  const ok = outcome.code === 0;
  results.push({ name, ok, seconds: Math.round((Date.now() - started) / 1000) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${results.at(-1).seconds}s)${flaky.includes(name) ? '  (failed once, passed on retry)' : ''}`);
  if (flaky.includes(name) && process.env.GITHUB_ACTIONS) console.log(`::warning title=Flaky UI check::${name} failed once and passed on retry`);
  // A retry that passes still keeps why the first run failed: that is the only evidence of a flake.
  if (!ok || flaky.includes(name)) console.log(reasonFor(ok ? first : outcome));
}
const failed = results.filter(result => !result.ok);
console.log(`\n${results.length - failed.length} of ${results.length} UI checks passed${skip.size ? `, ${[...skip].filter(name => scripts.includes(name)).length} skipped` : ''}.`);
process.exit(failed.length ? 1 : 0);
