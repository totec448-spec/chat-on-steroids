import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomFillSync } from 'node:crypto';
import sharp from 'sharp';
import { MAX_VIEW_IMAGE_BYTES } from '../src/main/codex/view-image.js';

const testState = vi.hoisted(() => ({
  enabled: true, screen: true, control: true, readOnly: false, allowedUnknown: false,
  caller: { sessionId: 'session-a' as string | null, conversationId: 'chat-a' as string | null,
    requestId: null as string | null, setupProfileId: null as string | null },
  correlation: null as { requestId: string; sessionId: string; conversationId: string } | null,
  backend: vi.fn(), version: vi.fn(), ask: vi.fn(), ended: vi.fn()
}));
vi.mock('../src/main/config.js', () => ({
  getConfig: () => ({ ui: { linuxDesktopEnabled: testState.enabled, desktopUnattributed: testState.allowedUnknown },
    readOnly: testState.readOnly, capabilities: { screen: testState.screen, control: testState.control } }),
  effectiveCapabilities: () => ({ screen: testState.screen, control: testState.control && !testState.readOnly })
}));
vi.mock('../src/main/mcp/call-context.js', () => ({ currentCaller: () => testState.caller }));
vi.mock('../src/main/session/correlation.js', async original => ({ ...(await original<typeof import('../src/main/session/correlation.js')>()),
  requestCorrelation: (requestId: string) => testState.correlation?.requestId === requestId ? testState.correlation : null }));
vi.mock('../src/main/desktop-ask-window.js', () => ({ askBeforeDesktopStep: (...args: unknown[]) => testState.ask(...args), desktopStepEnded: () => testState.ended() }));
vi.mock('../src/main/computer/linux-agent-desktop.js', () => ({
  runLinuxDesktop: (...args: unknown[]) => testState.backend(...args),
  checkLinuxDesktopVersion: (...args: unknown[]) => testState.version(...args)
}));
import { registerLinuxDesktopTools } from '../src/main/mcp/tools-desktop-linux.js';

const window = { id: 'w-1.3-test', app_name: 'test-gtk', pid: 304, process_instance: 'boot:4', title: 'Test' };
const browser = { ...window, id: 'w-browser', app_name: 'chrome' };
function handlers() {
  const entries = new Map<string, (args: any) => Promise<any>>();
  registerLinuxDesktopTools({
    ctx: { exposedLinuxDesktop: true }, exposedCaps: { screen: true, control: true },
    register: (name: string, _config: unknown, handler: (args: any) => Promise<any>) => { entries.set(name, handler); },
    guarded: async (_cap: string, _name: string, fn: () => Promise<any>) => fn()
  } as never);
  return { observe: entries.get('linux_observe')!, act: entries.get('linux_act')! };
}
const good = (command: string, data: unknown) => ({ ok: true, command, data });
function mockSnapshot() {
  testState.backend.mockImplementation(async ({kind}: {kind:string}) => kind === 'windows'
    ? good('list-windows', [window]) : kind === 'snapshot'
      ? good('snapshot', { snapshot_id: 's123', complete: true, window: { id: window.id }, tree: {children: [{ref_id:'@s123:e1'}]} })
      : good(kind, { disposition: { delivery: 'delivered_unverified', retry: 'unsafe' } }));
}
beforeEach(() => {
  testState.enabled = true; testState.screen = true; testState.control = true; testState.readOnly = false;
  testState.allowedUnknown = false;
  testState.caller = {sessionId: 'session-a', conversationId: 'chat-a', requestId: null, setupProfileId: null};
  testState.correlation = null;
  testState.backend.mockReset(); testState.version.mockReset(); testState.ask.mockReset(); testState.ended.mockReset();
  testState.ask.mockResolvedValue(null); testState.version.mockResolvedValue(undefined);
});

