import { afterEach, expect, it, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { appProxySettings, applyAppProxy } from '../src/main/app-proxy.js';
import * as logger from '../src/main/logger.js';

// #1255 follow-up: the tunnel learned the system proxy in 2.1.36, but the app's own requests (update
// check, Skills from GitHub, Goal providers, remote plugins) still went out directly and failed on
// networks whose only way out is that proxy.

const LOCAL = 'localhost,127.0.0.1,::1,.localhost';
// Node 24.14+ (Electron's runtime) has it; older Node, as on some CI runners, does not.
const builtIn = typeof http.setGlobalProxyFromEnv === 'function';

afterEach(async () => {
  await applyAppProxy(async () => 'DIRECT', [], {});
  vi.restoreAllMocks();
});

it('uses the system HTTP proxy for every app request, keeping local addresses direct', () => {
  expect(appProxySettings('PROXY 127.0.0.1:7890; DIRECT', {}, [])).toEqual({
    HTTP_PROXY: 'http://127.0.0.1:7890', HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: LOCAL
  });
  expect(appProxySettings('HTTPS proxy.corp:443', {}, [])).toMatchObject({ HTTPS_PROXY: 'https://proxy.corp:443' });
});

it('stays direct without a proxy, and with one Node cannot use', () => {
  expect(appProxySettings('DIRECT', {}, [])).toBeNull();
  // Node's built-in support has no SOCKS; going direct is what the app did before.
  expect(appProxySettings('SOCKS5 127.0.0.1:1080', {}, [])).toBeNull();
});

it('lets a proxy the person set win, and keeps their own exceptions', () => {
  expect(appProxySettings('PROXY 127.0.0.1:7890', { https_proxy: 'http://user:pw@corp:3128', NO_PROXY: 'intranet.example' }, [])).toEqual({
    HTTP_PROXY: 'http://user:pw@corp:3128', HTTPS_PROXY: 'http://user:pw@corp:3128', NO_PROXY: `intranet.example,${LOCAL}`
  });
  expect(appProxySettings('DIRECT', { HTTP_PROXY: 'http://corp:3128' }, [])).toMatchObject({ HTTPS_PROXY: 'http://corp:3128' });
});

it('keeps endpoints the system reaches directly out of the proxy', () => {
  // NO_PROXY matches exact hosts and domain suffixes, not address ranges, so a LAN model server is named.
  expect(appProxySettings('PROXY 127.0.0.1:7890', {}, ['192.168.1.20', 'gpu.lan'])?.NO_PROXY).toBe(`${LOCAL},192.168.1.20,gpu.lan`);
});

it.skipIf(!builtIn)('routes fetch through the proxy, skips direct endpoints, and goes back to direct', async () => {
  const target = http.createServer((_req, res) => res.end('reached'));
  const tunnels: string[] = [];
  const proxy = http.createServer((_req, res) => res.end('plain'));
  proxy.on('connect', (req, socket) => {
    tunnels.push(String(req.url));
    // Every tunnel leads to the local target, whatever host was asked for.
    const upstream = net.connect((target.address() as AddressInfo).port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(socket); socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
  });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxy.address() as AddressInfo).port;
  const targetPort = (target.address() as AddressInfo).port;
  vi.spyOn(logger, 'logInfo').mockImplementation(() => undefined);
  try {
    const resolve = async (url: string) => url.includes('provider.invalid') ? 'DIRECT' : `PROXY 127.0.0.1:${proxyPort}`;
    await applyAppProxy(resolve, ['http://provider.invalid:9/v1'], {});

    expect(await (await fetch(`http://updates.invalid:${targetPort}/`, { signal: AbortSignal.timeout(5000) })).text()).toBe('reached');
    expect(tunnels).toEqual([`updates.invalid:${targetPort}`]);
    // Local servers and an endpoint the system reaches directly never see the proxy.
    expect(await (await fetch(`http://127.0.0.1:${targetPort}/`)).text()).toBe('reached');
    await fetch('http://provider.invalid:9/', { signal: AbortSignal.timeout(5000) }).catch(() => null);
    expect(tunnels).toHaveLength(1);

    await applyAppProxy(async () => 'DIRECT', [], {});
    await fetch(`http://updates.invalid:${targetPort}/`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    expect(tunnels).toHaveLength(1);
  } finally {
    await new Promise(resolve => proxy.close(resolve));
    await new Promise(resolve => target.close(resolve));
  }
});

it.skipIf(!builtIn)('says once which proxy app requests use, without its password', async () => {
  const info = vi.spyOn(logger, 'logInfo').mockImplementation(() => undefined);
  await applyAppProxy(async () => 'DIRECT', [], { HTTPS_PROXY: 'http://user:secret@corp:3128' });
  await applyAppProxy(async () => 'DIRECT', [], { HTTPS_PROXY: 'http://user:secret@corp:3128' });
  const lines = info.mock.calls.map(([line]) => String(line)).filter(line => /app requests/i.test(line));
  expect(lines).toEqual(['App requests go via proxy http://corp:3128']);
});
