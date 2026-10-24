// Differential check: the TypeScript sandbox (src/main/sandbox.ts) and cos-fs decide the same
// paths against the same disk. Builds a fixture with links, runs every case through both, and
// prints each difference. Exit 0 when the only differences are the listed deliberate ones.
//
//   node rust/crates/cos-fs/differential/run.mjs [--probe <path to probe.exe>]
//
// Without --probe it runs `cargo run -q -p cos-fs --example probe` from rust/.

import { spawnSync } from 'node:child_process';
import { promises as fs, realpathSync } from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const rustDir = path.join(repo, 'rust');
const WINDOWS = process.platform === 'win32';

// The TypeScript sources import siblings as `./x.js`; map those onto the `.ts` files.
register(
  'data:text/javascript,' +
    encodeURIComponent(`
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.js') && context.parentURL && context.parentURL.endsWith('.ts')) {
    const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
  }
  return next(specifier, context);
}`)
);
const { resolvePath, SandboxError } = await import(pathToFileURL(path.join(repo, 'src/main/sandbox.ts')).href);

const base = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), 'cos-fs-diff-')));
const at = (...parts) => path.join(base, ...parts);
const write = async (relative, content) => {
  await fs.mkdir(path.dirname(at(relative)), { recursive: true });
  await fs.writeFile(at(relative), content);
};
await write('approved/file.txt', 'hello');
await write('approved/sub/nested.txt', 'nested');
await write('approved/sub/deep/leaf.txt', 'leaf');
await write('outside/secret.txt', 'TOP SECRET');
await fs.symlink(at('outside'), at('approved/escape'), 'junction');
await fs.symlink(at('approved/sub'), at('approved/inner'), 'junction');
await fs.symlink(at('outside/planted'), at('approved/dangling'), 'junction');
await fs.mkdir(at('case/kit'), { recursive: true });
let kelvin = true;
try {
  await fs.mkdir(at('case/\u212ait'));
  await fs.writeFile(at('case/\u212ait/secret.txt'), 'SECRET');
  await fs.symlink(at('case/\u212ait'), at('case/kit/link'), 'junction');
} catch {
  kelvin = false;
}

const A = at('approved');
const O = at('outside');
const project = [{ name: 'project', path: A }];
const two = [...project, { name: 'project-two', path: O }];
const kit = [{ name: 'kit', path: at('case/kit') }];
const wsl = [{ name: 'work', path: String.raw`\\wsl.localhost\Ubuntu\home\you\Project` }];

const virtualInputs = [
  '/project/file.txt', '/project', '//project///sub//nested.txt', '/PROJECT/file.txt',
  '/project/SUB/NESTED.TXT', '/project/SUB/missing.txt', '/project/brand-new.txt', '/project/a/b/c.txt',
  '/project/../outside/secret.txt', '/project/sub/../file.txt', '/..', '/project/./x', '/project/sub/',
  '/project/file.txt\0.png', '/project/fi\x07le.txt', '/nope/file.txt', '/', '', '   ', '\t',
  `/project/${'a'.repeat(5000)}`, `/project/${'a'.repeat(300)}.txt`, `/project/${'\u{1f600}'.repeat(128)}`,
  'src/greeting.txt', `${'d'.repeat(200)}/x`, '/project/escape/secret.txt', '/project/escape',
  '/project/escape/planted.txt', '/project/inner/nested.txt', '/project/dangling/x.txt',
  '/home/me/Project/sub/nested.txt', '/home/me/project', '/project/sub', '/project-two/secret.txt',
  'C:file.txt', '/project/back\\slash.txt',
];
const windowsInputs = [
  '\\project\\sub\\nested.txt', '/project\\sub/nested.txt', '\\project\\..\\outside\\secret.txt',
  '/project/C:file.txt', '/project/file.txt:hidden', '/project/file.txt::$DATA', '/project/file.txt.',
  '/project/file.txt ', ' /project/file.txt', '/project/*', '/project/?', '/project/<a>', '/project/a|b',
  '/project/a"b', '//?/C:/Windows/win.ini', '//./C:/Windows/win.ini', '/project/CON', '/project/nul',
  '/project/aux.txt', '/project/conout$.log', '/project/COM0', '/project/lpt9.tar.gz',
  `${A}\\file.txt`, A, `${A.toUpperCase()}\\FILE.TXT`, `${A.replaceAll('\\', '/')}/sub/nested.txt`,
  `${A}\\sub\\..\\file.txt`, `${A}\\file.txt::$DATA`, `${A}\\file.txt:secret`, `${A}\\file.txt.`,
  `${A}\\CON`, `${A}\\escape\\secret.txt`, `${A}\\inner\\nested.txt`, `${A}\\none.txt`, `${A}\\new\\deep.txt`,
  `${O}\\secret.txt`, 'C:\\Windows\\win.ini', 'C:/Windows/win.ini', '\\\\server\\share\\x.txt',
  `\\\\?\\${A}\\file.txt`, `\\\\.\\${A}`, `\\\\localhost\\C$\\${A.slice(3)}\\file.txt`,
  `\\\\?\\UNC\\localhost\\C$\\${A.slice(3)}`, '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\x',
  'Q:\\project\\sub\\nested.txt', `  ${A}\\file.txt\ufeff`, `${A}\\\\sub\\\\nested.txt`,
];
const wslInputs = [
  String.raw`\\server\share\file.txt`, String.raw`\\wsl.localhost\Ubuntu\home\you\project\x`,
  String.raw`\\wsl$\Ubuntu\home\you\Project\..\secret.txt`, '/work/../x',
];

