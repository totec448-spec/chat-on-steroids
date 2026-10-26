import { Lexer, type Token, type Tokens } from 'marked';
import { plainTextOfHtml } from './content-reference.js';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
    const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** Block tokens end a line, so words of neighbouring blocks never run together. */
const BLOCKS = new Set(['paragraph', 'heading', 'blockquote', 'code', 'list_item', 'hr', 'space']);

/**
 * The words a Markdown message shows once drawn: no emphasis markers, backticks, link targets or
 * HTML tags. Find in chat matches what the person reads ("File: /src" in "**File:** `/src`").
 * `layout` also keeps what a list and a table draw around the words, for text a person pastes:
 * each item's bullet or number (indented by depth), task boxes, tabs between table cells and
 * image descriptions. `tidy` (with `layout`) also trims line ends and collapses runs of blank
 * lines between blocks, leaving what a code block holds exactly as written.
 */
export function markdownVisibleText(markdown: string, options: { codeBlocks?: boolean; layout?: boolean; tidy?: boolean } = {}): string {
  let tokens: Token[];
  try { tokens = new Lexer({ gfm: true }).lex(markdown); } catch { return markdown; }
  return tokensVisibleText(tokens, options);
}

/** The words of already-lexed tokens, as `markdownVisibleText` reads them. */
export function tokensVisibleText(tokens: readonly Token[], options: { codeBlocks?: boolean; layout?: boolean; tidy?: boolean } = {}): string {
  // Text between code blocks, and each code block's own text, which tidying must not touch.
  const runs: { text: string; code: boolean }[] = [];
  const parts: string[] = [];
  const flush = (): void => { if (parts.length) runs.push({ text: parts.join(''), code: false }); parts.length = 0; };
  let depth = 0;
  const walk = (list: readonly Token[]): void => { for (const token of list) visit(token); };
  const visit = (token: Token): void => {
    switch (token.type) {
      // The timeline draws a block of raw HTML as its words (scripts and styles dropped), so a pasted
      // copy keeps them; Find keeps skipping markup, and an inline tag has no words of its own.
      case 'html': {
        if (!options.layout || !(token as Tokens.HTML).block) break;
        const words = plainTextOfHtml((token as Tokens.HTML).text);
        if (words) parts.push(words, '\n');
        break;
      }
      // A pasted copy keeps an image's description; Find reads only the words drawn.
      // Its words come from the parsed description, which has no emphasis markers left in it.
      case 'image': {
        if (!options.layout) break;
        const image = token as Tokens.Image;
        if (image.tokens?.length) walk(image.tokens); else parts.push(decodeEntities(image.text));
        break;
      }
      case 'br': parts.push('\n'); break;
      case 'code':
        if (options.codeBlocks === false) break;
        if (options.tidy && options.layout) { flush(); runs.push({ text: (token as Tokens.Code).text, code: true }); } else parts.push((token as Tokens.Code).text);
        break;
      case 'codespan': parts.push((token as Tokens.Codespan).text); break;
      case 'checkbox': if (options.layout) parts.push((token as Tokens.Checkbox).checked ? '[x] ' : '[ ] '); break;
      case 'list': {
        const list = token as Tokens.List;
        const first = typeof list.start === 'number' ? list.start : 1;
        list.items.forEach((item, index) => {
          if (options.layout) {
            // A nested list would otherwise go on with its parent item's line.
            if (parts.length && !parts.at(-1)!.endsWith('\n')) parts.push('\n');
            parts.push(`${'  '.repeat(depth)}${list.ordered ? `${first + index}.` : '-'} `);
          }
          depth++; visit(item); depth--;
        });
        break;
      }
      case 'table': {
        const table = token as Tokens.Table;
        for (const row of [table.header, ...table.rows]) {
          row.forEach((cell, index) => {
            if (options.layout && index) parts.push('\t');
            walk(cell.tokens);
            if (!options.layout) parts.push(' ');
          });
          parts.push('\n');
        }
        break;
      }
      default: {
        const children = (token as { tokens?: Token[] }).tokens;
        if (children?.length) walk(children);
        else if (typeof (token as { text?: unknown }).text === 'string') parts.push(decodeEntities((token as { text: string }).text));
      }
    }
    // In a pasted list, an item whose nested list already ended the line adds no empty line.
    if (BLOCKS.has(token.type) && !(options.layout && token.type === 'list_item' && parts.at(-1)?.endsWith('\n'))) parts.push('\n');
  };
  walk(tokens);
  flush();
  if (!(options.tidy && options.layout)) return runs.map(run => run.text).join('');
  const tidy = (text: string): string => text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  const out = runs.map(run => run.code ? run.text : tidy(run.text));
  if (!runs[0]?.code) out[0] = out[0]?.trimStart() ?? '';
  if (!runs.at(-1)?.code) out[out.length - 1] = out.at(-1)?.trimEnd() ?? '';
  return out.join('');
}
