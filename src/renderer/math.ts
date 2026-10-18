import katex from 'katex';
import 'katex/dist/katex.min.css';
import type { TokenizerAndRendererExtension } from 'marked';

/**
 * Formulas in Markdown, drawn the way ChatGPT draws them (KaTeX).
 *
 * ChatGPT writes LaTeX between `\( … \)` inline and `\[ … \]` (or `$$ … $$`) for a block, observed
 * 2026-10-08. A lone `$` is left alone: it is far more often a price than a formula, and ChatGPT
 * does not render it either.
 *
 * The formula never travels as markup. The Markdown pass leaves a private-use placeholder in its
 * place, the message is sanitised as usual, and only then each placeholder becomes KaTeX's own
 * rendering of the original source, with `trust` off so no command can add links, classes or
 * styles of its own. Source that KaTeX cannot parse shows as written.
 */

/** Longest formula drawn; anything longer stays as its source. */
const MAX_TEX = 8_000;
const OPEN = '', CLOSE = ''; // U+E010, U+E011; chat.ts lists the pair each placeholder has
const PLACEHOLDER = /(\d{1,5})/g;

export interface MathSlots { formulas: Array<{ tex: string; display: boolean }> }

const BLOCK = /^(?:\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$)[ \t]*(?:\n|$)/;
const INLINE = /^(?:\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|\$\$([^\n]+?)\$\$)/;

/**
 * Starts a display formula on its own block when ChatGPT opens it on the line right after prose.
 *
 * Markdown reads such a line as more of the paragraph, so the formula block never gets its turn,
 * and a formula line holding only `=` turns the whole paragraph into a large heading (#1342,
 * 2026-10-12: "\[" lost its backslash and nothing was drawn). A blank line before the opening
 * `\[` or `$$` keeps list items together and leaves code fences untouched.
 */
export function separateDisplayMath(text: string): string {
  if (!text.includes('\\[') && !text.includes('$$')) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  // The closer of an open display formula: a `$$` line inside one ends it rather than opening one.
  let closer: string | null = null;
  for (const line of lines) {
    const trimmed = line.trimStart();
    const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (closer !== null) {
      if (trimmed.includes(closer)) closer = null;
    } else if (marker) {
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
    } else if (fence === null && /^(?:\\\[|\$\$)/.test(trimmed)) {
      const previous = out.at(-1);
      if (previous !== undefined && previous.trim() !== '') out.push('');
      const opener = trimmed.startsWith('$$') ? '$$' : '\\]';
      if (!trimmed.slice(2).includes(opener)) closer = opener;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** The Marked extensions that set formulas aside for `drawMath`. */
export function mathExtensions(slots: MathSlots): TokenizerAndRendererExtension[] {
  const slot = (tex: string, display: boolean) => {
    slots.formulas.push({ tex: tex.trim(), display });
    return `${OPEN}${slots.formulas.length - 1}${CLOSE}`;
  };
  return [{
    name: 'mathBlock', level: 'block',
    start: value => { const at = value.search(/^(?:\\\[|\$\$)/m); return at < 0 ? undefined : at; },
    tokenizer(value) {
      const match = value.match(BLOCK);
      return match ? { type: 'mathBlock', raw: match[0], tex: match[1] ?? match[2] ?? '' } : undefined;
    },
    renderer(token) { return `<p>${slot(String(token['tex']), true)}</p>`; }
  }, {
    name: 'mathInline', level: 'inline',
    start: value => { const at = value.search(/\\\(|\\\[|\$\$/); return at < 0 ? undefined : at; },
    tokenizer(value) {
      const match = value.match(INLINE);
      if (!match) return undefined;
      const display = match[1] === undefined;
      return { type: 'mathInline', raw: match[0], tex: match[1] ?? match[2] ?? match[3] ?? '', display };
    },
    renderer(token) { return slot(String(token['tex']), token['display'] === true); }
  }];
}

/** Draws each formula placeholder in a sanitised message. */
export function drawMath(root: HTMLElement, slots: MathSlots): void {
  if (!slots.formulas.length) return;
  const document = root.ownerDocument;
  const walker = document.createTreeWalker(root, 0x4 /* NodeFilter.SHOW_TEXT */);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if ((node.nodeValue ?? '').includes(OPEN)) nodes.push(node as Text);
  for (const node of nodes) {
    const value = node.nodeValue ?? '';
    const parts: Node[] = [];
    let last = 0;
    for (const match of value.matchAll(PLACEHOLDER)) {
      if (match.index! > last) parts.push(document.createTextNode(value.slice(last, match.index)));
      const formula = slots.formulas[Number(match[1])];
      parts.push(formula ? drawn(document, formula.tex, formula.display) : document.createTextNode(match[0]));
      last = match.index! + match[0].length;
    }
    if (last < value.length) parts.push(document.createTextNode(value.slice(last)));
    node.replaceWith(...parts);
  }
  // A block formula alone in its paragraph is the paragraph.
  for (const block of root.querySelectorAll<HTMLElement>('p > .math-display:only-child')) {
    const paragraph = block.parentElement!;
    if (paragraph.textContent === block.textContent) paragraph.replaceWith(block);
  }
}

function drawn(document: Document, tex: string, display: boolean): HTMLElement {
  const holder = document.createElement(display ? 'div' : 'span');
  holder.className = display ? 'math-display' : 'math-inline';
  if (tex.length > MAX_TEX) { holder.textContent = display ? `\\[${tex}\\]` : `\\(${tex}\\)`; return holder; }
  try {
    katex.render(tex, holder, { displayMode: display, throwOnError: true, trust: false, strict: 'ignore', output: 'htmlAndMathml' });
  } catch {
    // Not a formula KaTeX can draw: the source, as the model wrote it.
    holder.className += ' is-source';
    holder.textContent = display ? `\\[${tex}\\]` : `\\(${tex}\\)`;
  }
  return holder;
}
