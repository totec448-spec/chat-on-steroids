import katex from 'katex';
import type { TokenizerAndRendererExtension } from 'marked';

type Formula = { source: string; tex: string; display: boolean };
const PLACEHOLDER = /\uE100(\d{1,5})\uE101/g;

/**
 * Parse equations as Markdown tokens, before HTML sanitization. The sanitizer must never
 * accept KaTeX's classes or markup from captured ChatGPT HTML; we insert KaTeX's own DOM
 * only after the ordinary Markdown tree has been sanitized.
 */
export function markdownMath(): {
  extensions: TokenizerAndRendererExtension[];
  typeset: (root: HTMLElement) => void;
} {
  const formulas: Formula[] = [];
  const placeholder = (source: string, tex: string, display: boolean): string => {
    const index = formulas.push({ source, tex, display }) - 1;
    return `\uE100${index}\uE101`;
  };

  const block: TokenizerAndRendererExtension = {
    name: 'mathBlock',
    level: 'block',
    start: text => text.search(/^(?: {0,3})(?:\$\$|\\\[)/m),
    tokenizer(text) {
      const match = text.match(/^(?: {0,3})\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$(?=\s|$)/)
        ?? text.match(/^(?: {0,3})\\\[[ \t]*\n?([\s\S]+?)\n?[ \t]*\\\](?=\s|$)/);
      if (!match) return undefined;
      return { type: 'mathBlock', raw: match[0], tex: match[1]!.trim() };
    },
    renderer(token) {
      return placeholder(token.raw, String(token['tex']), true) + '\n';
    }
  };
  const inline: TokenizerAndRendererExtension = {
    name: 'mathInline',
    level: 'inline',
    start: text => text.search(/\\\(|\\\[|\$/),
    tokenizer(text) {
      const parens = text.match(/^\\\(([^\n]*?)\\\)/);
      if (parens) return { type: 'mathInline', raw: parens[0], tex: parens[1], display: false };
      const brackets = text.match(/^\\\[([\s\S]*?)\\\]/);
      if (brackets) return { type: 'mathInline', raw: brackets[0], tex: brackets[1], display: true };
      const dollars = text.match(/^\$(?!\$|\s)((?:\\.|[^$\\\n])+?)\$(?!\d)/);
      if (dollars) return { type: 'mathInline', raw: dollars[0], tex: dollars[1], display: false };
      return undefined;
    },
    renderer(token) {
      return placeholder(token.raw, String(token['tex']), Boolean(token['display']));
    }
  };

  const typeset = (root: HTMLElement): void => {
    if (!formulas.length) return;
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    const textNodes: Text[] = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
    for (const node of textNodes) {
      if (node.parentElement?.closest('code, pre')) continue;
      const text = node.data;
      PLACEHOLDER.lastIndex = 0;
      if (!PLACEHOLDER.test(text)) continue;
      PLACEHOLDER.lastIndex = 0;
      const fragment = doc.createDocumentFragment();
      let last = 0;
      for (const match of text.matchAll(PLACEHOLDER)) {
        const formula = formulas[Number(match[1])];
        if (!formula) continue;
        fragment.append(doc.createTextNode(text.slice(last, match.index)));
        const span = doc.createElement('span');
        span.className = formula.display ? 'chat-math chat-math-display' : 'chat-math';
        try {
          katex.render(formula.tex, span, { displayMode: formula.display, throwOnError: true, trust: false, strict: 'ignore', output: 'htmlAndMathml' });
        } catch {
          // Streaming or invalid TeX remains readable as the exact notation the model sent.
          span.textContent = formula.source;
        }
        fragment.append(span);
        last = match.index + match[0].length;
      }
      fragment.append(doc.createTextNode(text.slice(last)));
      node.replaceWith(fragment);
    }
  };
  return { extensions: [block, inline], typeset };
}
