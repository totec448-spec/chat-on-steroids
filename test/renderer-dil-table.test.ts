import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * #1477 (2026-10-15): ChatGPT's own Markdown for a drawn table listed only its header row, and
 * its "Copy complete list" button as the text "[Copiar lista completa]". The recorded drawing had
 * all twelve rows; the app showed the Markdown, so the list was empty.
 */
let dom: JSDOM;
let renderedMarkdown: typeof import('../src/renderer/chat.js').renderedMarkdown;
let completedDilText: typeof import('../src/shared/dil-tables.js').completedDilText;

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://local.test/' });
  Object.defineProperty(dom.window, 'api', { value: {}, configurable: true });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, DOMParser: dom.window.DOMParser,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node
  });
  ({ renderedMarkdown } = await import('../src/renderer/chat.js'));
  ({ completedDilText } = await import('../src/shared/dil-tables.js'));
});
afterAll(() => dom.window.close());

const cell = (text: string, strong = false) => `<td data-d-component="table-cell"><p data-d-component="text">${strong ? `<span data-d-default-strong="">${text}</span>` : text}</p></td>`;
const row = (cells: string[], strong = false) => `<tr data-d-component="table-row">${cells.map(value => cell(value, strong)).join('')}</tr>`;
const items = [['🍎 Fruta y verdura', 'Plátanos', '6 uds.'], ['🥛 Lácteos', 'Leche | entera', '2 litros'], ['📁 Oficina', 'Carpeta C:\\docs', '1'], ['🧻 Limpieza', 'Papel higiénico', '1 paquete']];
const html = '<div data-dil-message-id="m"><p data-d-component="text">Te dejo una lista.</p>' +
  '<div data-d-component="table"><table><tbody>' + row(['Categoría', 'Producto', 'Cantidad'], true) + items.map(item => row(item)).join('') +
  '</tbody></table></div><button type="button" data-d-component="button"><span><svg></svg><span> Copiar lista completa</span></span></button>' +
  '<p data-d-component="text">Puedes pulsar «Copiar lista completa».</p></div>';
const capture = { text: html, truncated: false, chars: html.length };
const markdown = 'Te dejo una lista.\n\n## 🛒 Lista de la compra\n\n| **Categoría** | **Producto** | **Cantidad** |\n|--------|--------|--------|\n\n[Copiar lista completa]\n\nPuedes pulsar **«Copiar lista completa»**.';

it('fills a table ChatGPT wrote with only its header from the rows it drew, and drops the dead button label', () => {
  const text = completedDilText(markdown, capture);
  expect(text).toContain('| 🍎 Fruta y verdura | Plátanos | 6 uds. |');
  expect(text).toContain('| 🥛 Lácteos | Leche \\| entera | 2 litros |');
  expect(text).toContain('| 🧻 Limpieza | Papel higiénico | 1 paquete |');
  // A backslash in a cell stays a backslash once Markdown reads it.
  expect(text).toContain('| 📁 Oficina | Carpeta C:\\\\docs | 1 |');
  expect(text).not.toMatch(/^\[Copiar lista completa\]$/m);
  // The sentence that names the button stays as ChatGPT wrote it.
  expect(text).toContain('Puedes pulsar **«Copiar lista completa»**.');
  const drawn = renderedMarkdown(markdown, capture);
  expect(drawn.querySelectorAll('tbody tr')).toHaveLength(4);
  expect(drawn.textContent).toContain('Carpeta C:\\docs');
  expect(drawn.textContent).not.toContain('[Copiar lista completa]');
});

it('changes nothing when the Markdown already has the rows, or the drawing is another table', () => {
  const complete = '| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |';
  const other = '<div data-d-component="table"><table>' + row(['A', 'B'], true) + row(['1', '2']) + row(['3', '4']) + '</table></div>';
  const otherCapture = { text: other, truncated: false, chars: other.length };
  expect(completedDilText(complete, otherCapture)).toBe(complete);
  const mismatch = '| X | Y |\n|---|---|';
  expect(completedDilText(mismatch, otherCapture)).toBe(mismatch);
  expect(completedDilText(markdown, undefined)).toBe(markdown);
  // A link or a reference in brackets is not a button the drawing has.
  expect(completedDilText('[Copiar lista completa](https://example.test)', capture)).toBe('[Copiar lista completa](https://example.test)');
});
