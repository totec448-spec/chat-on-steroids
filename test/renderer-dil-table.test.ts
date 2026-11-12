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

const table = (rows: string[][]) => '<div data-d-component="table"><table>' +
  row(['項目', '数量'], true) + rows.map(values => row(values)).join('') + '</table></div>';
const header = '| 項目 | 数量 |\n|---|---|';

it.each([
  ['missing', '', [['米', '1 kg']]],
  ['complete', '\n| 米 | 1 kg |', [['米', '1 kg']]],
  ['partial', '\n| 米 | 1 kg |', [['米', '1 kg'], ['パン', '3 個']]],
  ['empty', '', []]
] as const)('pairs repeated headers in order when the first table is %s', (_name, body, firstRows) => {
  const markup = table(firstRows.map(values => [...values])) + table([['牛乳', '2 l']]);
  const drawing = { text: markup, truncated: false, chars: markup.length };
  const source = `## Before\n${header}${body}\n\n## After\n${header}`;
  const completed = completedDilText(source, drawing);
  const [before, after] = completed.split('## After\n');
  expect(after).toBe(`${header}\n| 牛乳 | 2 l |`);
  expect(before).not.toContain('牛乳');
  expect(completed.match(/\| 牛乳 \| 2 l \|/g)).toHaveLength(1);
  const rendered = renderedMarkdown(source, drawing);
  expect([...rendered.querySelectorAll('table')].map(node => node.textContent)).toEqual([
    expect.not.stringContaining('牛乳'), expect.stringContaining('牛乳')
  ]);
});

it('leaves unmatched Markdown tables alone without consuming the next matching drawing', () => {
  const source = '| Other | Columns |\n|---|---|\n\n' + header;
  expect(completedDilText(source, { text: table([['米', '1 kg']]) }))
    .toBe(`${source}\n| 米 | 1 kg |`);
});

it.each([
  ['backticks', `\`\`\`markdown\n${header}\n[コピー]\n\`\`\``],
  ['tildes', `~~~markdown\n${header}\n[コピー]\n~~~`],
  ['longer opener', `\`\`\`\`markdown\n\`\`\`\n${header}\n[コピー]\n\`\`\`\``],
  ['different closing marker', `~~~markdown\n\`\`\`\n${header}\n[コピー]\n~~~`],
  ['indented code', header.split('\n').concat('[コピー]').map(line => `    ${line}`).join('\n')],
  ['tab-indented code', header.split('\n').concat('[コピー]').map(line => `\t${line}`).join('\n')],
  ['list fence', `- \`\`\`markdown\n  ${header.replace(/\n/g, '\n  ')}\n  [コピー]\n  \`\`\``],
  ['quote ends without closing fence', `> \`\`\`markdown\n> ${header.replace(/\n/g, '\n> ')}\n> [コピー]`],
  ['multiline inline code', '`example\n[コピー]\nend`'],
  ['CRLF', `\`\`\`markdown\r\n${header.replace(/\n/g, '\r\n')}\r\n[コピー]\r\n\`\`\``]
])('keeps %s examples literal without consuming the real table or deleting code labels', (_name, example) => {
  const markup = table([['米', '1 kg']]) + '<button data-d-component="button">コピー</button>';
  const drawing = { text: markup, truncated: false, chars: markup.length };
  const source = `${example}\n\n実際の表:\n${header}\n\n[コピー]`;
  expect(completedDilText(source, drawing)).toBe(`${example}\n\n実際の表:\n${header}\n| 米 | 1 kg |\n`);
  const rendered = renderedMarkdown(source, drawing);
  expect(rendered.querySelectorAll('table')).toHaveLength(1);
  expect(rendered.querySelector('table')?.textContent).toContain('米');
  expect(rendered.querySelector('code')?.textContent).toContain('[コピー]');
  expect(rendered.querySelector('code')?.textContent).not.toContain('米');
});

it.each(['\n', '\r\n'])('drops the real button label after odd and even backslash runs (%j)', newline => {
  const markup = '<button data-d-component="button">Copy</button>';
  const drawing = { text: markup, truncated: false, chars: markup.length };
  for (const count of [1, 2, 3, 4]) {
    const even = count % 2 === 0;
    const prefix = 'prefix ' + '\\'.repeat(count) + (even ? '`code`' : '`literal');
    const suffix = 'post `unmatched';
    const source = [prefix, '[Copy]', suffix].join(newline);
    expect(completedDilText(source, drawing), `${count} backslashes`).toBe([prefix, suffix].join(newline));
    const rendered = renderedMarkdown(source, drawing);
    expect(rendered.textContent).not.toContain('[Copy]');
    if (even) expect(rendered.querySelector('code')?.textContent).toBe('code');
    else expect(rendered.querySelector('code')).toBeNull();
  }
});