// The production registrar deliberately does not expose Linux tools on
// Windows/macOS. Exercise the Linux authorization logic only where registered.
describe.runIf(process.platform === 'linux')('native Linux connector authorization', () => {
  it('requires separate opt-in even when browser screen/control are enabled', async () => {
    const {observe,act} = handlers(); testState.enabled = false;
    expect((await observe({what:'windows'})).content[0].text).toContain('LINUX_DESKTOP_DISABLED');
    expect((await act({action:'click',ref:'@s123:e1'})).content[0].text).toContain('LINUX_DESKTOP_DISABLED');
    expect(testState.backend).not.toHaveBeenCalled();
  });
  it('lists actual running applications using the backend apps envelope', async () => {
    const {observe} = handlers();
    testState.backend.mockResolvedValue(good('list-apps', {apps: [{name:'test-gtk'}]}));
    const result = await observe({what:'apps'});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.value).toMatchObject({items:[{name:'test-gtk'}], total:1});
    expect(testState.backend).toHaveBeenCalledWith({kind:'apps'});
  });
  it('never acts on browser windows even when the window ID is exact', async () => {
    const {observe} = handlers(); testState.backend.mockResolvedValue(good('list-windows',[browser]));
    expect((await observe({what:'snapshot', window_id:browser.id})).content[0].text).toContain('DESKTOP_TARGET_UNPROVEN');
    expect(testState.backend).toHaveBeenCalledTimes(1);
  });
  it('rejects Linux desktop IDs that identify a browser even with dotted application names', async () => {
    const { observe } = handlers();
    for (const app_name of ['org.mozilla.firefox', 'org.gnome.Epiphany']) {
      testState.backend.mockResolvedValue(good('list-windows', [{ ...window, app_name }]));
      const result = await observe({ what: 'snapshot', window_id: window.id });
      expect(result.content[0].text).toContain('DESKTOP_TARGET_UNPROVEN');
    }
    expect(testState.backend).toHaveBeenCalledTimes(2);
  });
  it('never acts without proven identity, even when unattributed observation is enabled', async () => {
    const {observe,act} = handlers(); testState.allowedUnknown = true;
    mockSnapshot(); testState.caller = {sessionId: null,conversationId: null,requestId:'uncorrelated',setupProfileId:null};
    expect((await observe({what:'snapshot',window_id:window.id})).isError).toBeUndefined();
    expect((await act({action:'click',ref:'@s123:e1'})).content[0].text).toContain('DESKTOP_IDENTITY_REQUIRED');
    expect(testState.backend.mock.calls.filter(([arg]) => arg.kind === 'click')).toHaveLength(0);
  });
  it('isolates snapshots of parallel chats and consumes refs after one action', async () => {
    const {observe,act} = handlers(); mockSnapshot();
    expect((await observe({what:'snapshot',window_id:window.id})).isError).toBeUndefined();
    testState.caller = {sessionId:'session-b',conversationId:'chat-b',requestId:null,setupProfileId:null};
    expect((await act({action:'click',ref:'@s123:e1'})).content[0].text).toContain('STALE_OR_FOREIGN_REF');
    testState.caller = {sessionId:'session-a',conversationId:'chat-a',requestId:null,setupProfileId:null};
    expect((await act({action:'click',ref:'@s123:e1'})).isError).toBeUndefined();
    expect((await act({action:'click',ref:'@s123:e1'})).content[0].text).toContain('STALE_OR_FOREIGN_REF');
    expect(testState.backend.mock.calls.filter(([arg]) => arg.kind === 'click')).toHaveLength(1);
  });
  it('does not let a new conversation reuse refs from a rebound local session', async () => {
    const { observe, act } = handlers(); mockSnapshot();
    await observe({ what: 'snapshot', window_id: window.id });
    // The durable CoS session id may remain the same across Compact & Resume.
    testState.caller = { sessionId: 'session-a', conversationId: 'chat-b', requestId: null, setupProfileId: null };
    const result = await act({ action: 'click', ref: '@s123:e1' });
    expect(result.content[0].text).toContain('STALE_OR_FOREIGN_REF');
    expect(testState.backend.mock.calls.filter(([arg]) => arg.kind === 'click')).toHaveLength(0);
  });
  it('does not let a different Setup profile reuse an identical chat/session snapshot', async () => {
    const { observe, act } = handlers(); mockSnapshot();
    testState.caller.setupProfileId = 'profile-1';
    await observe({ what: 'snapshot', window_id: window.id });
    testState.caller.setupProfileId = 'profile-2';
    const result = await act({ action: 'click', ref: '@s123:e1' });
    expect(result.content[0].text).toContain('STALE_OR_FOREIGN_REF');
    expect(testState.backend.mock.calls.filter(([arg]) => arg.kind === 'click')).toHaveLength(0);
  });
  it('passes late request-id attribution into the ask gate, scoped to the proven chat and profile', async () => {
    const { observe, act } = handlers(); mockSnapshot();
    // The incoming connector did not supply a chat. The page proved its exact
    // request id after the call arrived, before the backend snapshot was issued.
    testState.caller = { sessionId: null, conversationId: null, requestId: 'request-a', setupProfileId: 'profile-a' };
    testState.correlation = { requestId: 'request-a', sessionId: 'session-a', conversationId: 'chat-a' };
    expect((await observe({ what: 'snapshot', window_id: window.id })).isError).toBeUndefined();
    expect((await act({ action: 'click', ref: '@s123:e1' })).isError).toBeUndefined();
    expect(testState.ask).toHaveBeenCalledWith('click', window.app_name, {
      sessionId: 'session-a', conversationId: 'chat-a',
      scopedPrincipal: JSON.stringify(['profile-a', 'session-a', 'chat-a'])
    });
    // The same transport cannot borrow a previous chat's references or grant.
    testState.caller.requestId = 'request-b';
    testState.correlation = { requestId: 'request-b', sessionId: 'session-a', conversationId: 'chat-b' };
    expect((await act({ action: 'click', ref: '@s123:e1' })).content[0].text).toContain('STALE_OR_FOREIGN_REF');
    expect((await observe({ what: 'snapshot', window_id: window.id })).isError).toBeUndefined();
    expect((await act({ action: 'click', ref: '@s123:e1' })).isError).toBeUndefined();
    expect(testState.ask).toHaveBeenLastCalledWith('click', window.app_name, {
      sessionId: 'session-a', conversationId: 'chat-b',
      scopedPrincipal: JSON.stringify(['profile-a', 'session-a', 'chat-b'])
    });
    expect(testState.ask).toHaveBeenCalledTimes(2);
  });
  it('refuses to issue reusable refs if the chat changes while the snapshot is being collected', async () => {
    const { observe, act } = handlers();
    let finishSnapshot!: (result: unknown) => void;
    testState.backend.mockImplementation(async ({ kind }: { kind: string }) => kind === 'windows'
      ? good('list-windows', [window]) : kind === 'snapshot'
        ? new Promise(resolve => { finishSnapshot = resolve; }) : good(kind, {}));
    const pending = observe({ what: 'snapshot', window_id: window.id });
    await vi.waitFor(() => expect(testState.backend.mock.calls.some(([input]) => input.kind === 'snapshot')).toBe(true), { timeout: 10_000 });
    testState.caller.conversationId = 'chat-b';
    finishSnapshot(good('snapshot', { snapshot_id: 's123', complete: true,
      window: { id: window.id }, tree: { children: [{ ref_id: '@s123:e1' }] } }));
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('DESKTOP_IDENTITY_CHANGED');
    expect((await act({ action: 'click', ref: '@s123:e1' })).content[0].text).toContain('STALE_OR_FOREIGN_REF');
    expect(testState.backend.mock.calls.filter(([input]) => input.kind === 'click')).toHaveLength(0);
  });
  it('expires refs that were not acted on within two minutes', async () => {
    const { observe, act } = handlers(); mockSnapshot();
    await observe({ what: 'snapshot', window_id: window.id });
    const realNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + 121_000);
    try {
      const result = await act({ action: 'click', ref: '@s123:e1' });
      expect(result.content[0].text).toContain('expired');
      expect(testState.backend.mock.calls.filter(([arg]) => arg.kind === 'click')).toHaveLength(0);
    } finally { clock.mockRestore(); }
  });
  it('never publishes a portal image after screen access is revoked during the capture', async () => {
    const { observe } = handlers();
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    let complete!: (value: unknown) => void;
    testState.backend.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const pending = observe({ what: 'screenshot', display: 0 });
    await vi.waitFor(() => expect(testState.backend).toHaveBeenCalledWith({ kind: 'screenshot', display: 0 }), { timeout: 10_000 });
    testState.screen = false;
    complete(good('screenshot', { data: png, format: 'png', width: 1, height: 1, scale_factor: 1 }));
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('TOOL_DISABLED');
    expect(result.content.every((part: { type: string }) => part.type !== 'image')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(png);
    expect(testState.backend).toHaveBeenCalledTimes(1);
  });
  it('rechecks control permission after the confirmation wait and performs zero input on revoke', async () => {
    const {observe,act} = handlers(); mockSnapshot();
    await observe({what:'snapshot',window_id:window.id});
    let approve!: (decision: null) => void;
    testState.ask.mockImplementationOnce(() => new Promise(resolve => { approve = resolve; }));
    const pending = act({action:'set_value',ref:'@s123:e1',value:'hello'});
    await vi.waitFor(() => expect(testState.ask).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    testState.control = false;
    approve(null);
    expect((await pending).content[0].text).toContain('TOOL_DISABLED');
    expect(testState.backend.mock.calls.filter(([arg]) => arg.kind === 'setValue')).toHaveLength(0);
    expect(testState.ended).not.toHaveBeenCalled();
  });
  it('returns an actual MCP image block with explicit display scope, never a window image', async () => {
    const {observe} = handlers();
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    testState.backend.mockResolvedValue(good('screenshot', {data: png, format: 'png', width: 1, height: 1, scale_factor: 1}));
    const result = await observe({what:'screenshot',display:0});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.value).toMatchObject({scope:'display',display:0,mimeType:'image/png',width:1,height:1,sourceWidth:1,sourceHeight:1,resized:false});
    expect(result.content[1]).toEqual({type:'image',mimeType:'image/png',data:png});
  });
  it('rejects the incorrect old base64/image fields without leaking or claiming a screenshot', async () => {
    const {observe} = handlers();
    testState.backend.mockResolvedValue(good('screenshot', {base64:'iVBORw0KGgo=',image:'private pixels'}));
    const result = await observe({what:'screenshot',display:0});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_SHAPE');
    expect(result.content.every((part: {type:string}) => part.type !== 'image')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private pixels');
    expect(testState.backend).toHaveBeenCalledTimes(1);
  });
  it('fits a large but valid screenshot into the bounded MCP image payload without a second portal request', async () => {
    const { observe } = handlers();
    const width = 3000, height = 1200;
    const raw = Buffer.alloc(width * height * 3);
    randomFillSync(raw.subarray(0, 7 * 1024 * 1024));
    const sourcePng = await sharp(raw, { raw: { width, height, channels: 3 } })
      .png({ compressionLevel: 9 }).toBuffer();
    expect(sourcePng.length).toBeGreaterThan(MAX_VIEW_IMAGE_BYTES);
    expect(sourcePng.length).toBeLessThan(8 * 1024 * 1024);
    testState.backend.mockResolvedValue(good('screenshot', {
      data: sourcePng.toString('base64'), format: 'png', width, height, scale_factor: 1
    }));
    const result = await observe({ what: 'screenshot', display: 0 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.value).toMatchObject({ scope: 'display', display: 0,
      sourceWidth: width, sourceHeight: height, resized: true });
    const part = result.content[1] as { data: string; mimeType: string };
    expect(part.mimeType).toBe('image/png');
    const decoded = Buffer.from(part.data, 'base64');
    expect(decoded.length).toBeLessThanOrEqual(MAX_VIEW_IMAGE_BYTES);
    const metadata = await sharp(decoded).metadata();
    expect(metadata.width).toBeLessThan(width);
    expect(metadata.height).toBeLessThan(height);
    expect(testState.backend.mock.calls.filter(([command]) => command.kind === 'screenshot')).toHaveLength(1);
  });
  it('preserves portal denial without retry or fake image content', async () => {
    const {observe} = handlers();
    testState.backend.mockResolvedValue({ok:false, command:'screenshot',error:{code:'PERM_DENIED',disposition:{delivery:'not_delivered',retry:'safe'}}});
    const result = await observe({what:'screenshot',display:0});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('PERM_DENIED');
    expect(result.content.every((part: {type:string}) => part.type !== 'image')).toBe(true);
    expect(testState.backend).toHaveBeenCalledTimes(1);
  });
  it('never exposes an arbitrary backend error message containing application content', async () => {
    const { observe } = handlers();
    testState.backend.mockResolvedValue({
      ok: false, command: 'windows', error: { code: 'DENIED', message: 'PRIVATE_WINDOW_TITLE: internal payroll' }
    });
    const result = await observe({ what: 'windows' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('DENIED');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_WINDOW_TITLE');
    expect(testState.backend).toHaveBeenCalledTimes(1);
  });
  it('fails closed on read-only even with native opt-in and control permission selected', async () => {
    const {act} = handlers(); testState.readOnly = true;
    expect((await act({action:'click',ref:'@s123:e1'})).content[0].text).toContain('Read-only');
    expect(testState.backend).not.toHaveBeenCalled();
  });
  it('rechecks window process incarnation after confirmation before input', async () => {
    const {observe,act} = handlers(); mockSnapshot();
    await observe({what:'snapshot',window_id:window.id});
    testState.backend.mockImplementation(async ({kind}: {kind:string}) => kind === 'windows'
      ? good('list-windows',[{...window,process_instance:'new-process'}]) : good(kind,{}));
    expect((await act({action:'click',ref:'@s123:e1'})).content[0].text).toContain('DESKTOP_TARGET_UNPROVEN');
    expect(testState.backend.mock.calls.filter(([arg]) => arg.kind === 'click')).toHaveLength(0);
  });
});

it.runIf(process.platform !== 'linux')('never registers Linux Desktop tools on non-Linux hosts', () => {
  const entries: string[] = [];
  registerLinuxDesktopTools({
    ctx: { exposedLinuxDesktop: true }, exposedCaps: { screen: true, control: true },
    register: (name: string) => { entries.push(name); },
    guarded: async (_cap: string, _name: string, fn: () => Promise<unknown>) => fn()
  } as never);
  expect(entries).toEqual([]);
});
