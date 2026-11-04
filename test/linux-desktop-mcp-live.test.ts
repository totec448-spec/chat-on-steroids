/** Opt-in live HTTP/GUI acceptance: COS_LINUX_DESKTOP_LIVE=1 npx vitest run test/linux-desktop-mcp-live.test.ts */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultConfig, effectiveCapabilities, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import { createSession, flushSessions, initSessionStore } from '../src/main/session/store.js';
import { observeRequestCorrelation } from '../src/main/session/correlation.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { pluginManager } from '../src/main/plugins/manager.js';
import { runLinuxDesktop } from '../src/main/computer/linux-agent-desktop.js';
import { MAX_VIEW_IMAGE_BYTES, validateImageBytes } from '../src/main/codex/view-image.js';
import sharp from 'sharp';

// Only the deliberately gated authorization tests below replace the Ask
// decision with a controlled deferred result. Its actual MCP authorization,
// native GTK delivery and after-wait revalidation remain production code.
// This does NOT prove the human-facing Electron Desktop Ask overlay itself.
const deferredAsk = vi.hoisted(() => ({
  enabled: false,
  denyLate: false,
  resolve: null as null | ((value: string | null) => void)
}));
vi.mock('../src/main/desktop-ask-window.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/main/desktop-ask-window.js')>();
  return {
    ...original,
    askBeforeDesktopStep: (...args: Parameters<typeof original.askBeforeDesktopStep>) =>
      !deferredAsk.enabled ? original.askBeforeDesktopStep(...args)
        : deferredAsk.denyLate ? Promise.resolve('DESKTOP_ASK_DENIED: test cleanup')
        : new Promise<string | null>(resolve => { deferredAsk.resolve = resolve; })
  };
});

const LIVE = process.env.COS_LINUX_DESKTOP_LIVE === '1' && process.platform === 'linux';
// Explicitly separate opt-in: ordinary live input acceptance never requests a
// full-display screenshot, and a GNOME portal refusal is never auto-retried.
const LIVE_SCREENSHOT = process.env.COS_LINUX_SCREENSHOT_LIVE === '1';
const TITLE = 'CoS Linux Desktop E2E Fixture';
const DECOY_TITLE = 'CoS Linux Desktop E2E Decoy';
const CHAT = 'cos-linux-live-fixture-chat';
const MESSAGE = 'CoS MCP transport verified';
let scratch: string;
let fixture: ChildProcessWithoutNullStreams;
let decoy: ChildProcessWithoutNullStreams;
let endpoint: McpEndpoint;
let sessionId: string;
let windowsPid: number;
let fixtureOutput = '';
let decoyOutput = '';
let rpcId = 0;

