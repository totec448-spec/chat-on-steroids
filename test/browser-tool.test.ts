import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capabilities } from '../src/shared/types.js';
import type { SurfaceRegistrar } from '../src/main/mcp/kernel.js';
import { z } from 'zod';

const fake = vi.hoisted(() => {
  class ProtocolError extends Error {
    constructor(
      readonly code: 'STALE_TAB' | 'STALE_BROWSER_STATE' | 'BROWSER_STATE_TIMEOUT' | 'APPROVAL_REQUIRED' | 'APPROVAL_PENDING',
      message: string,
      readonly details: Record<string, unknown> = {}
    ) {
      super(message);
    }
  }
  return {
    ProtocolError,
    pendingApproval: null as Record<string, unknown> | null,
    overview: { tabs: [] as Array<Record<string, unknown>>, activeTabId: null as number | null, agentActive: false },
    error: null as Error | null,
    select: vi.fn(),
    finish: vi.fn(),
    observe: vi.fn(),
    history: vi.fn(),
    wait: vi.fn(async () => 'settled' as const),
    touch: vi.fn(),
    activity: vi.fn(async <T>(work: () => Promise<T> | T) => work())
  };
});

vi.mock('../src/main/browser-use.js', () => ({
  BrowserUseProtocolError: fake.ProtocolError,
  browserUseAgentOverview: () => fake.overview,
  browserUseAgentPendingApproval: () => fake.pendingApproval,
  browserUseHistory: fake.history,
  closeBrowserUseTab: vi.fn(),
  finishBrowserUseAgentMission: fake.finish,
  keyBrowserUseTab: vi.fn(),
  navigateBrowserUseTab: vi.fn(),
  observeBrowserUseTab: fake.observe,
  openBrowserUseTab: vi.fn(async () => { if (fake.error) throw fake.error; }),
  performBrowserUsePointerAction: vi.fn(),
  requestBrowserUsePanel: vi.fn(),
  scrollBrowserUseTab: vi.fn(),
  selectBrowserUseTab: fake.select,
  touchBrowserUseAgentMission: fake.touch,
  typeBrowserUseRef: vi.fn(),
  waitForBrowserUseTab: fake.wait,
  withBrowserUseAgentActivity: fake.activity
}));
vi.mock('../src/main/mcp/kernel.js', () => ({
  fail: (text: string) => ({ isError: true, content: [{ type: 'text', text }] })
}));

import { registerBrowserTool } from '../src/main/mcp/browser-tool.js';

function registrar() {
  const tools = new Map<string, { schema: z.ZodType; description: string; handler: (input: unknown) => Promise<any> }>();
  registerBrowserTool({
    exposedCaps: { browserUse: true } as Capabilities,
    register: (name: string, definition: any, handler: any) => {
      tools.set(name, { schema: definition.inputSchema, description: definition.description, handler });
    },
    guarded: async (_cap: string, _name: string, work: () => Promise<unknown>) => work()
  } as unknown as SurfaceRegistrar);
  const tool = tools.get('browser')!;
  return {
    tool,
    call: (input: unknown) => tool.handler(tool.schema.parse(input))
  };
}

beforeEach(() => {
  fake.overview = { tabs: [], activeTabId: null, agentActive: false };
  fake.pendingApproval = null;
  fake.error = null;
  fake.select.mockReset();
  fake.finish.mockReset();
  fake.observe.mockReset();
  fake.history.mockReset();
  fake.wait.mockReset().mockResolvedValue('settled');
  fake.touch.mockReset();
  fake.activity.mockClear();
});