it('leaves an unclosed fence unchanged, and still completes tables with inline-code column headings', () => {
  const drawing = { text: table([['米', '1 kg']]) };
  const open = `\`\`\`markdown\n${header}`;
  expect(completedDilText(open, drawing)).toBe(open);
  // Inline code in a genuine table cell is not a code block containing the table.
  const markup = '<div data-d-component="table"><table>' + row(['`項目`', '数量']) + row(['米', '1 kg']) + '</table></div>';
  const inlineHeader = '| `項目` | 数量 |\n|---|---|';
  expect(completedDilText(inlineHeader, { text: markup })).toBe(`${inlineHeader}\n| 米 | 1 kg |`);
});

it.each(['\n', '\r\n'])('does not join unmatched backticks across %j paragraph breaks', newline => {
  for (const blank of ['', ' \t']) {
    const source = ['`Unmatched before', blank, ...header.split('\n'), blank, '`Unmatched after'].join(newline);
    const markup = table([['米', '1 kg']]);
    const drawing = { text: markup, truncated: false, chars: markup.length };
    const completed = completedDilText(source, drawing);
    expect(completed).toContain('| 米 | 1 kg |');
    expect(completed).toContain('`Unmatched before');
    expect(completed).toContain('`Unmatched after');
    const rendered = renderedMarkdown(source, drawing);
    expect([...rendered.querySelectorAll('tbody tr')].filter(row => row.textContent?.includes('米'))).toHaveLength(1);
    expect(rendered.querySelector('tbody')?.textContent).toContain('米');
    expect(rendered.querySelector('code')).toBeNull();
  }
});

