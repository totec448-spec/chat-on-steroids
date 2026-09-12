import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, createSession, readEvents, rebindSession, appendEvent, observeSessionModel, resetSessionStoreForTests } from '../src/main/session/store.js';
import { observeRequestCorrelation } from '../src/main/session/correlation.js';
import { flushRecorder } from '../src/main/session/recorder.js';
import { enqueueInput, listInputs, resetInputForTests } from '../src/main/session/input.js';
import { setChatBlocked, resetBlockedChatsForTests } from '../src/main/session/blocked-chats.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import type { ToolContext } from '../src/main/mcp/kernel.js';
import { currentCall } from '../src/main/mcp/call-context.js';
import * as backend from '../src/main/codex/read-backend.js';
import * as desktopBackend from '../src/main/computer/index.js';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { unifiedExecManager } from '../src/main/codex/manager.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string, endpoint: McpEndpoint, ctx: ToolContext;
async function rpc(method: string, params: object, requestId?: string, surface: 'core' | 'desktop' = 'core'): Promise<any> {
  const response = await fetch(endpoint.urls[surface], { method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream',
    ...(requestId ? { 'x-request-id': `${requestId}/attempt` } : {})
  }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
  const raw = await response.text();
  return JSON.parse(raw.startsWith('{') ? raw : [...raw.matchAll(/^data: (.+)$/gm)].at(-1)![1]!);
}
async function identity() {
  const conversationId = randomUUID(), requestId = `wfr_${randomUUID().replaceAll('-', '')}`;
  const session = await createSession({ conversationId, title: 'Code mode integration' });
  expect(observeRequestCorrelation({ requestId, conversationId, sessionId: session.id, messageId: randomUUID(), tool: 'exec', observedAt: Date.now() })).toBe('stored');
  return { conversationId, requestId, session };
}
const call = (requestId: string | undefined, code: string) => rpc('tools/call', { name: 'exec', arguments: { code } }, requestId);
const text = (response: any) => response.result.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n');

beforeAll(async () => {
  directory = await makeTempDir('clf-code-mode-mcp-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory); resetInputForTests();
  const config = defaultConfig();
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, enabled: false }, ui: { ...config.ui, finishTool: true } });
  await fs.writeFile(path.join(directory, 'alpha.txt'), 'alpha PRIVATE_ALPHA');
  await fs.writeFile(path.join(directory, 'beta.txt'), 'beta PRIVATE_BETA');
  ctx = { roots: [{ name: 'workspace', path: directory }], caps: config.capabilities, readOnly: false, sessionTools: true, agentTools: true };
  endpoint = await startMcpServer(() => ctx);
});
afterEach(async () => {
  vi.restoreAllMocks(); ctx.caps = defaultConfig().capabilities; ctx.roots = [{ name: 'workspace', path: directory }]; resetBlockedChatsForTests();
  const config = getConfig();
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, allowUnattributedCalls: true } });
});
afterAll(async () => {
  await endpoint.stop(); await unifiedExecManager.terminateAllProcesses(); await flushRecorder(); await flushDurable(); resetInputForTests(); resetSessionStoreForTests(); resetDurableForTests(); await removeTempDir(directory);
});