describe('Browser Use MCP contract', () => {
  it('returns a recoverable no_active_tab state instead of refusing the call', async () => {
    const result = await registrar().call({ action: 'state' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.value).toMatchObject({ status: 'no_active_tab', next: 'open' });
  });

  it('returns approval and changed-document states as recoverable structured outcomes', async () => {
    fake.error = new fake.ProtocolError('APPROVAL_REQUIRED', 'Approve this origin.', {
      status: 'approval_required', origin: 'https://example.com', tab_id: 12,
      retry: { action: 'navigate', tab_id: 12, url: 'https://example.com/' }
    });
    const approval = await registrar().call({ action: 'open', url: 'https://example.com/' });
    expect(approval.isError).not.toBe(true);
    expect(approval.structuredContent).toMatchObject({ status: 'approval_required', tab_id: 12 });

    fake.error = null;
    fake.overview = { tabs: [{ id: 12, active: true }], activeTabId: 12, agentActive: true };
    fake.observe.mockRejectedValueOnce(new fake.ProtocolError(
      'STALE_BROWSER_STATE', 'The document changed.', { status: 'target_lost', next: 'state' }
    ));
    const stale = await registrar().call({ action: 'state', tab_id: 12 });
    expect(stale.isError).not.toBe(true);
    expect(stale.structuredContent).toMatchObject({ status: 'target_lost', next: 'state' });

    fake.observe.mockRejectedValueOnce(new fake.ProtocolError(
      'BROWSER_STATE_TIMEOUT', 'The document did not respond.', { status: 'timeout', next: 'state' }
    ));
    const timeout = await registrar().call({ action: 'state', tab_id: 12 });
    expect(timeout.isError).not.toBe(true);
    expect(timeout.structuredContent).toMatchObject({ status: 'timeout', next: 'state' });
  });

  it('reprojects a pending approval instead of observing the provisional blank tab', async () => {
    fake.overview = { tabs: [{ id: 12, active: true, loading: false }], activeTabId: 12, agentActive: true };
    fake.pendingApproval = {
      status: 'approval_required', origin: 'https://example.com', tab_id: 12,
      retry: { action: 'navigate', tab_id: 12, url: 'https://example.com/' }
    };
    const result = await registrar().call({ action: 'state', tab_id: 12 });
    expect(fake.observe).not.toHaveBeenCalled();
    expect(result.structuredContent.value).toMatchObject({ status: 'approval_required', tab_id: 12 });
  });

  it('keeps a missing tab as a real refusal and makes tab selection explicit', async () => {
    fake.error = new fake.ProtocolError('STALE_TAB', 'Tab 4 is gone.');
    const stale = await registrar().call({ action: 'open' });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toMatchObject({ status: 'blocked', error: 'STALE_TAB' });

    fake.error = null;
    fake.overview = { tabs: [{ id: 8, active: true, loading: false }], activeTabId: 8, agentActive: true };
    const selected = await registrar().call({ action: 'select', tab_id: 8 });
    expect(fake.select).toHaveBeenCalledWith(8);
    expect(selected.structuredContent.value).toMatchObject({ status: 'success', action: 'select', tab_id: 8 });
  });

  it('waits on the owned loading boundary and reports impossible history actions as no_effect', async () => {
    fake.overview = {
      tabs: [{ id: 5, active: true, loading: true, can_go_back: false, can_go_forward: false }],
      activeTabId: 5,
      agentActive: true
    };
    const reg = registrar();
    const loading = await reg.call({ action: 'state', tab_id: 5 });
    expect(fake.observe).not.toHaveBeenCalled();
    expect(loading.structuredContent.value).toMatchObject({ status: 'loading', next: 'wait' });

    const defaultWait = await reg.call({ action: 'wait', tab_id: 5 });
    expect(fake.wait).toHaveBeenLastCalledWith(5, 1000);
    expect(defaultWait.structuredContent.value).toMatchObject({ status: 'settled', waited_ms: 1000, next: 'state' });

    const waited = await reg.call({ action: 'wait', tab_id: 5, ms: 2000 });
    expect(fake.wait).toHaveBeenLastCalledWith(5, 2000);
    expect(waited.structuredContent.value).toMatchObject({ status: 'settled', next: 'state' });

    const back = await reg.call({ action: 'back', tab_id: 5 });
    expect(fake.history).not.toHaveBeenCalled();
    expect(back.structuredContent.value).toMatchObject({ status: 'no_effect', action: 'back' });
  });

  it('describes done as mission cleanup while preserving panel and tab ownership', async () => {
    fake.overview = { tabs: [{ id: 9, active: true }], activeTabId: 9, agentActive: true };
    const reg = registrar();
    const result = await reg.call({ action: 'done' });
    expect(result.structuredContent.value).toMatchObject({
      status: 'mission_finished', mission_active: false, tabs_preserved: true, panel_closed: false
    });
    expect(reg.tool.description).toContain('does not close the panel or tabs');
    expect(reg.tool.description).toContain('BROWSER USE — isolated Browser panel');
    expect(reg.tool.description).toContain('Route Browser Use/Browser panel to Core browser');
    expect(reg.tool.description).toContain('no Desktop connector or companion extension');
    expect(reg.tool.description).toContain('every input action');
    expect(reg.tool.description).toContain('loading means wait, then state');
    expect(reg.tool.description).toContain('wait defaults to 1000 ms');
    expect(reg.tool.description).toContain('prefer compact=true');
    expect(reg.tool.description).toContain('structuredContent.value');
    expect(reg.tool.schema.safeParse({ action: 'select' }).success).toBe(false);
    expect(reg.tool.schema.safeParse({ action: 'help' }).success).toBe(false);
  });

  it('keeps list and state passive after done while control actions start activity', async () => {
    fake.overview = {
      tabs: [{ id: 9, active: true, loading: false }],
      activeTabId: 9,
      agentActive: true
    };
    fake.finish.mockImplementationOnce(async () => {
      fake.overview = { ...fake.overview, agentActive: false };
    });
    fake.observe.mockResolvedValueOnce({
      tabId: 9,
      snapshotId: 4,
      loading: false,
      title: 'Example',
      url: 'https://example.com/',
      viewport: { width: 800, height: 600 },
      text: '',
      elements: []
    });
    const reg = registrar();

    await reg.call({ action: 'done' });
    const state = await reg.call({ action: 'state', tab_id: 9, compact: true });
    const list = await reg.call({ action: 'list' });

    expect(state.structuredContent.value).toMatchObject({ status: 'observed', mission_active: false });
    expect(list.structuredContent.value).toMatchObject({ status: 'observed', mission_active: false });
    expect(fake.touch).toHaveBeenCalledTimes(2);
    expect(fake.activity).not.toHaveBeenCalled();

    await reg.call({ action: 'select', tab_id: 9 });
    expect(fake.activity).toHaveBeenCalledTimes(1);
  });
});
