// Differential test: cos-secrets against the real src/main/secrets.ts in headless Electron.
//   node rust/crates/cos-secrets/differential/roundtrip.mjs [workDir]
// Needs `npm ci` (with the Electron binary) at the repository root, then
//   cargo build -p cos-secrets --example secrets_ops     (from rust/)
// Each scenario seeds one throwaway profile under workDir, copies it for each side, runs the same
// operations through both stores, and requires the same results, the same secrets* files, the
// same plaintext in secrets.bin as Electron decrypts it, and the same Local State files.
// Values are dummies.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const work = path.resolve(process.argv[2] ?? path.join(repo, '.tmp/cos-secrets-differential'));
const electron = process.env.COS_ELECTRON ?? path.join(repo, 'node_modules/electron/dist/electron.exe');
const oracle = path.join(here, 'electron-oracle.cjs');
const rust = path.join(repo, 'rust/target/debug/examples/secrets_ops.exe');
const bundle = path.join(work, 'secrets.cjs');

const NOW = 1_760_918_399_999;
const SET_ASIDE = 'secrets.unreadable-20251019-235959-999.bin';
const electronMap = {
  openaiApiKey: 'sk-dummy-openai-0000',
  bridgeToken: 'dummy-bridge-token-é✓-"quoted"-\\back\\slash',
  futureKey: 'kept by a build that does not know it',
  openRouterApiKey: 'sk-or-v1-dummy-­1111',
  customProviderApiKey: 'dummy-custom-\u0001-ctrl-\n-newline-😀',
  'plugin:dummy-plugin:access_token': 'dummy-plugin-token',
  'setup:dummy-setup': ' sk-dummy-setup-2222 '
};
const KEYS = ['openaiApiKey', 'bridgeToken', 'openRouterApiKey', 'customProviderApiKey', 'plugin:dummy-plugin:access_token', 'setup:dummy-setup'];
const getAll = KEYS.map(key => ({ op: 'get', key }));

let opsCounter = 0;
const writeOps = ops => {
  const file = path.join(work, `ops-${opsCounter++}.json`);
  fs.writeFileSync(file, JSON.stringify(ops));
  return file;
};
const runTs = (dir, ops) => JSON.parse(execFileSync(electron, [oracle, bundle, dir, writeOps(ops)], { encoding: 'utf8' }).trim());
const runRust = (dir, ops) => JSON.parse(execFileSync(rust, [dir, writeOps(ops)], { encoding: 'utf8' }).trim());
const secretFiles = dir => fs.readdirSync(dir).filter(name => name.startsWith('secrets')).sort();
const localStateKey = dir => JSON.parse(fs.readFileSync(path.join(dir, 'Local State'), 'utf8')).os_crypt;
const plaintextOf = dir => (secretFiles(dir).includes('secrets.bin') ? runTs(dir, [{ op: 'rawRead' }])[0] : null);
const parseOrNull = text => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const seedKeyOf = dir => parseOrNull(fs.existsSync(path.join(dir, 'Local State')) ? fs.readFileSync(path.join(dir, 'Local State'), 'utf8') : '')?.os_crypt?.encrypted_key;
const isDpapiKey = value => typeof value === 'string' && Buffer.from(value, 'base64').subarray(0, 5).toString('latin1') === 'DPAPI';
/**
 * Every `Local State*` file in `dir`, parsed where it is JSON. The key reads as the seed's key
 * or as a new DPAPI key, since each side wraps its own random key. Electron's metrics stamp
 * `uninstall_metrics.installation_date2` is dropped: Electron adds it on every launch, also to a
 * Local State whose key is usable (checked in the fresh-profile scenario), so it is not part of
 * the key policy.
 */
