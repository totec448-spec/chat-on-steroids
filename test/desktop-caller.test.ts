import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * Desktop control never runs for a call the app cannot tie to a chat (2026-10-30). With one
 * ChatGPT account on two computers, a chat on the Windows test machine reached this Mac's
 * Desktop connector: the call carried no chat the Mac knew, "Allow unattributed calls" was on,
 * and it took a screenshot and moved the real pointer.
 */
const ui = vi.hoisted(() => ({ desktopUnattributed: undefined as boolean | undefined }));
vi.mock('../src/main/config.js', async original => {
  const real = await original<typeof import('../src/main/config.js')>();
  return { ...real, getConfig: () => {
    const config = real.defaultConfig();
    return { ...config, multiAgent: { ...config.multiAgent, allowUnattributedCalls: true }, ui: { ...config.ui, ...ui } };
  } };
});
const { runInCallContext, emptyEvidence } = await import('../src/main/mcp/call-context.js');
const { observeRequestCorrelation, resetCorrelationRegistryForTests } = await import('../src/main/session/correlation.js');
const { guardDesktopTools } = await import('../src/main/mcp/desktop-caller.js');
const { getLog } = await import('../src/main/logger.js');
type CallContext = import('../src/main/mcp/call-context.js').CallContext;
type SurfaceRegistrar = import('../src/main/mcp/kernel.js').SurfaceRegistrar;

function guarded() {
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  const ran: string[] = [];
  const reg = { register: (name: string, _config: unknown, handler: (args: unknown) => Promise<unknown>) => { handlers.set(name, handler); } } as unknown as SurfaceRegistrar;
  guardDesktopTools(reg).register('computer', { description: 'test', inputSchema: {} as never }, async () => {
    ran.push('computer');
    return { content: [{ type: 'text' as const, text: 'moved' }] };
  });
  const call = (caller: Partial<CallContext['caller']>) => runInCallContext({
    tool: 'computer', caller: { transportKey: null, requestId: null, conversationId: null, ...caller }, evidence: emptyEvidence()
  } as unknown as CallContext, () => handlers.get('computer')!({})) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  return { call, ran };
}

beforeEach(() => { ui.desktopUnattributed = undefined; resetCorrelationRegistryForTests(); });
afterEach(() => { vi.useRealTimers(); });

it('refuses a desktop call with no chat, even with Allow unattributed calls on, and touches nothing', async () => {
  const { call, ran } = guarded();
  const result = await call({});
  expect(ran).toEqual([]);
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain('DESKTOP_IDENTITY_REQUIRED');
  expect(result.content[0]!.text).toContain('could not tell which chat this computer call came from');
  expect(result.content[0]!.text).toContain('If the chat belongs to another computer');
  expect(getLog().some(entry => entry.message.includes('desktop: refused computer'))).toBe(true);
});

it('runs a desktop call from a known chat at once', async () => {
  const { call, ran } = guarded();
  expect((await call({ conversationId: 'chat-a', sessionId: 'session-a' })).isError).toBeUndefined();
  expect(ran).toEqual(['computer']);
});

it('waits for the page to prove a request that arrived before its evidence, then runs it', async () => {
  const { call, ran } = guarded();
  const pending = call({ requestId: 'late-request' });
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(ran).toEqual([]);
  observeRequestCorrelation({ requestId: 'late-request', conversationId: 'chat-a', sessionId: 'session-a', messageId: 'm1', tool: 'computer', observedAt: Date.now() });
  expect((await pending).isError).toBeUndefined();
  expect(ran).toEqual(['computer']);
  expect(getLog().some(entry => /desktop: computer waited \d+ ms for its request late-request to be tied to a chat, then ran/.test(entry.message))).toBe(true);
});

it('refuses a request no page ever proves once the evidence window has passed', async () => {
  vi.useFakeTimers();
  const { call, ran } = guarded();
  const pending = call({ requestId: 'other-computer' });
  await vi.advanceTimersByTimeAsync(20_001);
  const result = await pending;
  expect(result.isError).toBe(true);
  expect(ran).toEqual([]);
  expect(getLog().some(entry => entry.message.includes('desktop: refused computer') && entry.message.includes('other-computer'))).toBe(true);
});

it('runs an unattributed desktop call only when the person allowed it in Settings', async () => {
  ui.desktopUnattributed = true;
  const { call, ran } = guarded();
  expect((await call({})).isError).toBeUndefined();
  expect(ran).toEqual(['computer']);
});
