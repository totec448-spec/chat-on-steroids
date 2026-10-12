import { describe, expect, it } from 'vitest';
import { bridgePortSelection } from '../src/main/bridge-ports.js';
import { readFileSync } from 'node:fs';
import { BROWSER_BRIDGE_AUTO_PORTS, BROWSER_BRIDGE_FALLBACK_PORTS, BROWSER_BRIDGE_PORTS } from '../src/shared/browser-bridge.js';

describe('bridge port candidates', () => {
  it('uses the supported order for Auto and exactly one candidate for each fixed choice', () => {
    expect(bridgePortSelection('auto', '')).toEqual({ candidates: BROWSER_BRIDGE_AUTO_PORTS, overridden: false });
    for (const port of BROWSER_BRIDGE_PORTS) {
      expect(bridgePortSelection(port, '')).toEqual({ candidates: [port], overridden: false });
    }
  });
  it('preserves the existing environment parser and ephemeral test isolation', () => {
    expect(bridgePortSelection(8767, '0')).toEqual({ candidates: [0], overridden: true });
    expect(bridgePortSelection(8767, '12345, bad, 65536, -1, 0')).toEqual({ candidates: [12345, 0], overridden: true });
    expect(bridgePortSelection(8767, 'bad,-1')).toEqual({ candidates: [8767], overridden: false });
    expect(bridgePortSelection('auto', '8768suffix')).toEqual({ candidates: [8768], overridden: true });
  });
  it('falls back to two distant ranges when Windows reserves 8765-8769 (#1314)', () => {
    // Hyper-V, WSL2 and Docker reserve blocks of ports; one reserved block covered the whole
    // range, so the bridge could not listen anywhere and the extension never connected.
    expect(BROWSER_BRIDGE_PORTS).toEqual([8765, 8766, 8767, 8768, 8769]);
    expect(BROWSER_BRIDGE_FALLBACK_PORTS).toEqual([18765, 18766, 18767, 18768, 18769, 38765, 38766, 38767, 38768, 38769]);
    expect(BROWSER_BRIDGE_AUTO_PORTS).toEqual([...BROWSER_BRIDGE_PORTS, ...BROWSER_BRIDGE_FALLBACK_PORTS]);
  });
  it('lets the extension find every port Auto may choose', () => {
    const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
    const literal = /^const PORTS = \[([0-9, ]+)\];$/m.exec(source)?.[1];
    expect(literal?.split(',').map(value => Number(value.trim()))).toEqual([...BROWSER_BRIDGE_AUTO_PORTS]);
    const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8')) as { host_permissions: string[] };
    for (const port of BROWSER_BRIDGE_AUTO_PORTS) expect(manifest.host_permissions).toContain(`http://127.0.0.1:${port}/*`);
  });
});