function localStateView(dir, seedKey) {
  return fs
    .readdirSync(dir)
    .filter(name => name.startsWith('Local State'))
    .sort()
    .map(name => {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      const state = name === 'Local State' ? parseOrNull(text) : null;
      if (!state || typeof state !== 'object' || Array.isArray(state)) return { name, text };
      const key = state.os_crypt?.encrypted_key;
      if (key !== undefined && key === seedKey) state.os_crypt.encrypted_key = '<seed key>';
      else if (isDpapiKey(key)) state.os_crypt.encrypted_key = '<new DPAPI key>';
      if (state.uninstall_metrics) {
        delete state.uninstall_metrics.installation_date2;
        if (Object.keys(state.uninstall_metrics).length === 0) delete state.uninstall_metrics;
      }
      return { name, state };
    });
}

let scenario = 0;
/** A profile seeded by Electron with `rawOps`, then changed by `damage`. */
function seed(rawOps, damage = () => {}) {
  const dir = path.join(work, `seed-${scenario}`);
  fs.mkdirSync(dir, { recursive: true });
  if (rawOps.length) runTs(dir, rawOps);
  damage(dir);
  return dir;
}

function cloneProfile(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of ['Local State', 'Local State.bad', 'secrets.bin']) {
    if (fs.existsSync(path.join(from, name))) fs.copyFileSync(path.join(from, name), path.join(to, name));
  }
}

/** Runs `ops` through secrets.ts and cos-secrets on copies of `seeded` and requires one outcome. */
function same(label, seeded, ops) {
  const ts = path.join(work, `${scenario}-ts`);
  const rs = path.join(work, `${scenario}-rs`);
  scenario += 1;
  cloneProfile(seeded, ts);
  cloneProfile(seeded, rs);
  const seedKey = seedKeyOf(seeded);
  const tsResults = runTs(ts, ops);
  const rsResults = runRust(rs, ops);
  // Captured before plaintextOf, whose Electron run would stamp the Rust side's Local State.
  const tsLocalState = localStateView(ts, seedKey);
  const rsLocalState = localStateView(rs, seedKey);
  try {
    assert.deepEqual(rsResults, tsResults, 'operation results');
    assert.deepEqual(rsLocalState, tsLocalState, 'Local State files');
    assert.deepEqual(secretFiles(rs), secretFiles(ts), 'secrets files');
    assert.deepEqual(plaintextOf(rs), plaintextOf(ts), 'secrets.bin as Electron decrypts it');
  } catch (error) {
    console.log(
      `FAIL ${label}\n  ops ${JSON.stringify(ops)}\n  ts  ${JSON.stringify(tsResults)}\n  rs  ${JSON.stringify(rsResults)}\n  ts Local State ${JSON.stringify(tsLocalState)}\n  rs Local State ${JSON.stringify(rsLocalState)}`
    );
    throw error;
  }
  console.log(`PASS ${label}`);
  return { ts, rs, results: rsResults };
}

