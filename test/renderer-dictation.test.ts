import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DictationEvent } from '../src/shared/dictation.js';

let dom: JSDOM;
let input: HTMLTextAreaElement;
let button: HTMLButtonElement;
let status: HTMLElement;
let emit: (event: DictationEvent) => void;
const start = vi.fn(async () => ({ ok: true as const, data: { status: 'starting' } }));
const stop = vi.fn(async () => ({ ok: true as const, data: undefined }));
const unsubscribe = vi.fn();
// The hold-to-talk chord follows the platform; the suite runs as Windows unless a test says otherwise.
const setPlatform = (platform: string) => Object.defineProperty(globalThis.navigator, 'platform', { value: platform, configurable: true });

beforeAll(async () => {
  setPlatform('Win32');
  dom = new JSDOM(`<!doctype html><html><body>
    <form id="composer"><textarea id="chatInput"></textarea>
      <button id="dictationButton" type="button" disabled aria-pressed="false"></button>
      <p id="dictationStatus" role="status" hidden></p></form>
  </body></html>`, { url: 'https://local.test/' });
  dom.window.HTMLCanvasElement.prototype.getContext = (() => null) as typeof dom.window.HTMLCanvasElement.prototype.getContext;
  const api = { dictationSupported: true, startDictation: start, stopDictation: stop,
    onDictationEvent: (listener: (event: DictationEvent) => void) => { emit = listener; return unsubscribe; } };
  Object.defineProperty(dom.window, 'api', { value: api });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    Event: dom.window.Event });
  const { initComposerDictation } = await import('../src/renderer/chat.js');
  input = dom.window.document.getElementById('chatInput') as HTMLTextAreaElement;
  button = dom.window.document.getElementById('dictationButton') as HTMLButtonElement;
  status = dom.window.document.getElementById('dictationStatus')!;
  initComposerDictation();
});

