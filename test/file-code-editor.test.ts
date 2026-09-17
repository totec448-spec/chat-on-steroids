import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createProjectCodeEditor } from '../src/renderer/file-code-editor.js';

let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<body><div id="editor"></div></body>', {
    url: 'https://cos.local/',
    pretendToBeVisual: true
  });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('MutationObserver', dom.window.MutationObserver);
  vi.stubGlobal('DOMRect', dom.window.DOMRect);
  vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  if (!dom.window.Range.prototype.getClientRects) {
    Object.defineProperty(dom.window.Range.prototype, 'getClientRects', { value: () => [] });
  }
  if (!dom.window.Range.prototype.getBoundingClientRect) {
    Object.defineProperty(dom.window.Range.prototype, 'getBoundingClientRect', { value: () => new dom.window.DOMRect() });
  }
});

afterEach(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

it('loads syntax support from the filename and renders a real line-number gutter', async () => {
  const changes: string[] = [];
  const parent = document.getElementById('editor')!;
  const editor = await createProjectCodeEditor({
    parent,
    filename: 'main.ts',
    text: 'const first = 1;\nfunction second() { return first; }\n',
    onChange: value => changes.push(value)
  });

  expect(editor.language).toMatch(/JavaScript|TypeScript/i);
  expect(parent.querySelector('.cm-editor')).not.toBeNull();
  expect(parent.querySelector('.cm-lineNumbers')).not.toBeNull();
  expect(parent.querySelectorAll('.cm-gutterElement').length).toBeGreaterThan(1);

  editor.view.dispatch({ changes: { from: 0, to: 5, insert: 'let' } });
  expect(editor.getValue()).toContain('let first');
  expect(changes.at(-1)).toContain('let first');
  editor.destroy();
});

it('falls back to plain text while keeping the same editor and line numbers for unknown files', async () => {
  const parent = document.getElementById('editor')!;
  const editor = await createProjectCodeEditor({
    parent,
    filename: 'notes.unknown-extension',
    text: 'one\ntwo\n',
    onChange: () => undefined
  });

  expect(editor.language).toBe('Plain text');
  expect(parent.querySelector('.cm-lineNumbers')).not.toBeNull();
  editor.destroy();
});

it('uses the same highlighted CodeMirror surface as a read-only viewer', async () => {
  const parent = document.getElementById('editor')!;
  const viewer = await createProjectCodeEditor({
    parent,
    filename: 'preview.ts',
    text: 'export function answer() { return 42; }\n',
    readOnly: true
  });

  expect(viewer.language).toMatch(/JavaScript|TypeScript/i);
  expect(parent.querySelector('.cm-lineNumbers')).not.toBeNull();
  expect(parent.querySelector<HTMLElement>('.cm-content')?.getAttribute('contenteditable')).toBe('false');
  expect(parent.querySelector('.cm-line span')).not.toBeNull();
  viewer.destroy();
});

it('preserves CRLF and the final newline when editing and bounds retained text', async () => {
  const editor = await createProjectCodeEditor({ parent: document.getElementById('editor')!, filename: 'notes.txt', text: '\uFEFFone\r\ntwo\r\n' });
  expect(editor.getValue()).toBe('\uFEFFone\r\ntwo\r\n');
  editor.view.dispatch({ changes: { from: 1, to: 4, insert: 'three' } });
  expect(editor.getValue()).toBe('\uFEFFthree\r\ntwo\r\n');
  editor.view.dispatch({ changes: { from: 0, insert: 'x'.repeat(256 * 1024) } });
  expect(editor.getValue()).toBe('\uFEFFthree\r\ntwo\r\n');
  editor.destroy();
});