const flipLastByte = dir => {
  const file = path.join(dir, 'secrets.bin');
  const blob = fs.readFileSync(file);
  blob[blob.length - 1] ^= 1;
  fs.writeFileSync(file, blob);
};
const replaceSecrets = bytes => dir => fs.writeFileSync(path.join(dir, 'secrets.bin'), bytes);
const unreadableOps = [
  ...getAll,
  { op: 'unreadable' },
  { op: 'has', key: 'bridgeToken' },
  { op: 'set', key: 'bridgeToken', value: 'refused' },
  { op: 'clear', key: 'openaiApiKey' },
  { op: 'restart' },
  { op: 'get', key: 'bridgeToken' },
  { op: 'unreadable' },
  { op: 'setAside', now: NOW },
  { op: 'unreadable' },
  { op: 'get', key: 'bridgeToken' },
  { op: 'set', key: 'bridgeToken', value: 'after-set-aside' },
  { op: 'restart' },
  { op: 'get', key: 'bridgeToken' }
];
const expectUnreadable = ({ ts, results }) => {
  assert.equal(results[KEYS.length], true, 'reported unreadable');
  assert.deepEqual(results[KEYS.length + 2], { error: 'unreadable' }, 'set fails closed');
  assert.equal(results[KEYS.length + 7], SET_ASIDE, 'set aside under the UTC stamp');
  assert.equal(results.at(-1), 'after-set-aside');
  assert.deepEqual(secretFiles(ts), ['secrets.bin', SET_ASIDE]);
};

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
buildSync({
  entryPoints: [path.join(repo, 'src/main/secrets.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: bundle,
  logLevel: 'warning'
});

{
  const seeded = seed([{ op: 'rawWrite', plaintext: JSON.stringify(electronMap) }]);
  const { results, rs } = same('Electron async write: same reads, and a write keeps unknown keys, order and bytes', seeded, [
    ...getAll,
    { op: 'set', key: 'bridgeToken', value: 'rotated-dummy' },
    { op: 'set', key: 'setup:new', value: 'sk-new' },
    { op: 'restart' },
    ...getAll
  ]);
  assert.equal(results[1], electronMap.bridgeToken);
  assert.equal(results[2], 'sk-or-v1-dummy-1111', 'API keys are cleaned on read');
  assert.deepEqual(fs.readFileSync(path.join(rs, 'Local State')), fs.readFileSync(path.join(seeded, 'Local State')), 'a usable key: cos-secrets never writes Local State');
}

{
  const seeded = seed([{ op: 'rawWrite', plaintext: JSON.stringify(electronMap), sync: true }]);
  same('Electron sync encryptString (CoS 2.0.0 and 2.0.1): same reads and writes', seeded, [
    ...getAll,
    { op: 'set', key: 'openaiApiKey', value: 'sk-after' },
    { op: 'restart' },
    ...getAll
  ]);
}

{
  const seeded = seed([]);
  const { rs } = same('Fresh profile: each side creates its own key, same results and plaintext', seeded, [
    { op: 'status' },
    { op: 'get', key: 'openaiApiKey' },
    { op: 'unreadable' },
    { op: 'set', key: 'openaiApiKey', value: ' sk-­dummy​\n' },
    { op: 'set', key: 'bridgeToken', value: '﻿ dummy token 　' },
    { op: 'set', key: 'plugin:p:token', value: '  plugin value  ' },
    { op: 'set', key: 'setup:s1', value: 'sk-setup' },
    { op: 'set', key: 'customProviderApiKey', value: '​⁠' },
    { op: 'has', key: 'customProviderApiKey' },
    { op: 'clear', key: 'setup:s1' },
    { op: 'restart' },
    ...['openaiApiKey', 'bridgeToken', 'plugin:p:token', 'setup:s1'].map(key => ({ op: 'get', key })),
    { op: 'setAside', now: NOW },
    { op: 'deleteAll' },
    { op: 'get', key: 'openaiApiKey' },
    { op: 'set', key: 'bridgeToken', value: 'after-delete' }
  ]);
  const keyBefore = localStateKey(rs);
  assert.equal(keyBefore.audit_enabled, true);
  const read = runTs(rs, [{ op: 'rawRead' }, { op: 'get', key: 'bridgeToken' }]);
  assert.equal(read[0].shouldReEncrypt, false, 'Electron accepts the Rust key without re-encrypting');
  assert.equal(read[1], 'after-delete');
  assert.equal(localStateKey(rs).encrypted_key, keyBefore.encrypted_key, 'Electron kept the Rust-created key');
  console.log('PASS Electron adopts a Rust-created key unchanged');

  const stamped = path.join(work, 'rust-created');
  runRust(stamped, [{ op: 'status' }]);
  const created = fs.readFileSync(path.join(stamped, 'Local State'), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(created)), ['os_crypt'], 'Rust writes only os_crypt');
  runTs(stamped, [{ op: 'status' }]);
  const afterElectron = JSON.parse(fs.readFileSync(path.join(stamped, 'Local State'), 'utf8'));
  assert.match(afterElectron.uninstall_metrics.installation_date2, /^\d+$/, 'Electron stamps its install date');
  assert.deepEqual(afterElectron.os_crypt, JSON.parse(created).os_crypt, 'with the key untouched');
  console.log('PASS Electron stamps uninstall_metrics.installation_date2 into any Local State, so the comparison ignores it');
}

expectUnreadable(same('Damaged secrets.bin: unreadable, writes refused, set-aside, then fresh', seed([{ op: 'rawWrite', plaintext: JSON.stringify(electronMap) }], flipLastByte), unreadableOps));

{
  const other = seed([{ op: 'rawWrite', plaintext: JSON.stringify(electronMap) }]);
  scenario += 1;
  const seeded = seed([{ op: 'rawWrite', plaintext: '{}' }], dir => fs.copyFileSync(path.join(other, 'secrets.bin'), path.join(dir, 'secrets.bin')));
  expectUnreadable(same('secrets.bin from another profile: same as damaged', seeded, unreadableOps));
}

for (const [label, plaintext] of [
  ['a non-string value', '{"bridgeToken":1}'],
  ['an array', '[]'],
  ['null', 'null'],
  ['text that is not JSON', 'not json']
]) {
  expectUnreadable(same(`Decryptable payload holding ${label}: unreadable like parseSecretStore`, seed([{ op: 'rawWrite', plaintext }]), unreadableOps));
}

for (const [label, bytes] of [
  ['an empty file', Buffer.alloc(0)],
  ['a v10 prefix and nothing else', Buffer.from('v10')],
  ['a v20 (App-Bound) prefix', Buffer.concat([Buffer.from('v20'), Buffer.alloc(40, 1)])]
]) {
  expectUnreadable(same(`secrets.bin holding ${label}: unreadable`, seed([{ op: 'rawWrite', plaintext: '{}' }], replaceSecrets(bytes)), unreadableOps));
}

{
  const seeded = seed([{ op: 'rawWrite', plaintext: JSON.stringify(electronMap) }]);
  const { results } = same('Set-aside on a readable file changes nothing', seeded, [{ op: 'setAside', now: NOW }, { op: 'get', key: 'bridgeToken' }]);
  assert.deepEqual(results, [null, electronMap.bridgeToken]);
}

{
  const seeded = seed([{ op: 'rawWrite', plaintext: '{}' }], replaceSecrets(Buffer.from('junk')));
  const { results } = same('Delete-all removes an unreadable file and the store starts empty', seeded, [
    { op: 'get', key: 'bridgeToken' },
    { op: 'deleteAll' },
    { op: 'deleteAll' },
    { op: 'unreadable' },
    { op: 'set', key: 'bridgeToken', value: 'fresh' },
    { op: 'restart' },
    { op: 'get', key: 'bridgeToken' }
  ]);
  assert.equal(results.at(-1), 'fresh');
}

{
  const seeded = seed([{ op: 'rawWrite', plaintext: JSON.stringify(electronMap) }], dir => fs.rmSync(path.join(dir, 'Local State')));
  expectUnreadable(same('Local State missing beside secrets.bin: a new key, so the old file is unreadable', seeded, unreadableOps));
}

const damageKey = extra => dir => {
  const file = path.join(dir, 'Local State');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const wrapped = Buffer.from(state.os_crypt.encrypted_key, 'base64');
  wrapped[wrapped.length - 1] ^= 1;
  state.os_crypt.encrypted_key = wrapped.toString('base64');
  fs.writeFileSync(file, JSON.stringify({ ...extra, ...state }));
};
const writeLocalState = text => dir => fs.writeFileSync(path.join(dir, 'Local State'), text);
const otherEntries = {
  browser: { enabled_labs_experiments: ['dummy-flag@1'] },
  profile: { info_cache: { Default: { name: 'Dummy person', avatar_index: 26 } } },
  values: [2.5, 3000000000, -7, true, false, null, 'é✓<>\u2028'],
  12: 'numeric key'
};

// Electron stores a new key in these Local State files, keeping every other entry, and the old
// secrets.bin becomes unreadable until the user sets it aside. cos-secrets does the same.
for (const [label, damage] of [
  ['without os_crypt', writeLocalState(JSON.stringify(otherEntries))],
  ['with os_crypt but no encrypted_key', writeLocalState(JSON.stringify({ ...otherEntries, os_crypt: { audit_enabled: false, other: 'kept' } }))],
  ['whose key DPAPI cannot unwrap', damageKey(otherEntries)],
  ['with a BOM, comments and a raw newline, which Chromium parses', writeLocalState('\uFEFF/* dummy */{"a":"x\ny", // c\n"b":"\x41"}')],
  ['that is not JSON, moved to Local State.bad', writeLocalState('{not json')],
  ['with a trailing comma, which Chromium rejects and moves to Local State.bad', writeLocalState(`${JSON.stringify(otherEntries).slice(0, -1)},}`)]
]) {
  const seeded = seed([{ op: 'rawWrite', plaintext: JSON.stringify(electronMap) }], damage);
  expectUnreadable(same(`Local State ${label}: a new key, then set-aside`, seeded, unreadableOps));
}

// Deliberate difference. Electron can neither use nor replace the key in these Local State files
// and leaves them as they are. It still reports storage available, calls secrets.bin unreadable,
// sets it aside on request, and then fails every write; for a JSON root that is not an object it
// saves under a key it never stores, which its next launch cannot read. cos-secrets reports
// storage unavailable and changes no file, so the user's secrets.bin stays where it is.
const divergentOps = [
  { op: 'status' },
  { op: 'get', key: 'bridgeToken' },
  { op: 'set', key: 'bridgeToken', value: 'x' },
  { op: 'setAside', now: NOW },
  { op: 'set', key: 'bridgeToken', value: 'after-set-aside' }
];
const rustUnavailable = [
  { available: false, detail: 'Secure operating-system credential storage is unavailable on this machine.' },
  null,
  { error: 'unavailable' },
  { error: 'unavailable' },
  { error: 'unavailable' }
];
for (const [label, text, electronLastWrite] of [
  ['whose os_crypt is not an object', '{"os_crypt":"dummy","z":1}', { error: 'io' }],
  ['whose key is not a string', '{"os_crypt":{"encrypted_key":5},"z":1}', { error: 'io' }],
  ['whose key is empty', '{"os_crypt":{"encrypted_key":""},"z":1}', { error: 'io' }],
  ['whose key is not base64', '{"os_crypt":{"encrypted_key":"!!not base64"},"z":1}', { error: 'io' }],
  ['whose key lacks the DPAPI prefix', `{"os_crypt":{"encrypted_key":"${Buffer.from('NOPE-dummy').toString('base64')}"},"z":1}`, { error: 'io' }],
  ['whose JSON root is not an object', '["dummy"]', null]
]) {
  const seeded = seed([{ op: 'rawWrite', plaintext: JSON.stringify(electronMap) }], writeLocalState(text));
  const ts = path.join(work, `${scenario}-ts`);
  const rs = path.join(work, `${scenario}-rs`);
  scenario += 1;
  cloneProfile(seeded, ts);
  cloneProfile(seeded, rs);
  const tsResults = runTs(ts, divergentOps);
  assert.deepEqual(tsResults, [{ available: true, detail: null }, null, { error: 'unreadable' }, SET_ASIDE, electronLastWrite], `secrets.ts, Local State ${label}`);
  assert.deepEqual(runRust(rs, divergentOps), rustUnavailable, `cos-secrets, Local State ${label}`);
  assert.deepEqual(localStateView(rs), localStateView(ts), 'neither side wrote a key into Local State');
  assert.deepEqual(fs.readFileSync(path.join(rs, 'Local State')), fs.readFileSync(path.join(seeded, 'Local State')), 'cos-secrets left Local State alone');
  assert.deepEqual(secretFiles(rs), ['secrets.bin'], 'cos-secrets left secrets.bin in place');
  assert.deepEqual(fs.readFileSync(path.join(rs, 'secrets.bin')), fs.readFileSync(path.join(seeded, 'secrets.bin')), 'and unchanged');
  console.log(`PASS Local State ${label}: neither side replaces the key; cos-secrets reports unavailable and changes nothing`);
}

console.log('ALL PASS');