afterAll(() => {
  delete (globalThis.navigator as { platform?: string }).platform;
  dom?.window.close();
});

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('renderer microphone draft ownership', () => {
  it('ships a real accessible composer control and its bundled icon mapping', async () => {
    const [html, css] = await Promise.all([
      readFile('src/renderer/index.html', 'utf8'),
      readFile('src/renderer/icons.css', 'utf8')
    ]);
    const page = new JSDOM(html);
    const mic = page.window.document.getElementById('dictationButton') as HTMLButtonElement;
    expect(mic.type).toBe('button');
    expect(mic.hidden).toBe(true);
    expect(mic.getAttribute('aria-pressed')).toBe('false');
    expect(mic.getAttribute('aria-describedby')).toBe('dictationStatus');
    expect(mic.closest('.composer-primary-controls')).not.toBeNull();
    expect(page.window.document.getElementById('dictationStatus')?.getAttribute('aria-live')).toBe('polite');
    expect(html).toContain('./dictation.css');
    expect(css).toMatch(/\.ph\.ph-microphone::before\s*\{\s*content:/);
    page.window.close();
  });
  it('does not record on page load and uses an accessible, non-submit button', () => {
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
    expect(button.hidden).toBe(false);
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('Start dictation');
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('replaces interim words, preserves surrounding authored text and never submits', async () => {
    let sends = 0;
    dom.window.document.getElementById('composer')!.addEventListener('submit', () => sends++);
    input.value = 'Before  after'; input.setSelectionRange(7, 7);
    button.click(); await flush();
    expect(start).toHaveBeenCalledTimes(1);
    emit({ type: 'status', status: 'listening' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    emit({ type: 'partial', text: 'weth' });
    expect(input.value).toBe('Before weth after');
    emit({ type: 'partial', text: 'weather' });
    expect(input.value).toBe('Before weather after');
    emit({ type: 'final', text: 'weather' });
    emit({ type: 'partial', text: 'tomorr' });
    emit({ type: 'final', text: 'tomorrow' });
    expect(input.value).toBe('Before weather tomorrow after');
    expect(sends).toBe(0);
    expect(status.textContent).toBe('Listening…');
  });

  it('keeps accepting final text after stop ACK until native stopped arrives', async () => {
    button.click(); await flush();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(button.getAttribute('data-state')).toBe('stopping');
    expect(button.disabled).toBe(true);
    emit({ type: 'final', text: 'please' });
    expect(input.value).toBe('Before weather tomorrow please after');
    emit({ type: 'status', status: 'stopped' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.disabled).toBe(false);
    expect(input.value).toBe('Before weather tomorrow please after');
  });

  it('stops on manual typing and ignores late results without changing user text', async () => {
    input.value = 'Manual'; input.setSelectionRange(6, 6);
    button.click(); await flush();
    expect(button.getAttribute('data-state')).toBe('starting');
    emit({ type: 'partial', text: 'test' });
    expect(input.value).toBe('Manualtest');
    expect(button.getAttribute('data-state')).toBe('starting');
    input.value = 'Manual edit'; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(button.getAttribute('data-state')).toBe('stopping');
    expect(button.disabled).toBe(true);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    emit({ type: 'final', text: 'ignored' });
    expect(input.value).toBe('Manual edit');
    emit({ type: 'status', status: 'stopped' });
    expect(button.getAttribute('data-state')).toBe('idle');
    expect(button.disabled).toBe(false);
  });

  it('shows native error without writing it to the prompt, and enables retry after shutdown', async () => {
    input.value = 'Keep my prompt'; input.setSelectionRange(input.value.length, input.value.length);
    button.click(); await flush();
    emit({ type: 'error', message: 'No Windows speech recognizer installed' });
    expect(input.value).toBe('Keep my prompt');
    expect(status.textContent).toContain('No Windows speech recognizer');
    expect(button.disabled).toBe(true);
    emit({ type: 'status', status: 'stopped' });
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Retry dictation');
  });

  it('says when only the basic Windows engine is listening, and how to get the better one', async () => {
    input.value = ''; input.setSelectionRange(0, 0);
    button.click(); await flush();
    emit({ type: 'status', status: 'listening', engine: 'legacy' });
    expect(status.textContent).toBe('Listening with basic accuracy. For punctuation and better results, turn on online speech recognition in Windows settings.');
    emit({ type: 'status', status: 'listening', engine: 'modern' });
    expect(status.textContent).toBe('Listening…');
    emit({ type: 'status', status: 'stopped' });
  });

  const holdKey = (type: 'keydown' | 'keyup', options: KeyboardEventInit = {}) => {
    const held = type === 'keydown';
    const event = new dom.window.KeyboardEvent(type, { code: 'Space', key: ' ', ctrlKey: held, shiftKey: held, bubbles: true, cancelable: true, ...options });
    input.dispatchEvent(event);
    return event;
  };

  it('records while Ctrl+Shift+Space is held in the composer, and letting go keeps the words without sending', async () => {
    let sends = 0;
    dom.window.document.getElementById('composer')!.addEventListener('submit', () => sends++);
    expect(button.title).toBe('Start dictation (hold Ctrl+Shift+Space)');
    input.value = 'Note: '; input.setSelectionRange(6, 6);
    const starts = start.mock.calls.length, stops = stop.mock.calls.length;
    expect(holdKey('keydown').defaultPrevented).toBe(true);
    await flush();
    expect(start).toHaveBeenCalledTimes(starts + 1);
    emit({ type: 'status', status: 'listening' });
    emit({ type: 'partial', text: 'hello wor' });
    expect(input.value).toBe('Note: hello wor');
    expect(holdKey('keydown', { repeat: true }).defaultPrevented).toBe(true);
    await flush();
    expect([start.mock.calls.length, stop.mock.calls.length]).toEqual([starts + 1, stops]);
    holdKey('keyup');
    expect(stop).toHaveBeenCalledTimes(stops + 1);
    expect(button.getAttribute('data-state')).toBe('stopping');
    emit({ type: 'final', text: 'hello world' });
    emit({ type: 'status', status: 'stopped' });
    expect(input.value).toBe('Note: hello world');
    expect(button.getAttribute('data-state')).toBe('idle');
    expect(sends).toBe(0);
  });

  it('stops a held recording when the window loses focus, and a press stops a clicked-on one', async () => {
    const stops = stop.mock.calls.length;
    holdKey('keydown'); await flush();
    dom.window.dispatchEvent(new dom.window.Event('blur'));
    expect(stop).toHaveBeenCalledTimes(stops + 1);
    emit({ type: 'status', status: 'stopped' });
    button.click(); await flush();
    holdKey('keydown'); await flush();
    expect(stop).toHaveBeenCalledTimes(stops + 2);
    holdKey('keyup');
    expect(stop).toHaveBeenCalledTimes(stops + 2);
    emit({ type: 'status', status: 'stopped' });
    expect(button.getAttribute('data-state')).toBe('idle');
  });

  it('keeps the last phrase and types no spaces when Ctrl or Shift is let go before Space', async () => {
    for (const modifier of ['Control', 'Shift']) {
      input.value = 'Note: '; input.setSelectionRange(6, 6);
      holdKey('keydown'); await flush();
      emit({ type: 'status', status: 'listening' });
      emit({ type: 'partial', text: 'still talk' });
      holdKey('keyup', { code: `${modifier}Left`, key: modifier });
      expect(button.getAttribute('data-state')).toBe('stopping');
      // Space is still down, so Windows keeps repeating it, now without the modifier.
      expect(holdKey('keydown', { ctrlKey: false, shiftKey: false, repeat: true }).defaultPrevented).toBe(true);
      emit({ type: 'final', text: 'still talking' });
      emit({ type: 'status', status: 'stopped' });
      expect(input.value).toBe('Note: still talking');
      holdKey('keyup');
      expect(holdKey('keydown', { ctrlKey: false, shiftKey: false }).defaultPrevented).toBe(false);
    }
    // The same when the chord stops a recording that a click started.
    input.value = 'Note: '; input.setSelectionRange(6, 6);
    button.click(); await flush();
    emit({ type: 'status', status: 'listening' });
    emit({ type: 'partial', text: 'clicked' });
    holdKey('keydown'); await flush();
    expect(button.getAttribute('data-state')).toBe('stopping');
    holdKey('keyup', { code: 'ShiftLeft', key: 'Shift' });
    expect(holdKey('keydown', { ctrlKey: false, shiftKey: false, repeat: true }).defaultPrevented).toBe(true);
    emit({ type: 'final', text: 'clicked on' });
    emit({ type: 'status', status: 'stopped' });
    expect(input.value).toBe('Note: clicked on');
    holdKey('keyup');
  });

  it('leaves Ctrl+Space, Shift+Space and Alt+Space to Windows and its IMEs', async () => {
    const starts = start.mock.calls.length;
    for (const chord of [{ shiftKey: false }, { ctrlKey: false }, { ctrlKey: false, shiftKey: false, altKey: true }]) {
      expect(holdKey('keydown', chord).defaultPrevented).toBe(false);
      await flush();
    }
    expect(start).toHaveBeenCalledTimes(starts);
    expect(button.getAttribute('data-state')).toBe('idle');
  });

  it('does not promise a hold shortcut in the tooltip on a platform that does not get one', async () => {
    const repaintIdle = async () => { button.click(); await flush(); emit({ type: 'status', status: 'stopped' }); };
    try {
      for (const platform of ['MacIntel', 'Linux x86_64']) {
        setPlatform(platform);
        await repaintIdle();
        expect(button.title).toBe('Start dictation');
        const starts = start.mock.calls.length;
        expect(holdKey('keydown').defaultPrevented).toBe(false);
        await flush();
        expect(start).toHaveBeenCalledTimes(starts);
      }
    } finally {
      setPlatform('Win32');
    }
    await repaintIdle();
    expect(button.title).toBe('Start dictation (hold Ctrl+Shift+Space)');
  });

  it('unsubscribes on page unload without sending a message', () => {
    dom.window.dispatchEvent(new dom.window.Event('beforeunload'));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
