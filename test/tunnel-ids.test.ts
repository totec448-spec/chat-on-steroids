import { describe, expect, it } from 'vitest';

import { connectorsSharingTunnel } from '../src/shared/tunnel-ids.js';

const A = 'tunnel_0123456789abcdef0123456789abcdef';
const B = 'tunnel_fedcba9876543210fedcba9876543210';

describe('connectorsSharingTunnel (#1340)', () => {
  it('names every other connector configured on the same Secure Tunnel ID', () => {
    const tunnel = { tunnelId: A, desktopTunnelId: A, pluginsTunnelId: ` ${A} ` };
    expect(connectorsSharingTunnel(tunnel, 'core')).toEqual(['desktop', 'plugins']);
    expect(connectorsSharingTunnel(tunnel, 'plugins')).toEqual(['core', 'desktop']);
  });

  it('finds nothing for distinct, empty or missing IDs', () => {
    expect(connectorsSharingTunnel({ tunnelId: A, desktopTunnelId: B, pluginsTunnelId: '' }, 'core')).toEqual([]);
    expect(connectorsSharingTunnel({ tunnelId: '', desktopTunnelId: '', pluginsTunnelId: '' }, 'desktop')).toEqual([]);
    expect(connectorsSharingTunnel({ tunnelId: A }, 'plugins')).toEqual([]);
  });
});

describe('the shared tunnel ID warning under a tunnel field', () => {
  it('names the other connectors, follows the language, and hides once the IDs differ', async () => {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<p hidden></p>', { url: 'https://local.test/' });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
    const { setLanguage } = await import('../src/renderer/i18n.js');
    const { paintSharedTunnel } = await import('../src/renderer/tunnel-warning.js');
    const note = dom.window.document.querySelector('p')!;

    paintSharedTunnel(note, { tunnelId: A, desktopTunnelId: '', pluginsTunnelId: A }, 'plugins');
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain('also set for Core');
    expect(note.textContent).toContain('UNKNOWN_TOOL');
    setLanguage('de');
    expect(note.textContent).toContain('auch für Core eingetragen');
    setLanguage('en');

    paintSharedTunnel(note, { tunnelId: A, desktopTunnelId: '', pluginsTunnelId: B }, 'plugins');
    expect(note.hidden).toBe(true);
    expect(note.textContent).toBe('');
    dom.window.close();
  });
});
