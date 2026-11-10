import { expect, it } from 'vitest';
import { markdownCodeRanges } from '../src/shared/markdown-code.js';

it('retains greedy exact-width matching, escaped openers and UTF-16 offsets on bounded inline inputs', () => {
  // The previous grammar is an oracle only for these short, block-free strings.
  const legacy = /(?<![`\\])(`+)(?!`)(?:(?!\r?\n[ \t]*\r?\n)[\s\S])*?(?<!`)\1(?!`)/g;
  const atoms = ['`', '``', '```', '````', '\\`', 'word', '\n', '\r\n', '\n\n', '\r\n\r\n', '項目', '😀'];
  let state = 2126;
  for (let sample = 0; sample < 1000; sample++) {
    let source = 'Paragraph: ';
    for (let part = 0; part < 16; part++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      source += atoms[state % atoms.length] + ' x ';
    }
    const expected = [...source.matchAll(legacy)].map(span => ({ start: span.index, end: span.index + span[0].length }));
    expect(markdownCodeRanges(source)).toEqual(expected);
  }
});

it('handles many real spans without spreading them through the function argument stack', () => {
  const source = 'Paragraph: ' + '`x` '.repeat(150_000);
  const ranges = markdownCodeRanges(source);
  expect(ranges).toHaveLength(150_000);
  expect(source.slice(ranges[0]!.start, ranges[0]!.end)).toBe('`x`');
  expect(source.slice(ranges.at(-1)!.start, ranges.at(-1)!.end)).toBe('`x`');
});

it.each(['\n', '\r\n'])('strips only the opening quote container when closing a fence (%j)', newline => {
  for (const literal of ['- ```', '> ```', '1. ```']) {
    const example = ['> ```markdown', '> ' + literal, '> | Item | Qty |', '> |---|---|', '> ```'].join(newline);
    const source = example + newline + newline + 'Actual `outside`';
    const inline = source.indexOf('`outside`');
    expect(markdownCodeRanges(source)).toEqual([
      { start: 0, end: example.length + newline.length },
      { start: inline, end: inline + '`outside`'.length }
    ]);
  }
});