const cases = [];
const add = (roots, inputs, extra = {}) => {
  for (const input of inputs) {
    for (const allowMissing of [false, true]) cases.push({ roots, path: input, allowMissing, ...extra });
  }
};
add(project, virtualInputs);
if (WINDOWS) add(project, windowsInputs);
add(two, ['/project-two/secret.txt', '/project/file.txt', `${O}\\secret.txt`, '/nope']);
add([], ['/nope/x', 'rel', `${O}\\secret.txt`]);
add(project, ['nested.txt', '../file.txt', 'deep/../../file.txt', '/project/file.txt', 'x\\..\\y', '', 'new.txt'], { base: '/project/sub' });
if (kelvin) add(kit, ['/kit/link/secret.txt', '/kit/link']);
if (WINDOWS) add(wsl, wslInputs);

const tsResults = [];
for (const item of cases) {
  try {
    const options = { allowMissing: item.allowMissing };
    if (item.base) options.base = (await resolvePath(item.roots, item.base)).virtual;
    const resolved = await resolvePath(item.roots, item.path, options);
    tsResults.push({ ok: [resolved.virtual, resolved.real] });
  } catch (error) {
    tsResults.push(error instanceof SandboxError
      ? { err: error.message, kind: 'sandbox' }
      : { err: error.code ?? String(error), kind: 'os' });
  }
}

const probeIndex = process.argv.indexOf('--probe');
const probe = probeIndex > 0
  ? spawnSync(process.argv[probeIndex + 1], [], { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 1 << 26 })
  : spawnSync('cargo', ['run', '-q', '-p', 'cos-fs', '--example', 'probe'], {
      cwd: rustDir, input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 1 << 26, shell: WINDOWS
    });
if (probe.status !== 0) {
  console.error(probe.stderr);
  process.exit(2);
}
const rustResults = JSON.parse(probe.stdout);

// Deliberate differences, each a TypeScript escape cos-fs refuses (see the cos-fs README).
const deliberate = [
  { when: (c) => c.path.includes('dangling') && c.allowMissing, why: 'create through a dangling link' },
  { when: (c) => c.roots === kit, why: 'KELVIN SIGN sibling taken as inside by JavaScript case folding' },
];

let unexpected = 0;
let expected = 0;
const show = (value) => JSON.stringify(value).replaceAll(base, '<BASE>');
cases.forEach((item, index) => {
  const ts = tsResults[index];
  const rust = rustResults[index];
  const same = ts.kind === 'os' && rust.kind === 'os' ? true : JSON.stringify(ts) === JSON.stringify(rust);
  if (same) return;
  const reason = deliberate.find((entry) => entry.when(item));
  const line = `${show(item.path)} allowMissing=${item.allowMissing}${item.base ? ` base=${item.base}` : ''}\n  ts:   ${show(ts)}\n  rust: ${show(rust)}`;
  if (reason) {
    expected++;
    console.log(`DELIBERATE (${reason.why}): ${line}`);
  } else {
    unexpected++;
    console.log(`DIFFERENT: ${line}`);
  }
});
await fs.rm(base, { recursive: true, force: true });
console.log(`${cases.length} cases: ${cases.length - expected - unexpected} same, ${expected} deliberate, ${unexpected} unexpected${kelvin ? '' : ' (KELVIN case skipped)'}`);
process.exit(unexpected === 0 ? 0 : 1);
