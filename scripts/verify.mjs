import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');

function run(label, command, args) {
  process.stdout.write(`\n== ${label} ==\n`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('ripgrep', node, ['scripts/fetch-ripgrep.mjs']);
run('public history', node, ['scripts/verify-public-history.mjs']);
run('third-party notices', node, ['scripts/generate-third-party-notices.mjs', '--check']);
run('native sources', node, ['scripts/package-native-sources.mjs', '--check']);
run('typecheck', node, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', 'tsconfig.json']);
run('Electron resolution', node, ['-e', "require('electron')"]);
run('tests', node, [vitest, 'run', '--exclude', 'test/mcp-shutdown.test.ts', '--exclude', 'test/computer.test.ts']);
run('desktop and shutdown tests', node, [vitest, 'run', '--maxWorkers=1', 'test/computer.test.ts', 'test/mcp-shutdown.test.ts']);