it('initializes, discovers and executes the actual model-facing MCP contract with parallel filtering and separate recorded children', async () => {
  const initialize = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'code-mode-contract-test', version: '1' } });
  expect(initialize.result.instructions).toContain('Code mode:');
  const declarations = (await rpc('tools/list', {})).result.tools;
  const exec = declarations.find((tool: any) => tool.name === 'exec');
  expect(exec.inputSchema.required).toEqual(['code']);
  expect(exec.inputSchema.additionalProperties).toBe(false);
  expect(declarations.some((tool: any) => tool.name === 'read')).toBe(true);
  const who = await identity();
  const original = backend.readTextFile;
  const contexts: Array<ReturnType<typeof currentCall>> = [];
  let entered = 0, release!: () => void;
  const both = new Promise<void>(done => { release = done; });
  vi.spyOn(backend, 'readTextFile').mockImplementation(async (...args) => {
    contexts.push(currentCall());
    if (++entered === 2) release();
    await both;
    return original(...args);
  });
  const response = await call(who.requestId, 'const r = await Promise.all(["alpha","beta"].map(n => tools.read({paths:["/workspace/"+n+".txt"]}))); text(r.map(x=>({ok:!x.isError, found:x.content.some(c=>c.text?.includes("PRIVATE"))})));');
  expect(response.result.isError).not.toBe(true);
  expect(JSON.parse(text(response))).toEqual([{ ok: true, found: true }, { ok: true, found: true }]);
  expect(JSON.stringify(response)).not.toContain('PRIVATE');
  expect(contexts).toHaveLength(2);
  expect(contexts[0]).not.toBe(contexts[1]);
  expect(contexts[0]!.evidence).not.toBe(contexts[1]!.evidence);
  for (const context of contexts) expect(context!.caller).toMatchObject({ requestId: who.requestId, conversationId: who.conversationId, sessionId: who.session.id });
  const events = (await readEvents(who.session.id)).filter(event => event.kind === 'tool_call');
  expect(events.map(event => event.call.tool).sort()).toEqual(['exec', 'read', 'read']);
  expect(new Set(events.map(event => event.call.callId)).size).toBe(3);
  expect(JSON.stringify(events.filter(event => event.call.tool === 'read'))).toContain('PRIVATE_ALPHA');
  expect(JSON.stringify(events.filter(event => event.call.tool === 'exec'))).not.toContain('PRIVATE_ALPHA');
});

it.runIf(process.platform === 'win32').each([true, false])('routes sky through Desktop MCP with attributed=%s, retaining observation and live permissions', async attributed => {
  const who = attributed ? await identity() : { requestId: undefined, session: { id: null } };
  const window = { id: 77, app: 'fixture.exe', title: 'Owned fixture', process: 'fixture', x: 0, y: 0, width: 2, height: 2, dpi: 96 };
  const data = (await sharp({ create: { width: 2, height: 2, channels: 3, background: 'green' } }).png().toBuffer()).toString('base64');
  const callers: Array<string | null | undefined> = [];
  vi.spyOn(desktopBackend, 'listWindows').mockImplementation(async () => {
    callers.push(currentCall()!.caller.sessionId!);
    return { windows: [window], screen: { x: 0, y: 0, width: 2, height: 2 } } as never;
  });
  vi.spyOn(desktopBackend, 'getWindowState').mockResolvedValue({ window, elements: [{ ref: 'fixture-ref', role: 'Button', name: 'Owned button', actions: ['invoke'] }],
    screenshot: { frameId: 1, data, windowId: 77, region: { x: 0, y: 0, width: 2, height: 2 }, scale: 1 }, related: []
  } as never);
  const action = vi.spyOn(desktopBackend, 'act').mockImplementation(async () => {
    callers.push(currentCall()!.caller.sessionId!);
    return { completedCount: 1, routes: ['uia'], cursor: null, clipboard: [] };
  });
  const observed = await rpc('tools/call', { name: 'exec', arguments: { code: 'const window = (await sky.list_windows())[0]; const state = await sky.get_window_state({window,include_text:true}); nodeRepl.write({window:state.window,tree:state.accessibility.tree});' } }, who.requestId, 'desktop');
  expect(observed.result.isError, text(observed)).not.toBe(true);
  expect(observed.result.content.filter((item: any) => item.type === 'image')).toHaveLength(1);
  expect(text(observed)).toContain('0: Button');
  const publicWindow = { app: window.app, id: window.id, title: window.title };
  const clicked = await rpc('tools/call', { name: 'exec', arguments: { code: `await sky.click({window:${JSON.stringify(publicWindow)},element_index:0}); text("accepted");` } }, who.requestId, 'desktop');
  expect(text(clicked)).toBe('accepted');
  expect(action).toHaveBeenCalledExactlyOnceWith([{ type: 'click_ref', ref: 'fixture-ref', button: 'left', count: 1 }], { window: 77, app: 'fixture.exe' });
  expect(callers).toEqual([who.session.id, who.session.id]);
  ctx.caps = { ...ctx.caps, control: false };
  const revoked = await rpc('tools/call', { name: 'exec', arguments: { code: `await sky.activate_window({window:${JSON.stringify(publicWindow)}}); text("should not run");` } }, who.requestId, 'desktop');
  expect(revoked.result.isError).toBe(true);
  expect(text(revoked)).toContain('TOOL_DISABLED');
  expect(text(revoked)).not.toContain('should not run');
  expect(action).toHaveBeenCalledTimes(1);
  if (who.session.id) {
    const names = (await readEvents(who.session.id)).filter(event => event.kind === 'tool_call').map(event => event.call.tool);
    expect(names).toEqual(expect.arrayContaining(['list_windows', 'get_window_state', 'click', 'activate_window', 'exec']));
  }
});