async function call(method: string, name?: string, args?: unknown, caller?: { conversationId: string; sessionId: string }): Promise<any> {
  const requestId = `coslinuxlive${++rpcId}`;
  if (name) observeRequestCorrelation({
    requestId, conversationId: caller?.conversationId ?? CHAT, sessionId: caller?.sessionId ?? sessionId,
    messageId: `test-message-${rpcId}`, tool: name, observedAt: Date.now()
  });
  const response = await fetch(endpoint.urls.desktop, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-request-id': requestId },
    body: JSON.stringify({jsonrpc: '2.0', id: rpcId, method, params: name ? { name, arguments: args } : {}})
  });
  const raw = await response.text();
  const payload = raw.match(/^data:\s*(.+)$/m)?.[1] ?? raw;
  const answer = JSON.parse(payload);
  if (name === 'linux_observe' && (args as { what?: string } | undefined)?.what === 'screenshot' &&
      (response.status !== 200 || answer.error)) {
    throw new Error(`Private screenshot MCP HTTP returned a transport failure (status ${response.status}); no response body was logged.`);
  }
  if (response.status !== 200 || answer.error) throw new Error(`HTTP ${response.status}: ${JSON.stringify(answer.error ?? answer).slice(0, 1200)}`);
  return answer.result;
}
function text(result: any): string {
  return (result.content as Array<{type: string; text?: string}>).filter(row => row.type === 'text').map(row => row.text ?? '').join('\n');
}
function ref(result: any, wanted: { role: string; name: string }): string {
  const data = JSON.parse(text(result));
  expect(data.complete).toBe(true);
  function visit(node: any, refs: string[] = []): string[] {
    if (node?.role === wanted.role && node?.name === wanted.name && node?.ref_id) refs.push(node.ref_id);
    for (const child of node?.children ?? []) visit(child, refs);
    return refs;
  }
  const refs = visit(data.tree);
  expect(refs).toHaveLength(1);
  return refs[0]!;
}
async function windowId(): Promise<string> {
  return windowIdFor(TITLE, windowsPid);
}
async function windowIdFor(title: string, pid: number): Promise<string> {
  // GTK can emit E2E_READY before AT-SPI has published the accessible window.
  // Wait only for our exact fixture title + PID; never fall back to another app.
  const deadline = Date.now() + 15_000;
  while (true) {
    const result = await runLinuxDesktop({ kind: 'windows' });
    if (result.ok && Array.isArray(result.data)) {
      const own = result.data.filter((row: any) => row.title === title && row.pid === pid && row.accessible === true);
      if (own.length === 1) return (own[0] as { id: string }).id;
      if (own.length > 1) throw new Error('Ambiguous GTK test fixture window');
    }
    if (Date.now() >= deadline) throw new Error('GTK test fixture did not become accessible before the deadline');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

// Normal repository verification never launches a window or changes desktop state.
describe.skipIf(!LIVE)('real Linux MCP HTTP and semantic desktop acceptance (explicit opt-in only)', () => {
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'cos-linux-mcp-e2e-'));
    initConfigPath(scratch);
    initDurableStore(scratch);
    initSessionStore(scratch);
    const initial = defaultConfig('linux');
    await saveConfig({
      ...initial, roots: [], readOnly: false,
      capabilities: { ...initial.capabilities, screen: true, control: true },
      multiAgent: { ...initial.multiAgent, enabled: false, allowUnattributedCalls: false },
      ui: { ...initial.ui, linuxDesktopEnabled: true, desktopUnattributed: false, desktopAsk: 'off' }
    });
    const session = await createSession({ title: 'Isolated Linux MCP E2E', conversationId: CHAT });
    sessionId = session.id;
    await pluginManager.initialize(scratch);
    fixture = spawn('/usr/bin/python3', ['-u', 'test/fixtures/linux-desktop-e2e.py'], {
      cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe']
    });
    windowsPid = fixture.pid!;
    fixture.stdout.on('data', chunk => { fixtureOutput += chunk.toString(); });
    fixture.stderr.on('data', chunk => { fixtureOutput += chunk.toString(); });
    decoy = spawn('/usr/bin/python3', ['-u', 'test/fixtures/linux-desktop-e2e.py'], {
      cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, COS_LINUX_E2E_TITLE: DECOY_TITLE }
    });
    decoy.stdout.on('data', chunk => { decoyOutput += chunk.toString(); });
    decoy.stderr.on('data', chunk => { decoyOutput += chunk.toString(); });
    const cutoff = Date.now() + 10_000;
    while ((!fixtureOutput.includes('E2E_READY') || !decoyOutput.includes('E2E_READY')) && Date.now() < cutoff)
      await new Promise(resolve => setTimeout(resolve, 100));
    expect(fixtureOutput).toContain('E2E_READY');
    expect(decoyOutput).toContain('E2E_READY');
    await windowId();
    await windowIdFor(DECOY_TITLE, decoy.pid!);
    endpoint = await startMcpServer(() => ({
      roots: [], caps: effectiveCapabilities(getConfig()), readOnly: getConfig().readOnly,
      setupProfileId: 'default', exposedLinuxDesktop: true, sessionTools: false, agentTools: false
    }));
  }, 40_000);

  afterAll(async () => {
    if (endpoint) await endpoint.stop();
    for (const process of [fixture, decoy]) {
      if (process && process.exitCode === null) {
        process.kill('SIGTERM');
        await new Promise(resolve => { process.once('exit', resolve); setTimeout(resolve, 2000); });
      }
    }
    await pluginManager.close();
    await flushSessions();
    await flushDurable();
    resetDurableForTests();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it('advertises the opt-in Linux Desktop tools on the real Desktop surface', async () => {
    const names = ((await call('tools/list')).tools as Array<{name: string}>).map(tool => tool.name);
    expect(names).toContain('linux_observe');
    expect(names).toContain('linux_act');
  });

  it('refuses native observations and actions with the Linux Desktop opt-in disabled', async () => {
    const current = getConfig();
    try {
      await saveConfig({ ...current, ui: { ...current.ui, linuxDesktopEnabled: false } });
      const deniedObserve = await call('tools/call', 'linux_observe', { what: 'snapshot', window_id: await windowId() });
      expect(deniedObserve.isError).toBe(true);
      expect(text(deniedObserve)).toContain('LINUX_DESKTOP_DISABLED');
      const deniedAct = await call('tools/call', 'linux_act', { action: 'click', ref: '@sNeverIssued:e1' });
      expect(deniedAct.isError).toBe(true);
      expect(text(deniedAct)).toContain('LINUX_DESKTOP_DISABLED');
    } finally { await saveConfig(current); }
    expect(fixtureOutput).not.toContain('E2E_RESULT=');
  });

  it('rejects actions when Control is not granted, even if Screen permits observation', async () => {
    const current = getConfig();
    try {
      await saveConfig({ ...current, capabilities: { ...current.capabilities, control: false } });
      const observed = await call('tools/call', 'linux_observe', { what: 'snapshot', window_id: await windowId() });
      expect(observed.isError).not.toBe(true);
      const validRef = ref(observed, { role: 'button', name: 'Apply test message' });
      const denied = await call('tools/call', 'linux_act', { action: 'click', ref: validRef });
      expect(denied.isError).toBe(true);
      expect(text(denied)).toContain('TOOL_DISABLED');
    } finally { await saveConfig(current); }
    expect(fixtureOutput).not.toContain('E2E_RESULT=');
  });

  it('refuses live Control revocation after observation and refuses an unrelated chat or ref', async () => {
    const id = await windowId();
    const observed = await call('tools/call', 'linux_observe', { what: 'snapshot', window_id: id });
    expect(observed.isError).not.toBe(true);
    const validRef = ref(observed, { role: 'button', name: 'Apply test message' });
    const foreign = await call('tools/call', 'linux_act', { action: 'click', ref: validRef },
      { conversationId: 'not-the-owning-chat', sessionId });
    expect(foreign.isError).toBe(true);
    expect(text(foreign)).toContain('STALE_OR_FOREIGN_REF');
    const invalidRef = await call('tools/call', 'linux_act', { action: 'click', ref: '@sUnrelated:e999' });
    expect(invalidRef.isError).toBe(true);
    expect(text(invalidRef)).toContain('STALE_OR_FOREIGN_REF');
    const current = getConfig();
    try {
      await saveConfig({ ...current, capabilities: { ...current.capabilities, control: false } });
      const revoked = await call('tools/call', 'linux_act', { action: 'click', ref: validRef });
      expect(revoked.isError).toBe(true);
      expect(text(revoked)).toContain('TOOL_DISABLED');
    } finally { await saveConfig(current); }
    expect(fixtureOutput).not.toContain('E2E_RESULT=');
  });

  it('refuses stale refs from a different real GTK window after observing the second window', async () => {
    const first = await call('tools/call', 'linux_observe', { what: 'snapshot', window_id: await windowId() });
    expect(first.isError).not.toBe(true);
    const firstRef = ref(first, { role: 'button', name: 'Apply test message' });
    const other = await call('tools/call', 'linux_observe', {
      what: 'snapshot', window_id: await windowIdFor(DECOY_TITLE, decoy.pid!)
    });
    expect(other.isError).not.toBe(true);
    const secondRef = ref(other, { role: 'button', name: 'Apply test message' });
    expect(secondRef).not.toBe(firstRef);
    const denied = await call('tools/call', 'linux_act', { action: 'click', ref: firstRef });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain('STALE_OR_FOREIGN_REF');
    expect(fixtureOutput).not.toContain('E2E_RESULT=');
    expect(decoyOutput).not.toContain('E2E_RESULT=');
  });

  it('rechecks live Control authority after a simulated delayed Ask approval', async () => {
    const id = await windowId();
    const observed = await call('tools/call', 'linux_observe', { what: 'snapshot', window_id: id });
    const validRef = ref(observed, { role: 'button', name: 'Apply test message' });
    const previous = getConfig();
    deferredAsk.enabled = true;
    let pending: Promise<any> | null = null;
    try {
      pending = call('tools/call', 'linux_act', { action: 'click', ref: validRef });
      await vi.waitFor(() => expect(deferredAsk.resolve).not.toBeNull(), { timeout: 10_000 });
      await saveConfig({ ...previous, capabilities: { ...previous.capabilities, control: false } });
      deferredAsk.resolve!(null); // Simulated approval after the person waited.
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('TOOL_DISABLED');
      expect(fixtureOutput).not.toContain('E2E_RESULT=');
    } finally {
      // A failed assertion or saveConfig must not strand an MCP request in Ask.
      // Deny any Ask that starts during cleanup, then drain the request.
      deferredAsk.denyLate = true;
      deferredAsk.resolve?.('DESKTOP_ASK_DENIED: test cleanup');
      try {
        if (pending) await pending.catch(() => undefined);
      } finally {
        deferredAsk.enabled = false;
        deferredAsk.denyLate = false;
        deferredAsk.resolve = null;
        await saveConfig(previous);
      }
    }
  });

  it('delivers GTK input only after a simulated explicit Ask grant and refuses a denial', async () => {
    const id = await windowId();
    deferredAsk.enabled = true;
    let pending: Promise<any> | null = null;
    try {
      const first = await call('tools/call', 'linux_observe', { what: 'snapshot', window_id: id });
      const firstRef = ref(first, { role: 'textfield', name: 'Test message' });
      const rejected = call('tools/call', 'linux_act', { action: 'set_value', ref: firstRef, value: 'DENIED_INPUT' });
      pending = rejected;
      await vi.waitFor(() => expect(deferredAsk.resolve).not.toBeNull(), { timeout: 10_000 });
      expect(fixtureOutput).not.toContain('E2E_RESULT=');
      deferredAsk.resolve!('DESKTOP_ASK_DENIED: simulated user refusal');
      const denied = await rejected;
      pending = null;
      expect(denied.isError).toBe(true);
      expect(text(denied)).toContain('DESKTOP_ASK_DENIED');
      deferredAsk.resolve = null;

      const second = await call('tools/call', 'linux_observe', { what: 'snapshot', window_id: id });
      const nextRef = ref(second, { role: 'textfield', name: 'Test message' });
      const allowed = call('tools/call', 'linux_act', { action: 'set_value', ref: nextRef, value: 'GATED_INPUT_ALLOWED' });
      pending = allowed;
      await vi.waitFor(() => expect(deferredAsk.resolve).not.toBeNull(), { timeout: 10_000 });
      expect(fixtureOutput).not.toContain('E2E_RESULT=');
      deferredAsk.resolve!(null); // Test-controlled approval, not a human's GUI click.
      const granted = await allowed;
      pending = null;
      expect(granted.isError).not.toBe(true);
      expect(text(granted)).toContain('delivered_verified');
      expect(fixtureOutput).not.toContain('E2E_RESULT=');
    } finally {
      deferredAsk.denyLate = true;
      deferredAsk.resolve?.('DESKTOP_ASK_DENIED: cleanup');
      try {
        if (pending) await pending.catch(() => undefined);
      } finally {
        deferredAsk.enabled = false;
        deferredAsk.denyLate = false;
        deferredAsk.resolve = null;
      }
    }
  });

  it('takes an exact-window snapshot, sets a field and activates a button through MCP HTTP', async () => {
    const id = await windowId();
    const first = await call('tools/call','linux_observe',{what:'snapshot',window_id:id});
    expect(first.isError).not.toBe(true);
    const entryRef = ref(first,{role:'textfield',name:'Test message'});
    const set = await call('tools/call','linux_act',{action:'set_value',ref:entryRef,value:MESSAGE});
    expect(set.isError).not.toBe(true);
    expect(text(set)).toContain('delivered_verified');
    const replaySet = await call('tools/call','linux_act',{action:'set_value',ref:entryRef,value:'SHOULD_NOT_APPEAR'});
    expect(replaySet.isError).toBe(true);
    expect(text(replaySet)).toContain('STALE_OR_FOREIGN_REF');
    const second = await call('tools/call','linux_observe',{what:'snapshot',window_id:id});
    expect(second.isError).not.toBe(true);
    const buttonRef = ref(second,{role:'button',name:'Apply test message'});
    const clicked = await call('tools/call','linux_act',{action:'click',ref:buttonRef});
    expect(clicked.isError).not.toBe(true);
    const replayClick = await call('tools/call','linux_act',{action:'click',ref:buttonRef});
    expect(replayClick.isError).toBe(true);
    expect(text(replayClick)).toContain('STALE_OR_FOREIGN_REF');
    const deadline = Date.now() + 1500;
    while (!fixtureOutput.includes(`E2E_RESULT=${MESSAGE}`) && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 50));
    expect(fixtureOutput).toContain(`E2E_RESULT=${MESSAGE}`);
    expect(fixtureOutput.match(/E2E_RESULT=/g)).toHaveLength(1);
    expect(fixtureOutput).not.toContain('SHOULD_NOT_APPEAR');
  }, 20_000);

  it.skipIf(!LIVE_SCREENSHOT)('transports one consented GNOME display PNG as a bounded MCP image without exposing its pixels', async () => {
    // One and only one screenshot call. The person has to grant GNOME consent
    // outside this test. Image bytes stay in process memory; only dimensions and
    // size are printed. No trace files or image uploads are created.
    const result = await call('tools/call', 'linux_observe', { what: 'screenshot', display: 0 });
    if (result?.isError === true) {
      const error = text(result);
      const code = error.match(/\b(PERM_DENIED|TIMEOUT|PLATFORM_NOT_SUPPORTED|DESKTOP_IMAGE_[A-Z_]+|LINUX_DESKTOP_[A-Z_]+|TOOL_DISABLED)\b/)?.[0] ?? 'SCREENSHOT_FAILED';
      throw new Error(`The native MCP screenshot was rejected: ${code}; no automatic retry attempted.`);
    }
    const parts = result.content as Array<{ type: string; mimeType?: string; data?: string }>;
    const images = parts.filter(part => part.type === 'image');
    expect(images.length).toBe(1);
    const image = images[0]!;
    expect(image.mimeType).toBe('image/png');
    expect(typeof image.data).toBe('string');
    expect(image.data?.length).toBeGreaterThan(30);
    const png = Buffer.from(image.data!, 'base64');
    expect(png.byteLength).toBeLessThanOrEqual(MAX_VIEW_IMAGE_BYTES);
    expect(await validateImageBytes(png)).toBe('image/png');

    const meta = result.structuredContent?.value;
    expect(meta).toMatchObject({ scope: 'display', display: 0, mimeType: 'image/png' });
    const decoded = await sharp(png).metadata();
    expect(decoded.width).toBe(meta.width);
    expect(decoded.height).toBe(meta.height);
    expect(meta.sourceWidth).toBeGreaterThanOrEqual(meta.width);
    expect(meta.sourceHeight).toBeGreaterThanOrEqual(meta.height);
    expect(meta.sourceWidth).toBeGreaterThan(0);
    expect(meta.sourceHeight).toBeGreaterThan(0);
    // The output is metadata only: not even a digest or a small image preview
    // is surfaced through test logs or the ChatGPT conversation.
    console.log('Verified private Linux MCP display image:', JSON.stringify({
      scope: meta.scope, display: meta.display, mimeType: image.mimeType,
      deliveredSize: [meta.width, meta.height], sourceSize: [meta.sourceWidth, meta.sourceHeight],
      resized: meta.resized, pngBytes: png.byteLength
    }));
  }, 55_000);
});
