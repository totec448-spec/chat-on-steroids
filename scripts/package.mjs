import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeArch, normalizePlatform, PLATFORM_INFO } from './packaging-targets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function value(name, fallback) {
  const direct = args.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}

const platform = normalizePlatform(value('platform', process.platform));
const arches = value('arch', process.arch).split(',').map((item) => normalizeArch(item.trim()));
const dirOnly = args.includes('--dir');

function run(command, commandArgs, env = process.env) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const node = process.execPath;
run(node, ['scripts/make-icon.mjs']);
run(node, [path.join('node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build']);

for (const arch of arches) {
  const targetArgs = ['--platform', platform, '--arch', arch];
  run(node, ['scripts/fetch-tunnel-client.mjs', ...targetArgs]);
  run(node, ['scripts/fetch-ripgrep.mjs', ...targetArgs]);
  run(node, ['scripts/prepare-packaging-native.mjs', ...targetArgs]);

  const builderArgs = [
    path.join('node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
    PLATFORM_INFO[platform].builderFlag,
    `--${arch}`,
    '--publish',
    'never'
  ];
  if (dirOnly) builderArgs.push('--dir');
  run(node, builderArgs, { ...process.env, COS_PACKAGE_ARCH: arch });
}
