import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { initAgentPanelResize } from '../src/renderer/agent-panel-resize.js';

let dom: JSDOM;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); });

it('resizes the right panel from its left edge, persists width, clamps, supports keyboard, and resets', () => {
  dom = new JSDOM('<div class="app"><aside id="sidebar"></aside><aside id="agentPanel"><div id="agentPanelResize"></div></aside></div>', { url: 'https://local.test' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  const app = dom.window.document.querySelector<HTMLElement>('.app')!;
  const sidebar = dom.window.document.getElementById('sidebar')!;
  const panel = dom.window.document.getElementById('agentPanel')!;
  const handle = dom.window.document.getElementById('agentPanelResize')!;
  Object.defineProperty(dom.window, 'innerWidth', { value: 1400, configurable: true });
  sidebar.getBoundingClientRect = () => ({ width: 248 }) as DOMRect;
  panel.getBoundingClientRect = () => ({ width: parseFloat(app.style.getPropertyValue('--agent-panel-width')) || 500 }) as DOMRect;
  panel.inert = false;
  let captured = false;
  handle.setPointerCapture = () => { captured = true; };
  handle.hasPointerCapture = () => captured;
  handle.releasePointerCapture = () => { captured = false; };
  initAgentPanelResize(app, panel, handle);

  const pointer = (type: string, x: number) => {
    const event = new dom.window.MouseEvent(type, { clientX: x, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 9 });
    handle.dispatchEvent(event);
  };
  pointer('pointerdown', 900); pointer('pointermove', 500); pointer('pointerup', 500);
  expect(captured).toBe(false);
  expect(app.classList.contains('is-resizing-agent-panel')).toBe(false);
  expect(app.style.getPropertyValue('--agent-panel-width')).toBe('720px');
  expect(localStorage.getItem('chat-on-steroids.agent-panel-width')).toBe('720');

  handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home' }));
  expect(app.style.getPropertyValue('--agent-panel-width')).toBe('340px');
  handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft' }));
  expect(app.style.getPropertyValue('--agent-panel-width')).toBe('350px');

  Object.defineProperty(dom.window, 'innerWidth', { value: 900, configurable: true });
  dom.window.dispatchEvent(new dom.window.Event('resize'));
  expect(app.style.getPropertyValue('--agent-panel-width')).toBe('340px');

  Object.defineProperty(dom.window, 'innerWidth', { value: 1400, configurable: true });
  dom.window.dispatchEvent(new dom.window.Event('resize'));
  handle.dispatchEvent(new dom.window.MouseEvent('dblclick'));
  expect(app.style.getPropertyValue('--agent-panel-width')).toBe('400px');
  expect(localStorage.getItem('chat-on-steroids.agent-panel-width')).toBeNull();
});
