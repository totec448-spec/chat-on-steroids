/** A line of an indented code block. */
const CODE_LINE = /^(?: {4,}| {0,3}\t)/;

/** Markdown indentation uses four-column tab stops, not character counts. */
function indentColumns(line: string): number {
  let columns = 0;
  for (const char of line) {
    if (char === ' ') columns++;
    else if (char === '\t') columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

/** A plain paragraph may lazily continue a list; a new block cannot. */
function endsListParagraph(line: string, afterBlank: boolean): boolean {
  return afterBlank || /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|`{3,}|~{3,}|(?:[-*_][ \t]*){3,}$)/.test(line);
}

/** Locate Markdown fences, including ones nested under blockquotes and list items. */
function fencedMarkdownRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let fence: { start: number; marker: string; width: number; nested: boolean; quoteDepth: number; listIndent: number | null } | null = null;
  let listIndent: number | null = null;
  let afterBlank = true;
  for (let start = 0; start < text.length;) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline + 1;
    const line = text.slice(start, newline < 0 ? end : newline).replace(/\r$/, '');
    const quotePrefix = /^(?:[ \t]*>[ \t]?)+/.exec(line)?.[0] ?? '';
    const quoteDepth = (quotePrefix.match(/>/g) ?? []).length;
    const content = line.slice(quotePrefix.length);
    const indent = indentColumns(content);
    let endedBlock = false;
    const body = line.replace(/^(?:[ \t]*(?:>|[-*+]|\d{1,9}[.)])(?=[ \t]|$)[ \t]?)*/, '');
    // Marked ends a nested fence when its quote/list container ends, even
    // without closing backticks. The first outside line may open another fence.
    if (fence && (quoteDepth < fence.quoteDepth ||
        (fence.listIndent !== null && content.trim() && indent < fence.listIndent))) {
      ranges.push({ start: fence.start, end: start });
      fence = null;
      afterBlank = true;
    }
    if (fence) {
      // A top-level fence cannot be closed by a list/blockquote-prefixed line.
      const close = (fence.nested ? /^[ \t]*(`{3,}|~{3,})[ \t]*$/ : /^ {0,3}(`{3,}|~{3,})[ \t]*$/)
        .exec(fence.nested ? body : line)?.[1];
      if (close && close[0] === fence.marker && close.length >= fence.width) {
        ranges.push({ start: fence.start, end });
        fence = null;
        endedBlock = true;
      }
    } else {
      const marker = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/.exec(content);
      if (marker) listIndent = indentColumns(marker[0].replace(/\S/g, ' '));
      // A plain paragraph can lazily continue its list without indentation.
      // Only a blank/block boundary or an interrupting block ends that context.
      else if (content.trim() && listIndent !== null && indent < listIndent &&
          endsListParagraph(content, afterBlank)) listIndent = null;
      // Container-looking text inside indented code is literal. Check its
      // original columns before stripping list/quote prefixes, or a sample
      // such as four spaces + '- ```' becomes an unclosed nested fence.
      // List continuations have their own baseline: another four columns
      // means code, while shallower indentation can still open a real fence.
      const codeColumn = (listIndent ?? 0) + 4;
      if (Math.max(indentColumns(line), indent) >= codeColumn) {
        afterBlank = true;
        start = end;
        continue;
      }
      const nested = body.length !== line.length || (listIndent !== null && indent >= listIndent);
      const open = (nested ? /^[ \t]*(`{3,}|~{3,})(.*)$/ : /^ {0,3}(`{3,}|~{3,})(.*)$/).exec(body);
      if (open && (open[1]![0] === '~' || !open[2]!.includes('`'))) {
        fence = { start, marker: open[1]![0]!, width: open[1]!.length, nested, quoteDepth, listIndent };
      }
    }
    afterBlank = endedBlock || !content.trim();
    start = end;
  }
  if (fence) ranges.push({ start: fence.start, end: text.length });
  return ranges;
}

