const { spawn } = require('node:child_process');

// Pass the readiness prefix as data, not interpolated JavaScript source.
const prefix = process.argv[2];
if (!prefix) throw new Error('Missing process-lifetime readiness prefix');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
child.once('error', error => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('spawn', () => {
  console.log(prefix + child.pid);
  setInterval(() => {}, 1000);
});