it.each(['\n', '\r\n'])('completes a table between unmatched ticks without blank lines (%j)', newline => {
  for (const [marker, indent] of [['', ''], ['- ', '  ']]) {
    const source = [marker + '`Unmatched before', ...header.split('\n').map(line => indent + line),
      indent + '## `Unmatched after'].join(newline);
    const markup = table([['米', '1 kg']]);
    const drawing = { text: markup, truncated: false, chars: markup.length };
    const completed = completedDilText(source, drawing);
    expect(completed).toContain('| 米 | 1 kg |');
    expect(completed).toContain('`Unmatched before');
    expect(completed).toContain('## `Unmatched after');
    const rendered = renderedMarkdown(source, drawing);
    expect(rendered.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(rendered.querySelector('tbody')?.textContent).toContain('米');
    expect(rendered.querySelector('code')).toBeNull();
    if (marker) expect(rendered.querySelector('li table tbody')?.textContent).toContain('米');
  }
});

it.each(['\n', '\r\n'])('does not pair ticks in indented code with an inline-code table heading (%j)', newline => {
  const inlineHeader = '| `項目` | 数量 |\n|---|---|';
  const markup = '<div data-d-component="table"><table>' + row(['`項目`', '数量']) + row(['米', '1 kg']) + '</table></div>';
  for (const indent of ['    ', '\t']) {
    const example = `${indent}\`example`;
    const source = `${example}\n${inlineHeader}`.replace(/\n/g, newline);
    const drawing = { text: markup, truncated: false, chars: markup.length };
    const completed = completedDilText(source, drawing);
    expect(completed).toContain('| 米 | 1 kg |');
    expect(completed.split(newline)[0]).toBe(example);
    const rendered = renderedMarkdown(source, drawing);
    expect(rendered.querySelector('pre code')?.textContent).toBe('`example\n');
    expect(rendered.querySelector('tbody')?.textContent).toContain('米');
  }
});

it.each(['\n', '\r\n'])('keeps indented literal list/fence markers from hiding a real table (%j)', newline => {
  const drawing = { text: table([['米', '1 kg']]) };
  for (const indent of ['    ', '\t', ' \t']) {
    for (const literal of ['- ```markdown', '1. ~~~markdown', '> ```markdown']) {
      const example = `${indent}${literal}`;
      const source = `${example}\n\n${header}`.replace(/\n/g, newline);
      const completed = completedDilText(source, drawing);
      expect(completed).toContain('| 米 | 1 kg |');
      expect(completed.split(newline)[0]).toBe(example);
      const rendered = renderedMarkdown(source, { ...drawing, truncated: false, chars: drawing.text.length });
      expect(rendered.querySelector('pre code')?.textContent).toContain(literal);
      expect(rendered.querySelector('tbody')?.textContent).toContain('米');
    }
  }
});


it.each([
  ['- Example\n\n      - ```markdown', '- ```markdown'],
  ['    Previous code line\n    - ```markdown', '- ```markdown'],
  ['```text\nEarlier fence\n```\n    - ```markdown', '- ```markdown']
])('ignores literal fences at code block boundaries: %s', (example, literal) => {
  const drawing = { text: table([['米', '1 kg']]) };
  const source = `${example}\n\n${header}`;
  expect(completedDilText(source, drawing)).toContain('| 米 | 1 kg |');
  const rendered = renderedMarkdown(source, { ...drawing, truncated: false, chars: drawing.text.length });
  expect([...rendered.querySelectorAll('pre code')].some(code => code.textContent?.includes(literal))).toBe(true);
  expect(rendered.querySelector('tbody')?.textContent).toContain('米');
});

it.each(['- ```markdown\n  example\n  ```', '- Item\n  ```markdown\n  example\n  ```', '- Item\n\n    ```markdown\n    example\n    ```'])('retains genuine list fences: %s', example => {
  const drawing = { text: table([['米', '1 kg']]) };
  const source = `${example}\n\n${header}`;
  expect(completedDilText(source, drawing)).toContain('| 米 | 1 kg |');
  const rendered = renderedMarkdown(source, { ...drawing, truncated: false, chars: drawing.text.length });
  expect(rendered.querySelector('pre code')?.textContent).toContain('example');
  expect(rendered.querySelector('tbody')?.textContent).toContain('米');
});

it.each(['\n', '\r\n'])('keeps literal container fences inside list code examples (%j)', newline => {
  for (const [open, indent, close] of [
    ['1. Show it:\n   ```markdown', '   ', '   ```'],
    ['- ```markdown', '  ', '  ```']
  ] as const) {
    for (const marker of ['- ```', '1. ```', '> ```']) {
      const example = [open, indent + marker, ...header.split('\n').map(line => indent + line),
        indent + '[コピー]', close].join('\n').replace(/\n/g, newline);
      const source = `${example}${newline}${newline}${header.replace(/\n/g, newline)}`;
      const markup = table([['米', '1 kg']]) + '<button data-d-component="button">コピー</button>';
      const drawing = { text: markup, truncated: false, chars: markup.length };
      expect(completedDilText(source, drawing)).toBe(`${source}\n| 米 | 1 kg |`);
      const rendered = renderedMarkdown(source, drawing);
      expect(rendered.querySelector('pre code')?.textContent).toContain(marker);
      expect(rendered.querySelector('pre code')?.textContent).toContain('[コピー]');
      expect(rendered.querySelector('pre code')?.textContent).not.toContain('米');
      expect(rendered.querySelectorAll('table')).toHaveLength(1);
      expect(rendered.querySelector('tbody')?.textContent).toContain('米');
    }
  }
});

it.each([4, 5])('keeps code labels after a lazy list continuation and a fence at column %s', columns => {
  const indent = ' '.repeat(columns);
  const example = `- Example\nlazy continuation\n${indent}\`\`\`markdown\n\n  [コピー]\n${indent}\`\`\``;
  const markup = table([['米', '1 kg']]) + '<button data-d-component="button">コピー</button>';
  const drawing = { text: markup, truncated: false, chars: markup.length };
  const source = `${example}\n\n${header}\n\n[コピー]`;
  expect(completedDilText(source, drawing)).toBe(`${example}\n\n${header}\n| 米 | 1 kg |\n`);
  expect(renderedMarkdown(source, drawing).querySelector('pre code')?.textContent).toContain('[コピー]');
});

it.each(['\n', '\r\n'])('completes the real table after a quoted fence in the same list item (%j)', newline => {
  const example = ['- > ```markdown', ...header.split('\n').map(line => '  > ' + line), '  > ```'];
  const source = [...example, '', ...header.split('\n').map(line => '  ' + line)].join(newline);
  const markup = table([['米', '1 kg']]);
  const drawing = { text: markup, truncated: false, chars: markup.length };
  expect(completedDilText(source, drawing)).toBe(source + '\n  | 米 | 1 kg |');
  const rendered = renderedMarkdown(source, drawing);
  expect(rendered.querySelector('li blockquote pre code')?.textContent?.trim()).toBe(header);
  expect(rendered.querySelector('li table tbody')?.textContent).toContain('米');
});

it.each(['\n', '\r\n'])('completes a real list table after lazy continuation without changing code indentation (%j)', newline => {
  for (const spaces of [4, 5]) {
    const indent = ' '.repeat(spaces);
    const source = `- Example\nlazy continuation\n\n${indent}${header.replace(/\n/g, `\n${indent}`)}`.replace(/\n/g, newline);
    const markup = table([['米', '1 kg']]);
    const drawing = { text: markup, truncated: false, chars: markup.length };
    const completed = completedDilText(source, drawing);
    expect(completed).toBe(`${source}\n${indent}| 米 | 1 kg |`);
    const rendered = renderedMarkdown(source, drawing);
    expect(rendered.querySelector('li table tbody')?.textContent).toContain('米');
    expect(rendered.querySelector('pre code')).toBeNull();
  }
});

it('renders a drawn table before a megabyte paragraph of unmatched tick runs', () => {
  const markup = table([['米', '1 kg']]);
  const source = header + '\n\nExample: ' + Array.from({ length: 1600 }, (_, index) => '`'.repeat(index + 1) + ' x ').join('');
  const drawing = { text: markup, truncated: false, chars: markup.length };
  const rendered = renderedMarkdown(source, drawing);
  expect(rendered.querySelector('tbody')?.textContent).toContain('米');
  expect(rendered.querySelectorAll('tbody tr')).toHaveLength(1);
});
