import { describe, expect, it, vi } from 'vitest';
import { buildGeminiMcpConfigJson, buildGeminiMcpUrl } from '../src/renderer/gemini-card.js';
import { mountChat, waitFor } from './renderer-state.harness.js';

vi.mock('../src/renderer/workspace-terminal.js', () => ({
  createWorkspaceTerminal: () => ({
    update: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    newTab: vi.fn(() => null),
    tabs: vi.fn(() => []),
    selectTab: vi.fn(),
    closeTab: vi.fn()
  })
}));
vi.mock('../src/renderer/pet.js', () => ({
  initPet: () => Object.assign(() => {}, { toggle: () => {}, isVisible: () => false })
}));

function makeSurface(id: 'core' | 'desktop', overrides: Record<string, unknown> = {}) {
  return {
    id,
    connectorName: id === 'core' ? 'Chat On Steroids Core' : 'Chat On Steroids Desktop',
    description: id === 'core' ? 'Core tools' : 'Desktop tools',
    cardSummary: id === 'core' ? 'Core summary' : 'Desktop summary',
    optional: id !== 'core',
    available: true,
    localUrl: `http://127.0.0.1:12345/mcp/${id}/localtok`,
    publicUrl: `https://tunnel.example.trycloudflare.com/mcp/${id}/tok123`,
    tools: id === 'core' ? ['read', 'search', 'list_files'] : ['screenshot', 'click'],
    state: 'live' as const,
    detail: 'Ready',
    lastRequestAt: null,
    lastToolCallAt: null,
    createdInChatgpt: false,
    ...overrides
  };
}

describe('Gemini MCP helpers', () => {
  it('appends ?client=gemini while preserving existing params and overriding prior client hints', () => {
    expect(buildGeminiMcpUrl('https://demo.trycloudflare.com/mcp/core/abc')).toBe(
      'https://demo.trycloudflare.com/mcp/core/abc?client=gemini'
    );
    expect(buildGeminiMcpUrl('https://demo.trycloudflare.com/mcp/core/abc?client=other&v=1#frag')).toBe(
      'https://demo.trycloudflare.com/mcp/core/abc?client=gemini&v=1#frag'
    );
    expect(buildGeminiMcpUrl('/mcp/core/abc')).toBe('/mcp/core/abc?client=gemini');
  });

  it('builds Gemini httpUrl mcpServers JSON per surface', () => {
    const core = JSON.parse(buildGeminiMcpConfigJson('core', 'https://x.test/mcp/core/t?client=gemini'));
    expect(core).toEqual({
      mcpServers: {
        'chat-on-steroids': {
          httpUrl: 'https://x.test/mcp/core/t?client=gemini'
        }
      }
    });

    const desktop = JSON.parse(buildGeminiMcpConfigJson('desktop', 'https://x.test/mcp/desktop/t?client=gemini'));
    expect(desktop).toEqual({
      mcpServers: {
        'chat-on-steroids-desktop': {
          httpUrl: 'https://x.test/mcp/desktop/t?client=gemini'
        }
      }
    });
  });
});

