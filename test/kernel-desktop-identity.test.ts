import { expect, it, vi } from 'vitest';
vi.mock('../src/main/session/recorder.js', async original => ({
  ...await original<typeof import('../src/main/session/recorder.js')>(),
  recordToolCall: async () => null
}));
vi.mock('../src/main/session/store.js', async original => ({
  ...await original<typeof import('../src/main/session/store.js')>(),
  conversationAttachment: async () => 'current'
}));
import { dispatch, ok } from '../src/main/mcp/kernel.js';
import { currentCall } from '../src/main/mcp/call-context.js';
import { observeRequestCorrelation } from '../src/main/session/correlation.js';

it.each(['get_window_state', 'click', 'scroll', 'drag', 'set_value', 'perform_secondary_action'])(
  'resolves late exact identity before Desktop %s consumes observation state', async name => {
    const requestId = `late-desktop-${name}`;
    const run = vi.fn(async () => {
      expect(currentCall()?.caller).toMatchObject({ requestId, conversationId: 'desktop-chat', sessionId: 'desktop-session' });
      return ok('observed');
    });
    const pending = dispatch(name, {}, null, requestId, 'desktop', run);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(run).not.toHaveBeenCalled();
    observeRequestCorrelation({ requestId, conversationId: 'desktop-chat', sessionId: 'desktop-session',
      messageId: `message-${name}`, tool: name, observedAt: Date.now() });
    expect((await pending).isError).not.toBe(true);
    expect(run).toHaveBeenCalledOnce();
  }
);
