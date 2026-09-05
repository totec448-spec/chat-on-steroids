import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  UnifiedExecError,
  UnifiedExecProcessManager,
  applyUnifiedExecEnv,
  execCommandResponseText,
  execCommandStructuredOutput,
  type ExecCommandToolOutput
} from '../src/main/codex/unified-exec.js';
import {
  DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS,
  MAX_YIELD_TIME_MS,
  MIN_YIELD_TIME_MS,
  clampYieldTime
} from '../src/main/codex/unified-exec-constants.js';
import {
  defaultUserShell,
  deriveExecArgs,
  getShell,
  getShellByModelProvidedPath,
  posixShellPreference,
  shlexJoin
} from '../src/main/codex/shell.js';
import { terminateProcessTree } from '../src/main/exec.js';
import { composeCommandBatch, parseCommandBatchSections } from '../src/main/codex/command-batch.js';

const truncationPolicy = { kind: 'tokens' as const, tokens: 10_000 };

function manager(): UnifiedExecProcessManager {
  return new UnifiedExecProcessManager(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS);
}

async function waitForProcess(instance: UnifiedExecProcessManager, processId: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (instance.listProcesses().some((item) => item.processId === processId)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`process ${processId} was not stored as live`);
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`file was not created: ${file}`);
}

describe('Codex unified exec runtime parity', () => {
  const managers: UnifiedExecProcessManager[] = [];
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((item) => item.terminateAllProcesses()));
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  /**
   * The failing command is quoted back to the model to retry, so the quoting has to survive
   * being read back. shlex ends the run, escapes the apostrophe and reopens: `'\''`. Spelled
   * as a double-quoted JavaScript string that collapses to three apostrophes, which is not a
   * longer way of writing the same thing — it leaves a quote open.
   */
  it('quotes an apostrophe the way shlex does, so the command reads back', () => {
    expect(shlexJoin(['rg', "it's"])).toBe("rg 'it'\\''s'");
    expect(shlexJoin(['rg', "it's"])).not.toContain("'''");
    // Our own glob expansion quotes every name it substitutes, so a script reaching this
    // function with apostrophes in it is the ordinary case, not a corner one.
    expect(shlexJoin(['powershell.exe', '-Command', "rg foo 'a.ts'"])).toBe(
      "powershell.exe -Command 'rg foo '\\''a.ts'\\'''"
    );
    expect(shlexJoin(['rg', 'plain-token'])).toBe('rg plain-token');
    expect(shlexJoin(['rg', ''])).toBe("rg ''");
    expect(shlexJoin(['rg', 'a\0b'])).toBe('<command included NUL byte>');
  });

  it('uses Codex login-shell argv semantics for PowerShell', () => {
    const shell = { shellType: 'powershell' as const, shellPath: 'powershell.exe' };
    expect(deriveExecArgs(shell, "Write-Output 'x'", true)).toEqual([
      'powershell.exe',
      '-Command',
      "Write-Output 'x'"
    ]);
    expect(deriveExecArgs(shell, "Write-Output 'x'", false)).toEqual([
      'powershell.exe',
      '-NoProfile',
      '-Command',
      "Write-Output 'x'"
    ]);
  });

  it.runIf(process.platform === 'win32')('keeps explicit powershell and pwsh names distinct', () => {
    // Both executables share the internal `powershell` shell type, but they do not share a
    // grammar. An explicit Windows PowerShell request must never be upgraded to pwsh merely
    // because pwsh happens to appear first in the default-shell preference order.
    const windowsPowerShell = getShellByModelProvidedPath('powershell');
    expect(windowsPowerShell).not.toBeNull();
    expect(path.basename(windowsPowerShell!.shellPath).toLowerCase()).toBe('powershell.exe');

    const windowsPowerShellExe = getShellByModelProvidedPath('powershell.exe');
    expect(windowsPowerShellExe).not.toBeNull();
    expect(path.basename(windowsPowerShellExe!.shellPath).toLowerCase()).toBe('powershell.exe');

    const pwsh = getShellByModelProvidedPath('pwsh');
    if (pwsh) expect(path.basename(pwsh.shellPath).toLowerCase()).toBe('pwsh.exe');
  });

  it('resolves a relative explicit shell path against the command cwd, not the app cwd', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'clf-shell-cwd-'));
    tempRoots.push(root);
    const tools = path.join(root, 'tools');
    await mkdir(tools, { recursive: true });
    const shellFile = path.join(tools, process.platform === 'win32' ? 'powershell.exe' : 'bash');
    await writeFile(shellFile, 'placeholder', 'utf8');
    if (process.platform !== 'win32') await chmod(shellFile, 0o755);

    const relative = process.platform === 'win32' ? '.\\tools\\powershell.exe' : './tools/bash';
    const resolved = getShellByModelProvidedPath(relative, root);
    expect(resolved).not.toBeNull();
    expect(path.normalize(resolved!.shellPath)).toBe(path.normalize(shellFile));
  });

  it.runIf(process.platform !== 'win32')('requires the POSIX executable bit for an explicit shell', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'clf-shell-executable-'));
    tempRoots.push(root);
    const shellFile = path.join(root, 'bash');
    await writeFile(shellFile, '#!/bin/sh\n', { encoding: 'utf8', mode: 0o644 });
    expect(getShellByModelProvidedPath(shellFile)).toBeNull();

    await chmod(shellFile, 0o755);
    expect(getShellByModelProvidedPath(shellFile)).toMatchObject({ shellType: 'bash', shellPath: shellFile });
  });

  it('classifies a launch failure as CreateProcess, matching Codex', async () => {
    const instance = manager();
    managers.push(instance);
    const processId = instance.allocateProcessId();

    await expect(
      instance.execCommand({
        command: ['__codex_missing_executable_for_parity_test__'],
        shellType: process.platform === 'win32' ? 'powershell' : 'bash',
        hookCommand: '__codex_missing_executable_for_parity_test__',
        processId,
        yieldTimeMs: 250,
        maxOutputTokens: undefined,
        truncationPolicy,
        cwd: process.cwd(),
        displayCwd: process.cwd(),
        env: applyUnifiedExecEnv(process.env),
        tty: false
      })
    ).rejects.toMatchObject({ kind: 'create_process' } satisfies Partial<UnifiedExecError>);
  });

  it('forces Codex pager/color environment defaults over inherited values', () => {
    const env = applyUnifiedExecEnv({
      PATH: 'sentinel-path',
      NO_COLOR: '0',
      TERM: 'xterm-256color',
      PAGER: 'less'
    });

    expect(env.PATH).toBe('sentinel-path');
    expect(env.NO_COLOR).toBe('1');
    expect(env.TERM).toBe('dumb');
    expect(env.PAGER).toBe('cat');
    expect(env.CODEX_CI).toBe('1');
  });

  it('keeps structured exec output under the same model budget as the text representation', () => {
    const output: ExecCommandToolOutput = {
      chunkId: 'cap-test',
      wallTimeMs: 1,
      rawOutput: Buffer.from('x'.repeat(240_000), 'utf8'),
      truncationPolicy,
      maxOutputTokens: undefined,
      processId: null,
      exitCode: 0,
      originalTokenCount: 60_000,
      outputOmittedBytes: null
    };
    const text = execCommandResponseText(output);
    const structured = execCommandStructuredOutput(output) as { output: string };
    expect(structured.output.length).toBeLessThan(output.rawOutput.length);
    expect(structured.output).toContain('truncated');
    expect(text).toContain(structured.output);
  });

  it('keeps the Codex bounds but honours an explicit short initial yield on Windows', () => {
    expect(clampYieldTime(0)).toBe(MIN_YIELD_TIME_MS);
    expect(clampYieldTime(250)).toBe(250);
    expect(clampYieldTime(Number.MAX_SAFE_INTEGER)).toBe(MAX_YIELD_TIME_MS);
  });

  it('keeps default shell resolution stable while its environment inputs are unchanged', () => {
    expect(defaultUserShell()).toBe(defaultUserShell());
  });

  it('uses Codex login-shell argv semantics for POSIX shells', () => {
    const bash = { shellType: 'bash' as const, shellPath: '/bin/bash' };
    expect(deriveExecArgs(bash, "printf '%s\\n' x", true)).toEqual([
      '/bin/bash',
      '-lc',
      "printf '%s\\n' x"
    ]);
    expect(deriveExecArgs(bash, "printf '%s\\n' x", false)).toEqual([
      '/bin/bash',
      '-c',
      "printf '%s\\n' x"
    ]);
  });

  it('models macOS/Linux shell fallback policy without inventing a Windows shell', () => {
    expect(posixShellPreference('darwin', null)).toEqual(['zsh', 'bash']);
    expect(posixShellPreference('linux', null)).toEqual(['bash', 'zsh']);
    expect(posixShellPreference('darwin', 'bash')).toEqual(['bash', 'zsh']);
    expect(posixShellPreference('linux', 'zsh')).toEqual(['zsh', 'bash']);
    expect(posixShellPreference('darwin', null)).not.toContain('powershell');
    expect(posixShellPreference('linux', null)).not.toContain('cmd');
  });

  it('does not let batch command output impersonate wrapper exit markers', () => {
    const batch = composeCommandBatch(['Write-Output one', 'Write-Output two'], 'powershell');
    const marker = /clf-batch:([0-9a-f]{24})/.exec(batch)?.[1];
    expect(marker).toBeDefined();

    const output = [
      `--- command 1/2 --- [clf-batch:${marker}]`,
      '--- exit code 0 ---',
      'real failure',
      `--- exit code 5 --- [clf-batch:${marker}]`,
      `--- command 2/2 --- [clf-batch:${marker}]`,
      'no matches',
      `--- exit code 1 --- [clf-batch:${marker}]`
    ].join('\n');

    expect(parseCommandBatchSections(output)).toEqual([
      { index: 1, exitCode: 5, text: '--- exit code 0 ---\nreal failure' },
      { index: 2, exitCode: 1, text: 'no matches' }
    ]);
  });

  it('preserves a completed pipe command exit code and drains both output streams', async () => {
    const instance = manager();
    managers.push(instance);
    const processId = instance.allocateProcessId();
    const output = await instance.execCommand({
      command: [
        process.execPath,
        '-e',
        "process.stdout.write('stdout-marker\\n'); process.stderr.write('stderr-marker\\n'); process.exit(17)"
      ],
      shellType: process.platform === 'win32' ? 'powershell' : 'bash',
      hookCommand: 'pipe exit-code parity child',
      processId,
      // Long enough for the child to finish, because finishing is the premise rather than the
      // claim: this asserts that a *completed* command yields a null process id, its exit code and
      // both streams. At 250 ms it was betting that PowerShell and node start that fast, and on a
      // loaded Windows-on-ARM machine they do not — the run then handed back a process id, which
      // is the correct answer to a command that has not finished, and the test read it as a
      // regression. The neighbouring cases keep their short windows: they are the ones proving
      // that an unfinished command *does* come back with an id.
      yieldTimeMs: 10_000,
      maxOutputTokens: undefined,
      truncationPolicy,
      cwd: process.cwd(),
      displayCwd: process.cwd(),
      env: applyUnifiedExecEnv(process.env),
      tty: false
    });

    expect(output.processId).toBeNull();
    expect(output.exitCode).toBe(17);
    expect(output.rawOutput.toString('utf8')).toContain('stdout-marker');
    expect(output.rawOutput.toString('utf8')).toContain('stderr-marker');
  });

  it('returns an empty write_stdin poll as soon as the first output arrives', async () => {
    const instance = manager();
    managers.push(instance);
    const processId = instance.allocateProcessId();
    const initial = await instance.execCommand({
      command: [
        process.execPath,
        '-e',
        "setTimeout(() => process.stdout.write('first-poll-output\\n'), 600); setInterval(() => {}, 1_000)"
      ],
      shellType: process.platform === 'win32' ? 'powershell' : 'bash',
      hookCommand: 'delayed poll output child',
      processId,
      yieldTimeMs: 250,
      maxOutputTokens: undefined,
      truncationPolicy,
      cwd: process.cwd(),
      displayCwd: process.cwd(),
      env: applyUnifiedExecEnv(process.env),
      tty: false
    });
    expect(initial.processId).toBe(processId);
    expect(initial.rawOutput.toString('utf8')).not.toContain('first-poll-output');

    const polled = await instance.writeStdin({
      processId,
      input: '',
      yieldTimeMs: 5_000,
      maxOutputTokens: undefined,
      truncationPolicy
    });
    expect(polled.rawOutput.toString('utf8')).toContain('first-poll-output');
    expect(polled.wallTimeMs).toBeLessThan(2_500);
    expect(polled.processId).toBe(processId);
  });

  it.runIf(process.platform === 'win32')('forces UTF-8 for PowerShell pipe output like Codex', async () => {
    const shell = getShell('powershell');
    expect(shell).not.toBeNull();
    const instance = manager();
    managers.push(instance);
    const processId = instance.allocateProcessId();
    const marker = 'héllo 中文 😀';
    const output = await instance.execCommand({
      command: deriveExecArgs(shell!, `Write-Output '${marker}'`, false),
      shellType: 'powershell',
      hookCommand: `Write-Output '${marker}'`,
      processId,
      // This test is about the encoding of what PowerShell writes, not about yield timing.
      // It used to pass 250 ms and observe an exit anyway, because the Windows floor silently
      // raised every initial yield to ten seconds. With that floor gone the 250 ms is real, and
      // a loaded machine starts PowerShell more slowly than that — so the call would return a
      // session id and no exit code. Ask for the window the floor used to grant it.
      yieldTimeMs: 10_000,
      maxOutputTokens: undefined,
      truncationPolicy,
      cwd: process.cwd(),
      displayCwd: process.cwd(),
      env: applyUnifiedExecEnv(process.env),
      tty: false
    });

    expect(output.exitCode).toBe(0);
    expect(output.rawOutput.toString('utf8')).toContain(marker);
  });

  it('lets the initial exec response observe concurrent termination, matching Codex', async () => {
    const instance = manager();
    managers.push(instance);
    const processId = instance.allocateProcessId();
    const initial = instance.execCommand({
      command: [process.execPath, '-e', 'setInterval(() => {}, 1_000)'],
      shellType: process.platform === 'win32' ? 'powershell' : 'bash',
      hookCommand: 'long-running parity child',
      processId,
      yieldTimeMs: 30_000,
      maxOutputTokens: undefined,
      truncationPolicy,
      cwd: process.cwd(),
      displayCwd: process.cwd(),
      env: applyUnifiedExecEnv(process.env),
      tty: false
    });

    await waitForProcess(instance, processId);
    expect(await instance.terminateProcess(processId)).toBe(true);

    /*
     * Reported rather than merely asserted, because this failed once on a loaded Linux arm64
     * runner and left nothing to work from — and it could not be reproduced afterwards, in
     * twenty-five consecutive runs here or on a second attempt in CI. Reading the code says it
     * should not be possible: the collector only stops early when the cancel signal and the closed
     * output agree, and that signal is set in the one place that also marks the process exited.
     *
     * So these two numbers are the ones that would settle it. A `wallTimeMs` near the 30s yield
     * means the collector waited out its deadline and the exit was never seen; a small one with a
     * null `exitCode` means it stopped early while the process was still considered live, which
     * would put the fault in the agreement between those two flags.
     */
    const settled = await initial;
    expect(
      settled.processId,
      `the first response still names a process: wallTimeMs=${Math.round(settled.wallTimeMs)}, ` +
        `exitCode=${settled.exitCode}, still listed=${JSON.stringify(instance.listProcesses())}`
    ).toBeNull();
    expect(instance.listProcesses()).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('Ctrl-C on a Windows pipe session terminates the whole process tree', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'clf-pipe-interrupt-parity-'));
    tempRoots.push(root);
    const ready = path.join(root, 'grandchild.pid');
    const survived = path.join(root, 'grandchild-survived.txt');
    const grandchildScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(survived)}, 'survived'), 900); setInterval(() => {}, 1000);`;
    const parentScript = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(grandchildScript)}], {stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(ready)}, String(child.pid)); setInterval(() => {}, 1000);`;

    const instance = manager();
    managers.push(instance);
    const processId = instance.allocateProcessId();
    const initial = instance.execCommand({
      command: [process.execPath, '-e', parentScript],
      shellType: 'powershell',
      hookCommand: 'pipe process-tree parity child',
      processId,
      yieldTimeMs: 30_000,
      maxOutputTokens: undefined,
      truncationPolicy,
      cwd: root,
      displayCwd: root,
      env: applyUnifiedExecEnv(process.env),
      tty: false
    });

    await waitForProcess(instance, processId);
    await waitForFile(ready);
    const grandchildPid = Number.parseInt(await readFile(ready, 'utf8'), 10);
    try {
      const interrupted = await instance.writeStdin({
        processId,
        input: String.fromCharCode(3),
        yieldTimeMs: 250,
        maxOutputTokens: undefined,
        truncationPolicy
      });
      expect(interrupted.processId).toBeNull();
      await expect(initial).resolves.toMatchObject({ processId: null });
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await expect(access(survived)).rejects.toBeDefined();
    } finally {
      if (Number.isInteger(grandchildPid) && grandchildPid > 0) {
        await terminateProcessTree(grandchildPid, true).catch(() => undefined);
      }
    }
  });

  it.runIf(process.platform !== 'win32')('Ctrl-C on a POSIX pipe session terminates the whole process group', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'clf-posix-pipe-interrupt-parity-'));
    tempRoots.push(root);
    const ready = path.join(root, 'grandchild.pid');
    const survived = path.join(root, 'grandchild-survived.txt');
    const grandchildScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(survived)}, 'survived'), 900); setInterval(() => {}, 1000);`;
    const parentScript = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(grandchildScript)}], {stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(ready)}, String(child.pid)); setInterval(() => {}, 1000);`;

    const instance = manager();
    managers.push(instance);
    const processId = instance.allocateProcessId();
    const initial = instance.execCommand({
      command: [process.execPath, '-e', parentScript],
      shellType: 'bash',
      hookCommand: 'POSIX pipe process-group parity child',
      processId,
      yieldTimeMs: 30_000,
      maxOutputTokens: undefined,
      truncationPolicy,
      cwd: root,
      displayCwd: root,
      env: applyUnifiedExecEnv(process.env),
      tty: false
    });

    await waitForProcess(instance, processId);
    await waitForFile(ready);
    const grandchildPid = Number.parseInt(await readFile(ready, 'utf8'), 10);
    try {
      const interrupted = await instance.writeStdin({
        processId,
        input: String.fromCharCode(3),
        yieldTimeMs: 250,
        maxOutputTokens: undefined,
        truncationPolicy
      });
      expect(interrupted.processId).toBeNull();
      await expect(initial).resolves.toMatchObject({ processId: null });
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await expect(access(survived)).rejects.toBeDefined();
    } finally {
      if (Number.isInteger(grandchildPid) && grandchildPid > 0) {
        await terminateProcessTree(grandchildPid, true).catch(() => undefined);
      }
    }
  });

  it.runIf(process.platform !== 'win32')('terminating a POSIX PTY session kills descendants in its process group', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'clf-posix-pty-tree-parity-'));
    tempRoots.push(root);
    const ready = path.join(root, 'grandchild.pid');
    const survived = path.join(root, 'grandchild-survived.txt');
    const grandchildScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(survived)}, 'survived'), 900); setInterval(() => {}, 1000);`;
    const parentScript = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(grandchildScript)}], {stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(ready)}, String(child.pid)); setInterval(() => {}, 1000);`;

    const instance = manager();
    managers.push(instance);
    const processId = instance.allocateProcessId();
    const initial = instance.execCommand({
      command: [process.execPath, '-e', parentScript],
      shellType: 'bash',
      hookCommand: 'POSIX PTY process-group parity child',
      processId,
      yieldTimeMs: 250,
      maxOutputTokens: undefined,
      truncationPolicy,
      cwd: root,
      displayCwd: root,
      env: applyUnifiedExecEnv(process.env),
      tty: true
    });

    await waitForProcess(instance, processId);
    await waitForFile(ready);
    const grandchildPid = Number.parseInt(await readFile(ready, 'utf8'), 10);
    try {
      expect(await instance.terminateProcess(processId)).toBe(true);
      await expect(initial).resolves.toMatchObject({ processId: null });
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await expect(access(survived)).rejects.toBeDefined();
    } finally {
      if (Number.isInteger(grandchildPid) && grandchildPid > 0) {
        await terminateProcessTree(grandchildPid, true).catch(() => undefined);
      }
    }
  });
});
