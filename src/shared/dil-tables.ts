/**
 * ChatGPT's drawn answers (DIL) come with a Markdown version that can leave parts out (#1477,
 * 2026-10-15): a table with only its header row, and a button as a bare "[label]" line. The
 * recorded drawing has the rows; these are filled in from it, so the app shows, copies and exports
 * the whole table. Everything else in the Markdown stays exactly as ChatGPT wrote it. Plain string
 * work over ChatGPT's own markup, so the main process (copy, export) and the window agree.
 */
import { plainTextOfHtml } from './content-reference.js';
import { markdownCodeRanges } from './markdown-code.js';

const cellText = (value: string): string => value.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
const markdownCells = (line: string): string[] =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(value => cellText(value.replace(/\\\|/g, '|')));
const escapeCell = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** The rows of each table ChatGPT drew, as cell texts. */
function drawnTables(html: string): string[][][] {
  const tables: string[][][] = [];
  for (const marked of html.split(/data-d-component="table"/).slice(1)) {
    const table = marked.match(/<table\b[\s\S]*?<\/table>/i)?.[0];
    if (!table) continue;
    tables.push([...table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map(([row]) =>
      [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(([, cell]) => cellText(plainTextOfHtml(cell ?? '')))));
  }
  return tables;
}

export function completedDilText(text: string, capture?: { text: string; truncated?: boolean } | null): string {
  if (!capture?.text || capture.truncated || !capture.text.includes('data-d-component')) return text;
  const tables = drawnTables(capture.text);
  const buttons = new Set([...capture.text.matchAll(/<button\b[^>]*data-d-component="button"[^>]*>([\s\S]*?)<\/button>/gi)]
    .map(([, inner]) => cellText(plainTextOfHtml(inner ?? ''))).filter(Boolean));
  if (!tables.length && !buttons.size) return text;
  const lines = text.split('\n');
  let offset = 0;
  const starts = lines.map(line => { const start = offset; offset += line.length + 1; return start; });
  const code = markdownCodeRanges(text).sort((a, b) => a.start - b.start || b.end - a.end);
  let codeIndex = 0;
  const out: string[] = [];
  let tableIndex = 0;
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!;
    while (code[codeIndex] && starts[at]! >= code[codeIndex]!.end) codeIndex++;
    // A code example is not a drawn table or button, and must not consume their matches.
    if (code[codeIndex] && starts[at]! >= code[codeIndex]!.start) {
      out.push(line);
      continue;
    }
    const label = line.trim().match(/^\[([^\]]+)\]$/)?.[1];
    if (label && buttons.has(cellText(label))) {
      // A dead button label, and the blank line it leaves behind.
      if (out.length > 0 && out.at(-1)!.trim() === '' && lines[at + 1]?.trim() === '') at++;
      continue;
    }
    out.push(line);
    if (!line.trim().startsWith('|') || !SEPARATOR.test(lines[at + 1] ?? '')) continue;
    const header = markdownCells(line);
    let body = 0;
    while ((lines[at + 2 + body] ?? '').trim().startsWith('|')) body++;
    const matchIndex = tables.findIndex((rows, index) => index >= tableIndex && rows[0]?.length === header.length &&
      rows[0]!.every((value, index) => value === header[index]));
    if (matchIndex < 0) continue;
    // Drawings and Markdown describe the same ordered tables. Consume even a complete or
    // empty table, so a later table with identical headings cannot borrow its rows.
    tableIndex = matchIndex + 1;
    const match = tables[matchIndex]!;
    if (match.length - 1 <= body) continue;
    out.push(lines[at + 1]!);
    // A real table can be inside a list. Its restored rows must stay in that container.
    const indent = line.match(/^[ \t]*/)?.[0] ?? '';
    for (const row of match.slice(1)) out.push(`${indent}| ${row.map(escapeCell).join(' | ')} |`);
    at += 1 + body;
  }
  return out.join('\n');
}
