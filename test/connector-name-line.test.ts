import { describe, expect, it } from 'vitest';
import { chatgptNameLine } from '../src/renderer/connector-name.js';

// A connector renamed in ChatGPT keeps working (app ID, 2026-10-11). The Setup card still tells the
// user the configured name to type, and adds one line with what ChatGPT calls it now.
describe('the Setup card line for a renamed connector', () => {
  it('names the connector as ChatGPT shows it when that differs from the configured name', () => {
    expect(chatgptNameLine({ connectorName: 'Chat On Steroids Core', chatgptName: 'My tools' })).toBe('In ChatGPT: My tools');
  });
  it('adds nothing when ChatGPT uses the configured name or nothing was learned', () => {
    expect(chatgptNameLine({ connectorName: 'Chat On Steroids Core', chatgptName: 'Chat On Steroids Core' })).toBeNull();
    expect(chatgptNameLine({ connectorName: 'Chat On Steroids Core', chatgptName: null })).toBeNull();
    expect(chatgptNameLine({ connectorName: 'Chat On Steroids Core' })).toBeNull();
  });
});
