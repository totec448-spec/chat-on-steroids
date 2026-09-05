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

it('keeps an exited-unread result when the global session cap refuses a new launch', () => {
  const manager = new UnifiedExecProcessManager(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS);
  const retainedId = manager.allocateProcessId();
  const now = Date.now();

  // This tiny fake represents the exact manager state that matters: an exited entry whose
  // terminal result has not been consumed yet. The old capacity path deleted it to make room.
  const fakeExitedProcess = {
    hasExited: () => true,
    exitedAt: () => now,
    interactionLock: { tryLock: () => () => {} }
  };
  (manager as any).processes.set(retainedId, {
    process: fakeExitedProcess,
    processId: retainedId,
    cwd: '/retained',
    hookCommand: 'retained completed result',
    tty: false,
    initialExecCommandActive: false,
    startedAt: now,
    lastUsed: now
  });

  // retainedId already occupies one reservation. Fill the remaining 63 slots, then reserve
  // the candidate that would become the 65th. Capacity must reject that candidate rather than
  // deleting the completed result to make its reservation fit.
  for (let index = 1; index < MAX_UNIFIED_EXEC_PROCESSES; index++) manager.allocateProcessId();
  const rejectedId = manager.allocateProcessId();

  expect(() => (manager as any).ensureProcessCapacity(rejectedId)).toThrow(
    /too many retained or active terminal sessions/
  );
  expect(manager.backgroundState(retainedId)?.exitedUnread).toBe(true);
  expect((manager as any).processes.has(retainedId)).toBe(true);
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
      `too many retained or active terminal sessions (limit ${MAX_UNIFIED_EXEC_PROCESSES})`
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
