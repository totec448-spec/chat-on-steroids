import { Lexer, type Token, type Tokens } from 'marked';

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
 */
export function markdownVisibleText(markdown: string, options: { codeBlocks?: boolean } = {}): string {
  let tokens: Token[];
  try { tokens = new Lexer({ gfm: true }).lex(markdown); } catch { return markdown; }
  const parts: string[] = [];
  const walk = (list: readonly Token[]): void => { for (const token of list) visit(token); };
  const visit = (token: Token): void => {
    switch (token.type) {
      case 'html': case 'image': break;
      case 'br': parts.push('\n'); break;
      case 'code': if (options.codeBlocks !== false) parts.push((token as Tokens.Code).text); break;
      case 'codespan': parts.push((token as Tokens.Codespan).text); break;
      case 'list': for (const item of (token as Tokens.List).items) visit(item); break;
      case 'table': {
        const table = token as Tokens.Table;
        for (const row of [table.header, ...table.rows]) {
          for (const cell of row) { walk(cell.tokens); parts.push(' '); }
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
    if (BLOCKS.has(token.type)) parts.push('\n');
  };
  walk(tokens);
  return parts.join('');
}