describe('Gemini Setup card in renderer', () => {
  it('runs alongside OpenAI tunnel via Tailscale, Custom HTTPS (with Named Tunnel token), and Local modes', async () => {
    const copiedValues: string[] = [];
    const openedLinks: Array<{ url: string; options: unknown }> = [];
    const tokenSaves: string[] = [];
    let refreshed = 0;

    const mounted = await mountChat(
      {
        secureStorage: { available: true },
        hasGeminiTunnelToken: false,
        status: {
          state: 'connected',
          detail: 'Connected',
          publicUrl: null,
          localUrl: 'http://127.0.0.1:12345',
          handshakeAt: null,
          lastRequestAt: null,
          lastToolCallAt: null,
          health: null,
          surfaces: [
            makeSurface('core', { publicUrl: null }),
            makeSurface('desktop', { available: true, publicUrl: null })
          ],
          externalClients: []
        }
      },
      [],
      {
        writeClipboard: (text: string) => {
          copiedValues.push(text);
          return Promise.resolve({ ok: true as const, data: true });
        },
        openLink: (url: string, options: unknown) => {
          openedLinks.push({ url, options });
          return Promise.resolve({ ok: true as const, data: true });
        },
        setGeminiTunnelToken: (value: string) => {
          tokenSaves.push(value);
          mounted.state = { ...mounted.state, hasGeminiTunnelToken: value.length > 0 };
          return Promise.resolve({ ok: true as const, data: mounted.state });
        },
        refreshGeminiBridge: () => {
          refreshed += 1;
          return Promise.resolve({ ok: true as const, data: mounted.state });
        }
      }
    );

    const doc = mounted.window.document;
    doc.querySelector<HTMLButtonElement>('button[data-tab="setup"]')!.click();

    await waitFor(() => expect(doc.querySelector('#geminiConnectorCard .gemini-card')).not.toBeNull());
    expect(doc.querySelectorAll('#connectorCards details')).toHaveLength(0);
    expect(doc.querySelector('#connectorCards #geminiConnectorCard')).toBeNull();

    const slot = doc.getElementById('geminiConnectorCard')!;
    expect(slot.textContent).toContain('ChatGPT uses the OpenAI tunnel.');

    // One-click switch to Tailscale leaves ChatGPT on the OpenAI tunnel and turns on Keep URL tokens.
    const useTsBtn = [...slot.querySelectorAll('button')].find(
      (b) => b.textContent === 'Use Tailscale (Permanent HTTPS)'
    )!;
    useTsBtn.click();
    await waitFor(() => expect(mounted.calls.length).toBeGreaterThanOrEqual(1));
    expect(mounted.calls.at(-1).tunnel.kind).toBe('openai');
    expect(mounted.calls.at(-1).mcp).toMatchObject({ geminiBridge: 'tailscale', persistentUrls: true });

    // Approval actionUrl renders external link + Retry button.
    mounted.state.config = {
      ...mounted.state.config,
      mcp: { instructions: '', persistentUrls: true, geminiBridge: 'tailscale' }
    };
    mounted.state.status = {
      ...mounted.state.status,
      geminiBridge: {
        mode: 'tailscale',
        state: 'error',
        publicOrigin: null,
        detail: 'Enable Funnel on tailnet first.',
        actionUrl: 'https://login.tailscale.com/f/funnel?node=abc'
      }
    };
    mounted.push(structuredClone(mounted.state));

    await waitFor(() =>
      expect([...slot.querySelectorAll('button')].some((b) => b.textContent === 'Open Tailscale link')).toBe(true)
    );
    [...slot.querySelectorAll('button')].find((b) => b.textContent === 'Open Tailscale link')!.click();
    await waitFor(() => expect(openedLinks).toHaveLength(1));
    expect(openedLinks[0]).toEqual({
      url: 'https://login.tailscale.com/f/funnel?node=abc',
      options: { external: true }
    });
    [...slot.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!.click();
    await waitFor(() => expect(refreshed).toBe(1));

    // Live Tailscale origin combines with Core & Desktop local paths while keeping OpenAI tunnel intact.
    mounted.state.status = {
      ...mounted.state.status,
      geminiBridge: {
        mode: 'tailscale',
        state: 'live',
        publicOrigin: 'https://inmersion.tail1b6353.ts.net',
        detail: 'Live'
      }
    };
    mounted.push(structuredClone(mounted.state));

    await waitFor(() => expect(slot.querySelector('.gemini-surface-select')).not.toBeNull());
    const urlInput = slot.querySelector<HTMLInputElement>('.row-inline input[readonly]')!;
    expect(urlInput.value).toBe('https://inmersion.tail1b6353.ts.net/mcp/core/localtok?client=gemini');

    const jsonArea = slot.querySelector<HTMLTextAreaElement>('.gemini-json-preview')!;
    expect(JSON.parse(jsonArea.value)).toEqual({
      mcpServers: {
        'chat-on-steroids': {
          httpUrl: 'https://inmersion.tail1b6353.ts.net/mcp/core/localtok?client=gemini'
        }
      }
    });

    const select = slot.querySelector<HTMLSelectElement>('.gemini-surface-select')!;
    select.value = 'desktop';
    select.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
    await waitFor(() =>
      expect(slot.querySelector<HTMLInputElement>('.row-inline input[readonly]')!.value).toContain('/mcp/desktop/')
    );

    const copyJsonBtn = [...slot.querySelectorAll('button')].find((b) => b.textContent?.includes('Copy JSON'))!;
    copyJsonBtn.click();
    await waitFor(() => expect(copiedValues).toHaveLength(1));
    expect(JSON.parse(copiedValues[0]!).mcpServers['chat-on-steroids-desktop'].httpUrl).toBe(
      'https://inmersion.tail1b6353.ts.net/mcp/desktop/localtok?client=gemini'
    );

    // Custom HTTPS mode validates origin, saves clean origin, and stores/clears Cloudflare Tunnel token.
    slot.querySelector<HTMLButtonElement>('[data-gemini-mode="custom"]')!.click();
    await waitFor(() => expect(mounted.calls.at(-1)?.mcp?.geminiBridge).toBe('custom'));

    await waitFor(() => expect(slot.querySelector('[data-gemini-origin-input]')).not.toBeNull());
    const originInput = slot.querySelector<HTMLInputElement>('[data-gemini-origin-input]')!;
    originInput.value = 'http://insecure.example.com';
    originInput.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
    [...slot.querySelectorAll('button')].find((b) => b.textContent === 'Save')!.click();
    await waitFor(() =>
      expect(slot.textContent).toContain('Enter a valid HTTPS origin such as https://mcp.example.com')
    );

    const originInputAfterError = slot.querySelector<HTMLInputElement>('[data-gemini-origin-input]')!;
    originInputAfterError.value = 'https://MCP.Example.com:8443/prefix';
    originInputAfterError.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
    [...slot.querySelectorAll('button')].find((b) => b.textContent === 'Save')!.click();
    await waitFor(() =>
      expect(mounted.calls.at(-1)?.mcp?.geminiPublicOrigin).toBe('https://mcp.example.com:8443')
    );

    const tokenInput = slot.querySelector<HTMLInputElement>('[data-gemini-token-input]')!;
    tokenInput.value = 'cf-named-tunnel-secret';
    tokenInput.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
    [...slot.querySelectorAll('button')].find((b) => b.textContent === 'Save token')!.click();
    await waitFor(() => expect(tokenSaves).toEqual(['cf-named-tunnel-secret']));
    await waitFor(() => expect(slot.textContent).toContain('Saved in OS key store'));

    [...slot.querySelectorAll('button')].find((b) => b.textContent === 'Clear token')!.click();
    await waitFor(() => expect(tokenSaves).toEqual(['cf-named-tunnel-secret', '']));

    // Local mode shows permanent 127.0.0.1 URL while OpenAI tunnel runs for ChatGPT.
    slot.querySelector<HTMLButtonElement>('[data-gemini-mode="local"]')!.click();
    await waitFor(() => expect(mounted.calls.at(-1)?.mcp?.geminiBridge).toBe('local'));
    mounted.state.config = {
      ...mounted.state.config,
      mcp: { instructions: '', persistentUrls: true, geminiBridge: 'local' }
    };
    mounted.state.status = {
      ...mounted.state.status,
      geminiBridge: { mode: 'local', state: 'live', publicOrigin: 'http://127.0.0.1:12345', detail: 'Local ready' }
    };
    mounted.push(structuredClone(mounted.state));
    await waitFor(() =>
      expect(slot.querySelector<HTMLInputElement>('.row-inline input[readonly]')?.value).toBe(
        'http://127.0.0.1:12345/mcp/desktop/localtok?client=gemini'
      )
    );
  });

  it('toggles external calls, Keep URL tokens, Settings reveal for strict allowlist, and live Gemini status', async () => {
    const mounted = await mountChat();
    const doc = mounted.window.document;
    mounted.state.config = {
      ...mounted.state.config,
      tunnel: { ...mounted.state.config.tunnel, kind: 'cloudflared' },
      mcp: { instructions: '', persistentUrls: false },
      multiAgent: { ...mounted.state.config.multiAgent, allowUnattributedCalls: false, strictChatAllowlist: false }
    };
    mounted.state.status = {
      ...mounted.state.status,
      state: 'connected',
      surfaces: [makeSurface('core')],
      externalClients: []
    };
    mounted.push(structuredClone(mounted.state));

    doc.querySelector<HTMLButtonElement>('button[data-tab="setup"]')!.click();
    const slot = doc.getElementById('geminiConnectorCard')!;

    await waitFor(() =>
      expect([...slot.querySelectorAll('button')].some((b) => b.textContent === 'Allow Gemini calls')).toBe(true)
    );
    expect(slot.querySelectorAll('.gemini-guide-moves .guide-move')).toHaveLength(4);
    expect([...slot.querySelectorAll('.gemini-guide-moves .guide-move')].map((el) => el.classList.contains('is-done'))).toEqual([
      true,
      false,
      false,
      false
    ]);

    const help = slot.querySelector<HTMLDetailsElement>('.gemini-help')!;
    expect(help).not.toBeNull();
    expect(help.textContent).toContain('Using Gemini with this app & troubleshooting');
    expect(doc.querySelectorAll('#connectorCards details')).toHaveLength(0);
    help.open = true;

    [...slot.querySelectorAll('button')].find((b) => b.textContent === 'Allow Gemini calls')!.click();
    await waitFor(() => expect(mounted.calls.at(-1)?.multiAgent?.allowUnattributedCalls).toBe(true));

    mounted.state.config = { ...mounted.state.config, multiAgent: { ...mounted.state.config.multiAgent, allowUnattributedCalls: true } };
    mounted.push(structuredClone(mounted.state));
    await waitFor(() => expect(slot.textContent).toContain('3 tools enabled on the selected server'));
    expect(slot.querySelector<HTMLDetailsElement>('.gemini-help')!.open).toBe(true);
    expect([...slot.querySelectorAll('.gemini-guide-moves .guide-move')].map((el) => el.classList.contains('is-done'))).toEqual([
      true,
      true,
      false,
      false
    ]);

    [...slot.querySelectorAll('button')].find((b) => b.textContent === 'Keep URL tokens')!.click();
    await waitFor(() => expect(mounted.calls.at(-1)?.mcp?.persistentUrls).toBe(true));

    mounted.state.status = {
      ...mounted.state.status,
      externalClients: [
        {
          id: 'gemini',
          name: 'Gemini',
          surfaces: ['core'],
          connected: true,
          lastRequestAt: Date.now() - 5_000,
          lastToolCallAt: Date.now() - 2_000
        }
      ]
    };
    mounted.push(structuredClone(mounted.state));
    await waitFor(() => expect(slot.querySelector('.pill.is-live')?.textContent).toBe('Gemini connected'));
    expect(slot.querySelector('[data-gemini-status]')?.textContent).toContain('Gemini connected — ran a tool');
    expect([...slot.querySelectorAll('.gemini-guide-moves .guide-move')].map((el) => el.classList.contains('is-done'))).toEqual([
      true,
      true,
      true,
      true
    ]);

    mounted.state.config = {
      ...mounted.state.config,
      multiAgent: { ...mounted.state.config.multiAgent, strictChatAllowlist: true }
    };
    mounted.push(structuredClone(mounted.state));
    await waitFor(() =>
      expect([...slot.querySelectorAll('button')].some((b) => b.textContent === 'Review in Settings')).toBe(true)
    );
    [...slot.querySelectorAll('button')].find((b) => b.textContent === 'Review in Settings')!.click();
    expect(doc.querySelector('button[data-tab="agents-tools"]')!.classList.contains('is-sel')).toBe(true);
    expect(doc.getElementById('strictChatAllowlist')!.closest('[hidden]')).toBeNull();
    expect(doc.activeElement).toBe(doc.getElementById('strictChatAllowlist'));
  });
});