it.runIf(process.platform === 'win32')('prints a complete Desktop state without serializing screenshot bytes as text or losing its images', async () => {
  const who = await identity();
  const window = { id: 78, app: 'fixture.exe', title: 'Observation fixture', process: 'fixture', state: 'open', x: 0, y: 0, width: 320, height: 200, dpi: 96 };
  const data = (await sharp(randomBytes(320 * 200 * 3), { raw: { width: 320, height: 200, channels: 3 } }).png().toBuffer()).toString('base64');
  expect(data.length).toBeGreaterThan(40_000);
  vi.spyOn(desktopBackend, 'getWindowState').mockResolvedValue({ window, elements: [], uiUnavailable: null,
    screenshot: { frameId: 1, data, width: 320, height: 200, focused: false, windowId: 78, region: { x: 0, y: 0, width: 320, height: 200 }, scale: 1 }, related: []
  } as never);
  const args = { window: { app: window.app, id: window.id }, include_text: true };
  const direct = await rpc('tools/call', { name: 'get_window_state', arguments: args }, who.requestId, 'desktop');
  expect(direct.result.isError, text(direct)).not.toBe(true);
  for (const expression of ['text(state)', 'text(JSON.stringify(state))']) {
    const observed = await rpc('tools/call', { name: 'exec', arguments: { code: `const state = await sky.get_window_state(${JSON.stringify(args)}); ${expression};` } }, who.requestId, 'desktop');
    expect(observed.result.isError, text(observed)).not.toBe(true);
    expect(observed.result.content.filter((item: any) => item.type === 'image')).toEqual([{ type: 'image', mimeType: 'image/png', data }]);
    expect(JSON.parse(text(observed))).toEqual(direct.result.structuredContent.value);
    expect(text(observed)).not.toContain('base64');
  }
  expect('url' in direct.result.structuredContent.value.screenshots[0]).toBe(false);
  expect(JSON.stringify(direct.result).split(data)).toHaveLength(2);
});

it('delivers completed terminal output on the outer result even when code filters every child response', async () => {
  const who = await identity();
  await fs.writeFile(path.join(directory, 'auto-result.cjs'), 'setTimeout(()=>{console.log("OUTER_AUTO_RESULT");process.exitCode=7},1000);');
  const command = process.platform === 'win32' ? 'node auto-result.cjs; exit $LASTEXITCODE' : 'node auto-result.cjs';
  const started = await call(who.requestId, `text(await tools.exec_command({cmd:${JSON.stringify(command)},workdir:"/workspace",yield_time_ms:25}));`);
  const id = Number(text(started).match(/Process running with session ID (\d+)/)?.[1]);
  expect(Number.isInteger(id), text(started)).toBe(true);
  await vi.waitFor(() => expect(unifiedExecManager.exitedUnread(new Set([id]))).toHaveLength(1), { timeout: 5_000 });
  const full = await call(who.requestId, 'text("x".repeat(39_900));');
  expect(Buffer.byteLength(text(full)), text(full).slice(0, 400)).toBe(39_900);
  expect(text(full)).not.toContain('OUTER_AUTO_RESULT');
  expect(unifiedExecManager.exitedUnread(new Set([id]))).toHaveLength(1);
  const response = await call(who.requestId, 'await Promise.all([tools.read({paths:["/workspace/alpha.txt"]}),tools.read({paths:["/workspace/beta.txt"]})]); text("filtered children");');
  expect(text(response)).toContain('OUTER_AUTO_RESULT');
  expect(text(response)).toContain('Exit code: 7');
  expect(text(response)).not.toContain('PRIVATE_ALPHA');
  expect(text(response).match(/Background session/g)).toHaveLength(1);
  const receipt = await call(who.requestId, 'text("receipt");');
  expect(text(receipt)).not.toContain('OUTER_AUTO_RESULT');
  expect(unifiedExecManager.exitedUnread(new Set([id]))).toEqual([]);
});

