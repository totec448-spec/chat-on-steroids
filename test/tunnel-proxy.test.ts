import { describe, expect, it } from 'vitest';
import { proxyEnvironment, proxyForLog, proxyUrlFromResolution } from '../src/main/tunnel/proxy.js';

// #1255: the tunnel program only knows proxies from its environment. With a system proxy set
// (and no TUN-style capture), it could not get out, and ChatGPT reported
// "Tunnel-client has not been seen".
describe("the system's proxy, as the tunnel program understands it", () => {
  it('turns the browser engine\'s answer into a proxy address', () => {
    expect(proxyUrlFromResolution('DIRECT')).toBeNull();
    expect(proxyUrlFromResolution('')).toBeNull();
    expect(proxyUrlFromResolution('PROXY 127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
    expect(proxyUrlFromResolution('HTTPS proxy.example.test:8443')).toBe('https://proxy.example.test:8443');
    expect(proxyUrlFromResolution('SOCKS5 127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080');
    expect(proxyUrlFromResolution('PROXY [::1]:3128')).toBe('http://[::1]:3128');
  });

  it('takes the first usable entry of a list, and stops at DIRECT', () => {
    expect(proxyUrlFromResolution('PROXY 10.0.0.1:8080; PROXY 10.0.0.2:8080; DIRECT')).toBe('http://10.0.0.1:8080');
    // The tunnel program cannot use SOCKS4; the next entry can be used.
    expect(proxyUrlFromResolution('SOCKS 10.0.0.1:1080; PROXY 10.0.0.2:8080')).toBe('http://10.0.0.2:8080');
    expect(proxyUrlFromResolution('DIRECT; PROXY 10.0.0.2:8080')).toBeNull();
    expect(proxyUrlFromResolution('SOCKS4 10.0.0.1:1080')).toBeNull();
  });

  it('refuses anything that is not a plain host and port', () => {
    expect(proxyUrlFromResolution('PROXY user:secret@10.0.0.1:8080')).toBeNull();
    expect(proxyUrlFromResolution('PROXY 10.0.0.1')).toBeNull();
    expect(proxyUrlFromResolution('PROXY 10.0.0.1:8080/path')).toBeNull();
    expect(proxyUrlFromResolution('PROXY bad host:8080')).toBeNull();
  });

  it('gives the variables for a system proxy, and keeps local addresses direct', () => {
    expect(proxyEnvironment('PROXY 127.0.0.1:7890', {})).toEqual({
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost,127.0.0.1,::1'
    });
    expect(proxyEnvironment('PROXY 127.0.0.1:7890', { NO_PROXY: 'intranet.example.test' })).toEqual({ HTTPS_PROXY: 'http://127.0.0.1:7890' });
    expect(proxyEnvironment('DIRECT', {})).toEqual({});
  });

  it('leaves HTTPS_PROXY alone when the person set it, however it is spelled', () => {
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'Https_Proxy']) {
      expect(proxyEnvironment('PROXY 127.0.0.1:7890', { [name]: 'http://10.9.9.9:3128' })).toEqual({});
    }
    // An empty variable is not a setting, and HTTP_PROXY is about plain http only.
    expect(proxyEnvironment('PROXY 127.0.0.1:7890', { HTTPS_PROXY: '' })).toHaveProperty('HTTPS_PROXY', 'http://127.0.0.1:7890');
    expect(proxyEnvironment('PROXY 127.0.0.1:7890', { HTTP_PROXY: 'http://10.9.9.9:3128' })).toHaveProperty('HTTPS_PROXY', 'http://127.0.0.1:7890');
  });

  it('passes ALL_PROXY on, which the tunnel program does not read by itself', () => {
    expect(proxyEnvironment('DIRECT', { all_proxy: 'socks5://127.0.0.1:1080' })).toEqual({
      HTTPS_PROXY: 'socks5://127.0.0.1:1080',
      NO_PROXY: 'localhost,127.0.0.1,::1'
    });
    // It is the person's own setting: it wins over the system's, and one the program cannot use is not replaced.
    expect(proxyEnvironment('PROXY 127.0.0.1:7890', { ALL_PROXY: 'http://10.9.9.9:3128' })).toHaveProperty('HTTPS_PROXY', 'http://10.9.9.9:3128');
    expect(proxyEnvironment('PROXY 127.0.0.1:7890', { ALL_PROXY: 'socks4://10.9.9.9:1080' })).toEqual({});
  });

  it('keeps a proxy password out of the log', () => {
    expect(proxyForLog('http://jane:secret@10.9.9.9:3128')).toBe('http://10.9.9.9:3128');
    expect(proxyForLog('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080');
  });
});