/** Match tick runs once per paragraph instead of rescanning every unmatched suffix. */
function inlineMarkdownRanges(text: string, offset: number): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const paragraph = (start: number, end: number): void => {
    const source = text.slice(start, end);
    const runs = [...source.matchAll(/`+/g)].map(run => ({
      at: run.index, width: run[0].length, escaped: source[run.index - 1] === '\\', next: -1
    }));
    const nextWidth = new Map<number, number>();
    for (let index = runs.length - 1; index >= 0; index--) {
      const run = runs[index]!;
      run.next = nextWidth.get(run.width) ?? -1;
      nextWidth.set(run.width, index);
    }
    for (let index = 0; index < runs.length;) {
      const open = runs[index]!;
      if (open.escaped || open.next < 0) { index++; continue; }
      const close = runs[open.next]!;
      ranges.push({ start: offset + start + open.at, end: offset + start + close.at + close.width });
      index = open.next + 1;
    }
  };
  let start = 0;
  // Preserve LF/CRLF and original UTF-16 offsets; inline code cannot cross a blank line.
  for (const gap of text.matchAll(/\r?\n[ \t]*\r?\n/g)) {
    paragraph(start, gap.index);
    start = gap.index + gap[0].length;
  }
  paragraph(start, text.length);
  return ranges;
}

/** Code examples that must remain literal when enriching provider Markdown. */
export function markdownCodeRanges(text: string): Array<{ start: number; end: number }> {
  const fences = fencedMarkdownRanges(text);
  const ranges = [...fences];
  // Four-space and tab-indented blocks are code too. A blank line can continue
  // one, but an unindented nonblank line ends it before its own content.
  let indentedStart: number | null = null;
  let afterBlank = true;
  let fenceIndex = 0;
  let listContentIndent: number | null = null;
  for (let at = 0; at < text.length;) {
    const newline = text.indexOf('\n', at);
    const end = newline < 0 ? text.length : newline + 1;
    const line = text.slice(at, newline < 0 ? end : newline).replace(/\r$/, '');
    while (fences[fenceIndex] && at >= fences[fenceIndex]!.end) fenceIndex++;
    if (fences[fenceIndex] && at >= fences[fenceIndex]!.start) {
      // A top-level fence at a shallower column ends the preceding list.
      // Otherwise its old offset makes following four-space code look like
      // a list continuation; nested fences must keep their list context.
      if (at === fences[fenceIndex]!.start && listContentIndent !== null &&
          indentColumns(line) < listContentIndent && /^ {0,3}(`{3,}|~{3,})/.test(line)) {
        listContentIndent = null;
      }
      if (indentedStart !== null) ranges.push({ start: indentedStart, end: at });
      indentedStart = null;
      // A completed fenced block is a block boundary, even without an empty
      // line: Marked accepts an indented code block immediately after it.
      afterBlank = end === fences[fenceIndex]!.end;
    } else {
      // Indented list content begins at the marker's text column. Its code
      // blocks need *another* four columns, unlike a plain four-space continuation.
      const marker = /^([ ]*)(?:[-*+]|\d{1,9}[.)])([ \t]+)/.exec(line);
      const codeIndent = listContentIndent !== null && indentColumns(line) >= listContentIndent + 4;
      if (marker && !(codeIndent && (afterBlank || indentedStart !== null)) && (marker[1]!.length <= 3 ||
          (listContentIndent !== null && indentColumns(marker[1]!) >= listContentIndent))) {
        listContentIndent = indentColumns(marker[0].replace(/\S/g, ' '));
      } else if (line.trim() && listContentIndent !== null && indentColumns(line) < listContentIndent &&
          (indentedStart !== null || endsListParagraph(line, afterBlank))) {
        listContentIndent = null;
      }
      if (indentedStart === null) {
        if (afterBlank && CODE_LINE.test(line) &&
            (listContentIndent === null || indentColumns(line) >= listContentIndent + 4)) indentedStart = at;
      } else if (line.trim() && (listContentIndent === null
        ? !CODE_LINE.test(line) : indentColumns(line) < listContentIndent + 4)) {
        ranges.push({ start: indentedStart, end: at });
        indentedStart = null;
      }
      afterBlank = !line.trim();
    }
    at = end;
  }
  if (indentedStart !== null) ranges.push({ start: indentedStart, end: text.length });
  // Inline ticks are only syntax outside block code; never pair a literal tick
  // in an indented example with a later heading. Preserve original offsets.
  const blocks = [...ranges].sort((a, b) => a.start - b.start);
  let start = 0;
  for (const fence of [...blocks, { start: text.length, end: text.length }]) {
    const outside = text.slice(start, fence.start);
    for (const span of inlineMarkdownRanges(outside, start)) ranges.push(span);
    start = Math.max(start, fence.end);
  }
  return ranges;
}