it('rejects missing proof, foreign tools, invalid child arguments and nested lifecycle calls', async () => {
  const config = getConfig();
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, allowUnattributedCalls: false } });
  expect(text(await call(undefined, 'text("SHOULD_NOT_RUN")'))).toContain('CALLER_IDENTITY_REQUIRED');
  const who = await identity();
  expect(text(await call(who.requestId, 'text([typeof tools.computer,typeof tools.exec])'))).toBe('["undefined","undefined"]');
  expect(text(await call(who.requestId, 'text(await tools.read({paths:1}))'))).toContain('INVALID_ARGUMENTS');
  for (const code of ['text(await tools.session_finish({summary:"done"}))', 'text(await tools.agents({action:"finish",summary:"done"}))']) {
    expect(text(await call(who.requestId, code))).toContain('DIRECT_CALL_REQUIRED');
  }
});

it('allows unattributed file edits through code mode while preserving permissions and chat-owned operations', async () => {
  const patch = '*** Begin Patch\n*** Add File: /workspace/unattributed.txt\n+created anonymously\n*** End Patch';
  const response = await call(undefined, `text(await tools.apply_patch({patch:${JSON.stringify(patch)}}));`);
  expect(response.result.isError, text(response)).not.toBe(true);
  expect(JSON.parse(text(response)).isError).not.toBe(true);
  expect(await fs.readFile(path.join(directory, 'unattributed.txt'), 'utf8')).toBe('created anonymously\n');
  const read = await call(`wfr_${randomUUID().replaceAll('-', '')}`, 'text(await tools.read({paths:["/workspace/unattributed.txt"]}));');
  expect(text(read)).toContain('created anonymously');
  const edit = '*** Begin Patch\n*** Update File: /workspace/unattributed.txt\n@@\n-created anonymously\n+edited anonymously\n*** End Patch';
  const edited = await call(undefined, `text(await tools.apply_patch({patch:${JSON.stringify(edit)}}));`);
  expect(JSON.parse(text(edited)).isError).not.toBe(true);
  expect(await fs.readFile(path.join(directory, 'unattributed.txt'), 'utf8')).toBe('edited anonymously\n');
  ctx.caps = { ...ctx.caps, edit: false };
  const deniedPatch = edit.replace('-created anonymously', '-edited anonymously').replace('+edited anonymously', '+must not change');
  const denied = await call(undefined, `text(await tools.apply_patch({patch:${JSON.stringify(deniedPatch)}}));`);
  expect(JSON.parse(text(denied)).isError).toBe(true);
  expect(await fs.readFile(path.join(directory, 'unattributed.txt'), 'utf8')).toBe('edited anonymously\n');
  const plan = await call(undefined, 'text(await tools.update_plan({plan:[{step:"Anonymous plan",status:"in_progress"}]}));');
  expect(JSON.parse(text(plan)).isError).toBe(true);
  const finish = await rpc('tools/call', { name: 'session_finish', arguments: { summary: 'done' } });
  expect(finish.result.isError).toBe(true);
  expect(text(finish)).toContain('Exact session identity');
  const config = getConfig();
  try {
    await saveConfig({ ...config, multiAgent: { ...config.multiAgent, enabled: true } });
    const spawn = await call(undefined, 'text(await tools.agents({action:"spawn",workers:[{task:"Must never start"}]}));');
    expect(JSON.parse(text(spawn)).isError).toBe(true);
    expect(text(spawn)).toContain('UNIDENTIFIED_CALLER');
  } finally {
    await saveConfig(config);
  }
});

it('rechecks live permissions and approved roots between awaited children', async () => {
  const original = backend.readTextFile;
  for (const revoke of [() => { ctx.caps = { ...ctx.caps, read: false }; }, () => { ctx.roots = []; }]) {
    const who = await identity();
    ctx.caps = defaultConfig().capabilities; ctx.roots = [{ name: 'workspace', path: directory }];
    vi.spyOn(backend, 'readTextFile').mockImplementationOnce(async (...args) => { const result = await original(...args); revoke(); return result; });
    const response = await call(who.requestId, 'await tools.read({paths:["/workspace/alpha.txt"]}); text(await tools.read({paths:["/workspace/beta.txt"]}));');
    const direct = await rpc('tools/call', { name: 'read', arguments: { paths: ['/workspace/beta.txt'] } }, who.requestId);
    expect(JSON.parse(text(response))).toEqual(direct.result);
    expect(text(response)).not.toContain('PRIVATE_BETA');
    vi.restoreAllMocks();
  }
});

