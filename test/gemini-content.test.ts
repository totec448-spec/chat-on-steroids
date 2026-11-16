import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const DOM_SCRIPT = fs.readFileSync(path.join(process.cwd(), 'extension', 'gemini-dom.js'), 'utf8');
const CONTENT_SCRIPT = fs.readFileSync(path.join(process.cwd(), 'extension', 'gemini-content.js'), 'utf8');

type AskCall = {
  message: Record<string, unknown>;
};

interface Harness {
  dom: JSDOM;
  asks: AskCall[];
  emitRuntimeMessage: (message: Record<string, unknown>) => Promise<unknown>;
  pushRoute: (url: string) => void;
  setBodyHtml: (html: string) => void;
  stop: () => void;
}

const activeHarnesses: Harness[] = [];

afterEach(() => {
  while (activeHarnesses.length > 0) {
    activeHarnesses.pop()!.stop();
  }
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

function mountGeminiContent(options: {
  url: string;
  html: string;
  onAsk?: (message: Record<string, unknown>) => unknown;
}): Harness {
  const dom = new JSDOM(options.html, { url: options.url });
  const asks: AskCall[] = [];
  const listeners: Array<(msg: Record<string, unknown>, sender: unknown, sendResponse: (res: unknown) => void) => boolean | void> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const intervals = new Set<ReturnType<typeof setInterval>>();

  const chrome = {
    runtime: {
      sendMessage: async (message: Record<string, unknown>) => {
        asks.push({ message });
        if (options.onAsk) return await options.onAsk(message);
        if (message.type === 'register_document') return { ok: true, keepAwake: false };
        if (message.type === 'events') return { ok: true, pending: 0 };
        if (message.type === 'bind') return { ok: true };
        return { ok: true };
      },
      onMessage: {
        addListener: (fn: (typeof listeners)[number]) => { listeners.push(fn); },
        removeListener: (fn: (typeof listeners)[number]) => {
          const idx = listeners.indexOf(fn);
          if (idx >= 0) listeners.splice(idx, 1);
        }
      }
    }
  };

  const sandbox: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    navigator: dom.window.navigator,
    MutationObserver: dom.window.MutationObserver,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    InputEvent: dom.window.InputEvent,
    URL,
    URLSearchParams,
    chrome,
    console,
    addEventListener: dom.window.addEventListener.bind(dom.window),
    removeEventListener: dom.window.removeEventListener.bind(dom.window),
    setTimeout: (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const id = setTimeout(fn, ms, ...args);
      timers.add(id);
      return id;
    },
    clearTimeout: (id: ReturnType<typeof setTimeout>) => {
      timers.delete(id);
      clearTimeout(id);
    },
    setInterval: (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const id = setInterval(fn, ms, ...args);
      intervals.add(id);
      return id;
    },
    clearInterval: (id: ReturnType<typeof setInterval>) => {
      intervals.delete(id);
      clearInterval(id);
    }
  };
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(DOM_SCRIPT, ctx);
  vm.runInContext(CONTENT_SCRIPT, ctx);

  const harness: Harness = {
    dom,
    asks,
    emitRuntimeMessage: (message) =>
      new Promise((resolve) => {
        let responded = false;
        let asyncHandled = false;
        const done = (res: unknown) => {
          if (!responded) {
            responded = true;
            resolve(res);
          }
        };
        for (const fn of [...listeners]) {
          if (fn(message, {}, done) === true) asyncHandled = true;
        }
        setTimeout(() => {
          if (!responded) resolve(undefined);
        }, asyncHandled ? 5_000 : 20);
      }),
    pushRoute: (url) => {
      dom.window.history.pushState({}, '', url);
    },
    setBodyHtml: (html) => {
      dom.window.document.body.innerHTML = html;
    },
    stop: () => {
      try {
        (sandbox.__COS_GEMINI_CONTENT__ as { stop?: () => void } | undefined)?.stop?.();
      } catch {
        /* ignore cleanup errors */
      }
      for (const id of timers) clearTimeout(id);
      timers.clear();
      for (const id of intervals) clearInterval(id);
      intervals.clear();
      dom.window.close();
    }
  };

  activeHarnesses.push(harness);
  return harness;
}

describe('gemini-content', () => {
  it('wraps flushed observations in { event, conversationId } envelopes and resets state across A -> /app -> B', async () => {
    const h = mountGeminiContent({
      url: 'https://gemini.google.com/app/aaaaaaaaaaaaaaaa',
      html: `<!doctype html><html><body>
        <div class="conversation-container">
          <user-query><div class="query-text"><p>Hi</p></div></user-query>
        </div>
        <rich-textarea><div class="ql-editor ql-blank" contenteditable="true" role="textbox"></div></rich-textarea>
      </body></html>`
    });
    await flushMicrotasks();

    const firstEvents = h.asks.filter((c) => c.message.type === 'events');
    expect(firstEvents.length).toBeGreaterThan(0);
    const firstEntries = firstEvents.flatMap((c) => (c.message.entries as Array<Record<string, unknown>>) || []);
    expect(firstEntries[0]).toMatchObject({
      conversationId: 'gemini-aaaaaaaaaaaaaaaa',
      event: {
        kind: 'user_message',
        messageId: 'gmsg-user-0',
        text: 'Hi'
      }
    });

    const askCountBeforeNav = h.asks.length;
    h.pushRoute('https://gemini.google.com/app');
    h.setBodyHtml('<rich-textarea><div class="ql-editor ql-blank" contenteditable="true" role="textbox"></div></rich-textarea>');
    await h.emitRuntimeMessage({ type: 'clf-route-changed' });
    await flushMicrotasks();

    h.pushRoute('https://gemini.google.com/app/bbbbbbbbbbbbbbbb');
    h.setBodyHtml(`
      <div class="conversation-container">
        <user-query><div class="query-text"><p>Hi</p></div></user-query>
      </div>
      <rich-textarea><div class="ql-editor ql-blank" contenteditable="true" role="textbox"></div></rich-textarea>
    `);
    await h.emitRuntimeMessage({ type: 'clf-route-changed' });
    await flushMicrotasks();

    const afterNavEntries = h.asks
      .slice(askCountBeforeNav)
      .filter((c) => c.message.type === 'events')
      .flatMap((c) => (c.message.entries as Array<Record<string, unknown>>) || []);
    expect(afterNavEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationId: 'gemini-bbbbbbbbbbbbbbbb',
          event: expect.objectContaining({
            kind: 'user_message',
            messageId: 'gmsg-user-0',
            text: 'Hi'
          })
        })
      ])
    );
  });

  it('aborts desktop input before inserting or sending if route changes mid-wait', async () => {
    let switchedDuringWait = false;
    let harnessRef: Harness | null = null;
    harnessRef = mountGeminiContent({
      url: 'https://gemini.google.com/app/aaaaaaaaaaaaaaaa',
      html: `<!doctype html><html><body>
        <rich-textarea><div class="ql-editor ql-blank" contenteditable="true" role="textbox"></div></rich-textarea>
      </body></html>`,
      onAsk: (msg) => {
        if (msg.type === 'register_document') return { ok: true, keepAwake: false };
        if (msg.type === 'events') return { ok: true, pending: 0 };
        if (msg.type === 'desktop_input' && msg.requiresAuthorization) {
          return { ok: true, data: { input: { id: 'in-1', owner: 'tab-1', text: 'Should stay out of chat B', requiresAuthorization: true } } };
        }
        if (msg.type === 'desktop_input' && msg.authorize) {
          if (!switchedDuringWait && harnessRef) {
            switchedDuringWait = true;
            // Temporarily unmount composer so waitForComposer waits across the SPA navigation.
            harnessRef.setBodyHtml('');
            setTimeout(() => {
              harnessRef!.pushRoute('https://gemini.google.com/app/bbbbbbbbbbbbbbbb');
              harnessRef!.setBodyHtml('<rich-textarea><div class="ql-editor ql-blank" contenteditable="true" role="textbox"></div></rich-textarea>');
            }, 30);
          }
          return { ok: true, data: { ok: true } };
        }
        return { ok: true };
      }
    });

    const reply = await harnessRef.emitRuntimeMessage({
      type: 'clf-desktop-input',
      id: 'in-1',
      conversationId: 'gemini-aaaaaaaaaaaaaaaa'
    });
    expect(reply).toEqual({ ok: false });
    const editorText = harnessRef.dom.window.document.querySelector('.ql-editor')?.textContent?.trim() || '';
    expect(editorText).toBe('');
    expect(harnessRef.asks.some((c) => c.message.type === 'desktop_input' && c.message.fail === true)).toBe(true);
  });

  it('keeps retryable redeem failures retryable and defers revivals without clobbering user drafts', async () => {
    let redeemAttempt = 0;
    const h = mountGeminiContent({
      url: 'https://gemini.google.com/app/cccccccccccccccc',
      html: `<!doctype html><html><body>
        <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"><p>Keep my draft</p></div></rich-textarea>
        <button class="send-button" aria-label="Send message"></button>
      </body></html>`,
      onAsk: (msg) => {
        if (msg.type === 'register_document') return { ok: true, keepAwake: false };
        if (msg.type === 'events') return { ok: true, pending: 0 };
        if (msg.type === 'redeem') {
          redeemAttempt += 1;
          if (redeemAttempt === 1) {
            return { ok: false, error: 'bridge_unreachable', retryable: true };
          }
          return {
            ok: true,
            command: {
              id: msg.id,
              conversationId: 'gemini-cccccccccccccccc',
              prompt: 'Revival prompt',
              agent: 'worker-1'
            }
          };
        }
        return { ok: true };
      }
    });
    await flushMicrotasks();

    // First attempt hits transient bridge error -> must stay retryable.
    await h.emitRuntimeMessage({ type: 'clf-run-command', id: 'cmd-revive-1' });
    expect(redeemAttempt).toBe(1);

    // Second attempt redeems the command, sees existing unsent draft, defers revival without clobbering.
    await h.emitRuntimeMessage({ type: 'clf-run-command', id: 'cmd-revive-1' });
    expect(redeemAttempt).toBe(2);
    expect(h.dom.window.document.querySelector('.ql-editor')?.textContent?.trim()).toBe('Keep my draft');
    expect(
      h.asks.some(
        (c) =>
          c.message.type === 'defer_revival' &&
          c.message.id === 'cmd-revive-1' &&
          c.message.conversationId === 'gemini-cccccccccccccccc'
      )
    ).toBe(true);
    expect(h.asks.some((c) => c.message.type === 'ack' && c.message.id === 'cmd-revive-1')).toBe(false);
  });
});
