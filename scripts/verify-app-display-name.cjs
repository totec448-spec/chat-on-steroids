// Node owns acceptance: Electron exiting zero is not proof of completed captures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const filenames = ['before.png', 'after.png', 'result.json'];
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function validateProof(directory) {
  // Check the entire triplet before reading any content or accepting a result.
  for (const file of filenames) {
    const full = path.join(directory, file);
    assert.ok(fs.existsSync(full), `Missing proof: ${file}`);
    assert.ok(fs.statSync(full).isFile(), `Not a proof file: ${file}`);
  }
  const images = filenames.slice(0, 2).map(file => {
    const bytes = fs.readFileSync(path.join(directory, file));
    assert.ok(bytes.length > pngSignature.length, `Empty or invalid PNG: ${file}`);
    assert.ok(bytes.subarray(0, pngSignature.length).equals(pngSignature), `Invalid PNG: ${file}`);
    return bytes;
  });
  assert.ok(!images[0].equals(images[1]), 'Before and after PNGs are identical');
  const proof = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'));
  assert.equal(proof.length, 2, 'Both display states are required');
  for (const [index, expected] of ['Chat On Steroids', 'Chat On Steroids (dev)'].entries()) {
    const state = proof[index];
    assert.equal(state.legacy, index === 0);
    for (const field of ['nativeTitle', 'rendererTitle', 'header']) assert.equal(state[field], expected, field);
    assert.deepEqual(state.errors, []);
  }
  return filenames.map(file => ({ file: path.join(directory, file), bytes: fs.statSync(path.join(directory, file)).size }));
}

function renderWithElectron(directory) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [path.join(__dirname, 'fixtures/app-display-name-runtime.cjs'),
    directory, '--lang=en-US', ...process.argv.slice(2)], {
    cwd: root, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Electron capture failed: ${result.signal ?? result.status}`);
}

function runDisplayNameCheck({ output = path.join(root, 'outputs/app-display-name'), render = renderWithElectron,
  log = console.log } = {}) {
  fs.mkdirSync(output, { recursive: true });
  // Never accept stale captures left by an earlier run, even if Electron exits zero.
  const directory = fs.mkdtempSync(path.join(output, 'run-'));
  render(directory);
  validateProof(directory);
  for (const file of filenames) fs.copyFileSync(path.join(directory, file), path.join(output, file));
  const artifacts = validateProof(output);
  log(JSON.stringify({ artifacts }));
  log('PASS app-display-name: both states and all three artifacts verified');
  return artifacts;
}

if (require.main === module) {
  // Loads out/renderer/index.html and the built preload; retain the runner's build freshness gate.
  import('./ui-build-state.mjs').then(({ buildProblem }) => {
    const problem = buildProblem(root);
    assert.equal(problem, null, problem);
    runDisplayNameCheck();
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { validateProof, runDisplayNameCheck };
