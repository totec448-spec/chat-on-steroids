import { afterEach, expect, it } from 'vitest';
import { UnifiedExecProcessManager, applyUnifiedExecEnv, type OutputPublication } from '../src/main/codex/unified-exec.js';

const managers: UnifiedExecProcessManager[] = [];
const policy = { kind: 'tokens' as const, tokens: 10_000 };
const publication = (): OutputPublication => ({ completedAt: null, failed: false });
afterEach(async () => { await Promise.all(managers.splice(0).map(m => m.terminateAllProcesses())); });

async function child(output: string, exitCode = 7) {
  const manager = new UnifiedExecProcessManager(60_000);
  managers.push(manager);
  const id = manager.allocateProcessId();
  const initial = await manager.execCommand({
    command: [process.execPath, '-e', `setTimeout(() => { process.stdout.write(${JSON.stringify(output)}); process.exitCode = ${exitCode}; }, 650)`],
    shellType: process.platform === 'win32' ? 'powershell' : 'bash', hookCommand: 'delivery fixture', processId: id,
    yieldTimeMs: 250, maxOutputTokens: undefined, truncationPolicy: policy, cwd: process.cwd(), displayCwd: process.cwd(),
    env: applyUnifiedExecEnv(process.env), tty: false
  });
  expect(initial.processId).toBe(id);
  const owned = new Set([id]);
  expect(await manager.offerCompletedOutput(owned, publication(), 100)).toBeNull();
  await expect.poll(() => manager.backgroundState(owned).exitedUnread, { timeout: 5_000 }).toHaveLength(1);
  return { manager, id, owned };
}

it('retains a failed publication, rejects concurrent receipts, and retires only after a later successful receipt', async () => {
  const { manager, owned, id } = await child('complete-result');
  expect(await manager.offerCompletedOutput(new Set([id + 1]), publication(), 100)).toBeNull();
  const failed = publication();
  const first = await manager.offerCompletedOutput(owned, failed, 100);
  expect(first).toMatchObject({ processId: id, output: 'complete-result', exitCode: 7 });
  expect(await manager.acknowledgeCompletedOutput(owned, Date.now() + 100)).toEqual([]);
  expect(await manager.offerCompletedOutput(owned, publication(), 100)).toBeNull();
  failed.failed = true;
  failed.completedAt = 100;
  expect(await manager.acknowledgeCompletedOutput(owned, 101)).toEqual([]);
  const success = publication();
  expect(await manager.offerCompletedOutput(owned, success, 100)).toEqual(first);
  success.completedAt = 200;
  expect(await manager.acknowledgeCompletedOutput(owned, 200)).toEqual([]);
  expect(await manager.acknowledgeCompletedOutput(new Set(), 201)).toEqual([]);
  expect(await manager.acknowledgeCompletedOutput(owned, 201)).toEqual([id]);
  expect(manager.backgroundState(owned).exitedUnread).toEqual([]);
});

it('pages large Unicode results without loss and gives an explicit poll only the unacknowledged suffix', async () => {
  const output = '😀ä漢字\n'.repeat(2_000);
  const { manager, owned, id } = await child(output);
  const firstResponse = publication();
  const first = (await manager.offerCompletedOutput(owned, firstResponse, 301))!;
  expect(Buffer.byteLength(first.output)).toBeLessThanOrEqual(301);
  expect(first.output).not.toContain('\ufffd');
  firstResponse.completedAt = 100;
  expect(await manager.acknowledgeCompletedOutput(owned, 101)).toEqual([]);
  const next = (await manager.offerCompletedOutput(owned, publication(), 301))!;
  expect(next.start).toBe(first.end);
  const polled = await manager.writeStdin({ processId: id, input: '', yieldTimeMs: 1, maxOutputTokens: undefined, truncationPolicy: policy });
  expect(first.output + polled.rawOutput.toString('utf8')).toBe(output);
  expect(polled.exitCode).toBe(7);
  expect(polled.processId).toBeNull();
  expect(await manager.offerCompletedOutput(owned, publication(), 100)).toBeNull();
});

it('delivers every bounded page and an empty successful result before retirement', async () => {
  for (const output of ['🙂'.repeat(2_000), '']) {
    const { manager, owned, id } = await child(output, 0);
    let received = '';
    let retired: number[] = [];
    while (!retired.length) {
      const response = publication();
      const page = (await manager.offerCompletedOutput(owned, response, 503))!;
      expect(page).not.toBeNull();
      expect(page.exitCode).toBe(0);
      expect(Buffer.byteLength(page.output)).toBeLessThanOrEqual(503);
      received += page.output;
      response.completedAt = 100;
      retired = await manager.acknowledgeCompletedOutput(owned, 101);
    }
    expect(retired).toEqual([id]);
    expect(received).toBe(output);
  }
});
