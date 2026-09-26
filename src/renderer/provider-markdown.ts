import type { MarkedExtension, Token, Tokens } from 'marked';
import { messagePresentation, type MessagePresentation } from '../shared/message-presentation.js';

export const nativeFileHref = (index: number): string => `#cos-native-file-${index}`;
const escape = (text: string): string => text.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const REFERENCE = /^:chatgpt-content-reference\{index="(\d{1,3})"\}/;
interface WritingToken extends Tokens.Generic { title: string; tokens: Token[]; variant: string }

/** Syntax-aware extensions: code fences and inline code keep literal provider examples intact. */
export function providerMarkdown(presentation?: MessagePresentation): MarkedExtension {
  const valid = messagePresentation(presentation);
  const refs = new Map(valid?.references.map(ref => [ref.index, ref]));
  return {
    renderer: {
      link(token) {
        if (!token.href.startsWith('sandbox:')) return false;
        const files = [...refs.values()].filter(ref => ref.type === 'file' && `sandbox:${ref.path}` === token.href);
        const body = this.parser.parseInline(token.tokens);
        return files.length === 1 ? `<a href="${nativeFileHref(files[0]!.index)}" title="Open file in ChatGPT">${body}</a>` :
          `<span title="Open the original ChatGPT conversation to access this file">${body}</span>`;
      }
    },
    extensions: [{
      name: 'nativeContentReference', level: 'inline',
      start: text => text.indexOf(':chatgpt-content-reference{'),
      tokenizer(text) {
        const match = REFERENCE.exec(text);
        return match ? { type: 'nativeContentReference', raw: match[0], index: Number(match[1]) } : undefined;
      },
      renderer(token) {
        const ref = refs.get(token.index as number);
        // Files have their authored inline link and a separate accessible file card.
        if (ref?.type === 'file') return '';
        if (ref?.type === 'web') return ' <span data-cos-citation="true">(' + ref.sources.map(source =>
          `<a href="${escape(source.url)}" title="${escape(source.title)}">${escape(new URL(source.url).hostname)}</a>`).join(', ') + ')</span>';
        return '<span title="The recording does not include this reference">[reference unavailable]</span>';
      }
    }, {
      name: 'nativeWritingBlock', level: 'block',
      start: text => { const match = /(?:^|\n) {0,3}:::writing\{/.exec(text); return match?.index; },
      tokenizer(text) {
        const header = /^ {0,3}:::writing\{([^\n]{0,1600})\}[ \t]*\n/.exec(text);
        if (!header) return undefined;
        const attrs = new Map<string, string>();
        let rest = header[1]!;
        while (rest.trim()) {
          const match = /^\s*([a-z_]+)="((?:[^"\\]|\\.)*)"\s*/.exec(rest);
          if (!match || attrs.has(match[1]!)) return undefined;
          try { attrs.set(match[1]!, JSON.parse(`"${match[2]}"`) as string); } catch { return undefined; }
          rest = rest.slice(match[0].length);
        }
        const variant = attrs.get('variant');
        if (!variant || !['standard', 'document', 'email', 'message', 'social', 'text'].includes(variant)) return undefined;
        let cursor = header[0].length, end = text.length, closing = text.length;
        let fence = '', fenceSize = 0;
        // A ::: inside a fenced code sample is content, not this writing block's closing fence.
        for (const line of text.slice(cursor).match(/[^\n]*(?:\n|$)/g) || []) {
          if (!line) continue;
          const code = /^ {0,3}(`{3,}|~{3,})/.exec(line);
          if (code) {
            if (!fence) { fence = code[1]![0]!; fenceSize = code[1]!.length; }
            else if (code[1]![0] === fence && code[1]!.length >= fenceSize && /^ {0,3}(?:`+|~+)[ \t]*\n?$/.test(line)) fence = '';
          }
          if (!fence && /^ {0,3}:::[ \t]*(?:\n|$)/.test(line)) { end = cursor; closing = cursor + line.length; break; }
          cursor += line.length;
        }
        const body = text.slice(header[0].length, end);
        return { type: 'nativeWritingBlock', raw: text.slice(0, closing), title: (attrs.get('title') || attrs.get('subject') || 'Document').slice(0, 300),
          variant, tokens: this.lexer.blockTokens(body) };
      },
      renderer(raw) {
        const token = raw as WritingToken;
        return `<div data-cos-writing-block="true"><div data-cos-writing-title="true">${escape(token.title)}</div><div data-cos-writing-body="true">${this.parser.parse(token.tokens)}</div></div>\n`;
      }
    }]
  };
}