it('rechecks a block or superseded chat before the next nested action', async () => {
  const original = backend.readTextFile;
  for (const superseded of [false, true]) {
    const who = await identity();
    vi.spyOn(backend, 'readTextFile').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      if (superseded) expect(await rebindSession(who.session.id, who.conversationId, randomUUID())).toBe(true);
      else setChatBlocked(who.conversationId, true);
      return result;
    });
    const response = await call(who.requestId, 'await tools.read({paths:["/workspace/alpha.txt"]}); text(await tools.read({paths:["/workspace/beta.txt"]}));');
    expect(text(response)).toContain(superseded ? 'CONVERSATION_SUPERSEDED' : 'CHAT_BLOCKED');
    expect(text(response)).not.toContain('PRIVATE_BETA');
    vi.restoreAllMocks(); resetBlockedChatsForTests();
  }
});

it('keeps simultaneous chats separate and delivers queued input once outside script filtering', async () => {
  const a = await identity(), b = await identity();
  await observeSessionModel(a.session.id, a.conversationId, 'gpt-6-astra', Date.now());
  await appendEvent(a.session.id, { kind: 'turn_start', source: 'extension', turnId: randomUUID(), time: Date.now() });
  const input = await enqueueInput({ id: randomUUID(), sessionId: a.session.id, text: 'PRIVATE_USER_INSTRUCTION', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  const original = backend.readTextFile;
  const observed: string[] = [];
  vi.spyOn(backend, 'readTextFile').mockImplementation(async (...args) => {
    observed.push(currentCall()!.caller.sessionId!);
    expect((await listInputs()).find(row => row.id === input.id)?.state).toBe('queued');
    return original(...args);
  });
  const [ra, rb] = await Promise.all([a, b].map(who => call(who.requestId, 'await tools.read({paths:["/workspace/alpha.txt"]}); await tools.read({paths:["/workspace/beta.txt"]}); text("filtered");')));
  expect(observed.filter(id => id === a.session.id)).toHaveLength(2);
  expect(observed.filter(id => id === b.session.id)).toHaveLength(2);
  expect(text(ra).match(/PRIVATE_USER_INSTRUCTION/g)).toHaveLength(1);
  expect(text(rb)).toBe('filtered');
  expect((await listInputs()).find(row => row.id === input.id)?.state).toBe('tool');
  vi.restoreAllMocks();
  const receipt = await call(a.requestId, 'text("received")');
  expect(text(receipt)).not.toContain('PRIVATE_USER_INSTRUCTION');
  expect((await listInputs()).find(row => row.id === input.id)?.state).toBe('sent');
});

it('uses existing process custody for nested exec and write_stdin across a conversation rebind', async () => {
  const a = await identity(), stranger = await identity();
  await fs.writeFile(path.join(directory, 'owned.cjs'), 'process.stdin.once("data",()=>{console.log("OWNED_RESULT");process.exit(0)});');
  const started = await call(a.requestId, 'text(await tools.exec_command({cmd:"node owned.cjs",workdir:"/workspace",tty:true,yield_time_ms:25}));');
  const processId = Number(text(started).match(/Process running with session ID (\d+)/)?.[1]);
  expect(Number.isInteger(processId), text(started)).toBe(true);
  const denied = await call(stranger.requestId, `text(await tools.write_stdin({session_id:${processId},chars:"stolen\\r",yield_time_ms:50}));`);
  expect(text(denied)).toContain('not proven to belong to this durable');
  const replacement = randomUUID(), requestId = `wfr_${randomUUID().replaceAll('-', '')}`;
  expect(await rebindSession(a.session.id, a.conversationId, replacement)).toBe(true);
  observeRequestCorrelation({ requestId, conversationId: replacement, sessionId: a.session.id, messageId: randomUUID(), tool: 'exec', observedAt: Date.now() });
  const continued = await call(requestId, `text(await tools.write_stdin({session_id:${processId},chars:"owner\\r",yield_time_ms:1000}));`);
  expect(text(continued)).toContain('OWNED_RESULT');
});
