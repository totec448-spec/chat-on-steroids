import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * #1832 (Haz's review): the Goal step reviewer only reads. In its own chat every tool that is not
 * marked read-only is refused before it runs, apart from commands (it reads diffs and runs tests
 * with them, and is told not to change anything) and the agents tool it reports with. Any other
 * chat, a worker's included, keeps its tools.
 */
const ran = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../src/main/agents.js', async (original) => ({
  ...await original<typeof import('../src/main/agents.js')>(),
  isReviewerConversation: (conversationId: string | null | undefined) => conversationId === 'chat-reviewer',
  offerMessagesForCaller: () => null, acknowledgeOffersForCaller: () => null, noteAgentAlive: () => null, releaseQuiescentRun: () => undefined
}));
vi.mock('../src/main/session/recorder.js', async (original) => ({
  ...await original<typeof import('../src/main/session/recorder.js')>(),
  freshCallOrigin: (_tool: string, _at: number, request: string | null) => request?.startsWith('req-') ? request.slice(4) : null,
  recordToolCall: async () => null
}));
vi.mock('../src/main/session/store.js', async (original) => ({
  ...await original<typeof import('../src/main/session/store.js')>(), conversationAttachment: async () => 'current'
}));
vi.mock('../src/main/session/input.js', () => ({ offerToolInput: async () => ({ messages: [], reminder: '' }), acknowledgeToolInput: async () => undefined, TOOL_INPUT_HEADER: '\n--- New instructions from the user ---\n' }));
import { createRegistrar, ok } from '../src/main/mcp/kernel.js';
import { withInboundRequestId } from '../src/main/mcp/inbound.js';
import { defaultConfig } from '../src/main/config.js';

beforeEach(() => { ran.calls.length = 0; });

function tools() {
  const calls = new Map<string, (args: object) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>>();
  const server = { registerTool: (name: string, _schema: unknown, callback: (args: object) => Promise<never>) => { calls.set(name, callback); } };
  const caps = { ...defaultConfig().capabilities, edit: true, create: true, command: true };
  const registrar = createRegistrar(server as never, { roots: [], caps, readOnly: false }, 'core');
  const tool = (name: string, readOnly: boolean) => registrar.register(name, {
    description: name, inputSchema: z.object({ action: z.string().optional(), cmd: z.string().optional() }),
    ...(readOnly ? { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } } : {})
  }, async () => { ran.calls.push(name); return ok(`${name} ran`); });
  tool('apply_patch', false);
  tool('read_file', true);
  tool('exec_command', false);
  tool('agents', false);
  tool('click', false);
  return (name: string, chat: string, args: object = {}) => withInboundRequestId(`req-${chat}`, () => calls.get(name)!(args));
}

it('refuses every tool that changes things in the reviewer\'s own chat, before it runs', async () => {
  const call = tools();
  for (const name of ['apply_patch', 'click']) {
    const result = await call(name, 'chat-reviewer');
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(`TOOL_DISABLED: ${name} is not available to the Goal step reviewer`);
  }
  expect(ran.calls).toEqual([]);
});

it('lets the reviewer read, run commands and report', async () => {
  const call = tools();
  for (const name of ['read_file', 'exec_command']) expect((await call(name, 'chat-reviewer')).isError).not.toBe(true);
  for (const action of ['status', 'finish']) expect((await call('agents', 'chat-reviewer', { action })).isError).not.toBe(true);
  expect(ran.calls).toEqual(['read_file', 'exec_command', 'agents', 'agents']);
});

it('never lets the reviewer start or message other workers (Haz on #1879)', async () => {
  // A reviewer that could spawn or wake a worker could have another chat write the Goal's files.
  const call = tools();
  for (const action of ['spawn', 'message', undefined]) {
    const result = await call('agents', 'chat-reviewer', action ? { action } : {});
    expect(result.isError, String(action)).toBe(true);
    expect(result.content[0]!.text).toContain('TOOL_DISABLED: agents');
  }
  expect(ran.calls).toEqual([]);
  // Commands still run, writing ones included: the reviewer is told and documented to run tests, not to be read-only.
  expect((await call('exec_command', 'chat-reviewer', { cmd: 'npm test > report.txt' })).isError).not.toBe(true);
  expect(ran.calls).toEqual(['exec_command']);
  // Another chat keeps the agents tool whole.
  expect((await call('agents', 'chat-goal', { action: 'spawn' })).isError).not.toBe(true);
});

it('changes nothing for any other chat', async () => {
  const call = tools();
  expect((await call('apply_patch', 'chat-goal')).isError).not.toBe(true);
  expect(ran.calls).toEqual(['apply_patch']);
});

it('applies the same rule to plugin tools, by their own read-only mark', async () => {
  vi.resetModules();
  const pluginCalls: string[] = [];
  vi.doMock('../src/main/plugins/manager.js', () => ({ pluginManager: {
    tools: () => [
      { name: 'list_nodes', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'delete_node', inputSchema: { type: 'object' } }
    ],
    call: async (name: string) => { pluginCalls.push(name); return { content: [{ type: 'text', text: `${name} ran` }] }; },
    redactResult: (result: unknown) => result, redact: (value: unknown) => value
  } }));
  const { registerPluginTools } = await import('../src/main/mcp/tools-plugins.js');
  const { withInboundRequestId: inbound } = await import('../src/main/mcp/inbound.js');
  let callTool!: (request: { params: { name: string; arguments?: object } }, context: { sessionId?: string }) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
  const server = { server: {
    setRequestHandler: (method: string, handler: typeof callTool) => { if (method === 'tools/call') callTool = handler; },
    projectCallToolResult: (result: unknown) => result
  } };
  registerPluginTools(server as never);
  const call = (name: string, chat: string) => inbound(`req-${chat}`, () => callTool({ params: { name, arguments: {} } }, {}));
  const refused = await call('delete_node', 'chat-reviewer');
  expect(refused.isError).toBe(true);
  expect(refused.content[0]!.text).toContain('TOOL_DISABLED: delete_node is not available to the Goal step reviewer');
  expect((await call('list_nodes', 'chat-reviewer')).isError).not.toBe(true);
  expect((await call('delete_node', 'chat-goal')).isError).not.toBe(true);
  expect(pluginCalls).toEqual(['list_nodes', 'delete_node']);
});
