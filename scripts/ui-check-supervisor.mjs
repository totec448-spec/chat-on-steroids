// The direct wrapper may be SIGKILLed. This short-lived process owns the check
// from spawn onward; closing its parent IPC channel triggers the runner's exit hook.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import profileHelpers from './ui-check-profile.cjs';
import { runUiCheck } from './ui-check-process.mjs';

const filename = fileURLToPath(import.meta.url);

export function runSupervisedUiCheck(command, args, { cwd, env, profileRoot }) {
  return new Promise((resolve, reject) => {
    const checkEnv = { ...env };
    delete checkEnv.ELECTRON_RUN_AS_NODE;
    const supervisor = fork(filename, [], {
      execArgv: [], detached: true, windowsHide: true,
      // process.execPath can be Electron under direct `electron script` invocation.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc']
    });
    let outcome, failure;
    const disconnect = () => { if (supervisor.connected) supervisor.disconnect(); };
    const onInterrupt = () => process.exit(130);
    const onTerminate = () => process.exit(143);
    const failed = error => { failure = error; disconnect(); };
    process.once('exit', disconnect);
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    supervisor.on('error', failed);
    supervisor.on('message', message => {
      if (message?.type === 'result') outcome = message.outcome;
      if (message?.type !== 'ready') return;
      try { supervisor.send({ type: 'start', command, args, cwd, env: checkEnv, profileRoot }, error => { if (error) failed(error); }); }
      catch (error) { failed(error); }
    });
    supervisor.once('close', (code, signal) => {
      process.removeListener('exit', disconnect);
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
      if (outcome) resolve(outcome);
      else reject(failure || new Error(`UI check supervisor exited without a result (${code ?? signal})`));
    });
  });
}

if (process.argv[1] === filename) {
  // Register disconnect handling before readiness. A channel already closed
  // during module loading permits no profile/check launch.
  process.once('disconnect', () => process.exit(0));
  process.stdout.on('error', () => process.exit(1));
  process.stderr.on('error', () => process.exit(1));
  const sendResult = outcome => {
    if (!process.connected) process.exit(0);
    // A callback handles IPC failures without an unhandled channel error. Exit
    // still runs the shared owner's tree cleanup if setup failed after spawning.
    process.send({ type: 'result', outcome }, error => process.exit(error ? 1 : 0));
  };
  process.once('message', launch => {
    if (!process.connected || launch?.type !== 'start') process.exit(0);
    let task;
    try {
      const profile = profileHelpers.createProfile(launch.profileRoot);
      if (!process.connected) process.exit(0);
      task = runUiCheck(launch.command, launch.args, {
        cwd: launch.cwd, env: launch.env, profile, inheritStdio: true
      });
    } catch (error) { task = Promise.reject(error); }
    task.then(sendResult, error => sendResult({ code: 1, output: String(error) }));
  });
  if (!process.connected) process.exit(0);
  process.send({ type: 'ready' }, error => { if (error) process.exit(0); });
}
