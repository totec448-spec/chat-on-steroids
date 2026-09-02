import { expect, it } from 'vitest';
import { UnifiedExecProcessManager, applyUnifiedExecEnv } from '../src/main/codex/unified-exec.js';
import {
  DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS,
  MAX_UNIFIED_EXEC_PROCESSES
} from '../src/main/codex/unified-exec-constants.js';

const truncationPolicy = { kind: 'tokens' as const, tokens: 10_000 };

it('does not let a lock attempt barge ahead of an already queued waiter', async () => {
  const manager = new UnifiedExecProcessManager(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS);
  const processId = manager.allocateProcessId();
  const initial = manager.execCommand({
    command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    shellType: process.platform === 'win32' ? 'powershell' : 'bash',
    hookCommand: 'mutex handoff probe',
    processId,
    yieldTimeMs: 30_000,
    maxOutputTokens: undefined,
    truncationPolicy,
    cwd: process.cwd(),
    displayCwd: process.cwd(),
    env: applyUnifiedExecEnv(process.env),
    tty: false
  });

  try {
    const deadline = Date.now() + 2_000;
    while (!manager.listProcesses().some((entry) => entry.processId === processId)) {
      if (Date.now() >= deadline) throw new Error('process was not stored as live');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const entry = (manager as any).processes.get(processId);
    const mutex = entry.process.interactionLock as {
      lock(): Promise<() => void>;
      tryLock(): (() => void) | null;
    };

    const releaseFirst = await mutex.lock();
    const queuedSecond = mutex.lock();
    releaseFirst();

    // No await here on purpose: this is the exact handoff gap where a queued waiter already
    // exists but its continuation has not run yet. Tokio's try_lock cannot barge ahead of it.
    const stolen = mutex.tryLock();
    stolen?.();
    expect(stolen).toBeNull();

    const releaseSecond = await queuedSecond;
    releaseSecond();
  } finally {
    await manager.terminateProcess(processId);
    await initial.catch(() => undefined);
    await manager.terminateAllProcesses();
  }
});

it('refuses new capacity without evicting a completed unread result', async () => {
  const manager = new UnifiedExecProcessManager(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS);
  const unreadId = manager.allocateProcessId();
  const request = (processId: number, command: string, yieldTimeMs: number) => ({
    command: [process.execPath, '-e', command],
    shellType: process.platform === 'win32' ? ('powershell' as const) : ('bash' as const),
    hookCommand: 'capacity obligation probe',
    processId,
    yieldTimeMs,
    maxOutputTokens: undefined,
    truncationPolicy,
    cwd: process.cwd(),
    displayCwd: process.cwd(),
    env: applyUnifiedExecEnv(process.env),
    tty: false
  });
  const fillerIds: number[] = [];

  try {
    const started = await manager.execCommand(
      request(unreadId, "setTimeout(() => { console.log('owed-output'); process.exit(7); }, 500)", 100)
    );
    expect(started.processId).toBe(unreadId);
    await expect.poll(() => manager.backgroundState(new Set([unreadId])).exitedUnread).toEqual([
      { processId: unreadId, exitCode: 7 }
    ]);

    while (fillerIds.length < MAX_UNIFIED_EXEC_PROCESSES - 1) fillerIds.push(manager.allocateProcessId());
    const refusedId = manager.allocateProcessId();
    await expect(manager.execCommand(request(refusedId, "console.log('must-not-run')", 100))).rejects.toThrow(
      `too many retained terminal sessions (limit ${MAX_UNIFIED_EXEC_PROCESSES})`
    );

    expect(manager.backgroundState(new Set([unreadId])).exitedUnread).toEqual([
      { processId: unreadId, exitCode: 7 }
    ]);
    const drained = await manager.writeStdin({
      processId: unreadId,
      input: '',
      yieldTimeMs: 250,
      maxOutputTokens: undefined,
      truncationPolicy
    });
    expect(drained.rawOutput.toString('utf8')).toContain('owed-output');
    expect(drained.exitCode).toBe(7);
  } finally {
    for (const processId of fillerIds) manager.releaseProcessId(processId);
    await manager.terminateAllProcesses();
  }
});
