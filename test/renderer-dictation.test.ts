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

beforeAll(async () => {
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

afterAll(() => dom?.window.close());

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

  it('unsubscribes on page unload without sending a message', () => {
    dom.window.dispatchEvent(new dom.window.Event('beforeunload'));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
