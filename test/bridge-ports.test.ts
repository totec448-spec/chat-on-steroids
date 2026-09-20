import { describe, expect, it } from 'vitest';
import { bridgePortSelection } from '../src/main/bridge-ports.js';
import { BROWSER_BRIDGE_PORTS } from '../src/shared/browser-bridge.js';

describe('bridge port candidates', () => {
  it('uses the supported order for Auto and exactly one candidate for each fixed choice', () => {
    expect(bridgePortSelection('auto', '')).toEqual({ candidates: BROWSER_BRIDGE_PORTS, overridden: false });
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
});
