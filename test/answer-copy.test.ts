import { expect, it } from 'vitest';
import { answerHtml, answerPlainText } from '../src/shared/answer-copy.js';
import { markdownVisibleText } from '../src/shared/markdown-text.js';

it('keeps bullets, numbers, task boxes, nesting and table columns in a plain-text copy', () => {
  const markdown = '## Steps\n\n3. first\n4. second\n   - nested `a`\n\n- [x] done\n- [ ] todo\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nSee [the docs](https://example.com).';
  expect(answerPlainText(markdown)).toBe('Steps\n\n3. first\n4. second\n  - nested a\n\n- [x] done\n- [ ] todo\n\nA\tB\n1\t2\n\nSee the docs.');
  // Search and Find read the same words as before, without the layout.
  expect(markdownVisibleText('- one\n- two\n')).toBe('one\ntwo\n');
});

it('drops a writing block\'s fence but keeps its words, closed or still open', () => {
  expect(answerPlainText('Here it is:\n\n:::writing{title="Note"}\nDear team,\n\nThanks.\n:::\n\nDone.')).toBe('Here it is:\n\nDear team,\n\nThanks.\n\nDone.');
  expect(answerPlainText(':::writing{title="Note"}\nStill writing\nmore')).toBe('Still writing\nmore');
  expect(answerHtml(':::writing\nDear team,\n:::')).toBe('<p>Dear team,</p>');
  // The same lines in a code example are the example, and stay in it.
  const example = 'Write it like this:\n\n```md\n:::writing{title="Note"}\nDear team,\n:::\n```';
  expect(answerPlainText(example)).toBe('Write it like this:\n\n:::writing{title="Note"}\nDear team,\n:::');
  expect(answerHtml(example)).toContain('<code class="language-md">:::writing{title=&quot;Note&quot;}\nDear team,\n:::\n</code>');
});

it('keeps a nested list in one piece and an image as its description', () => {
  expect(answerPlainText('- parent\n  - child\n- next')).toBe('- parent\n  - child\n- next');
  expect(answerPlainText('![chart of sales](https://example.com/c.png)')).toBe('chart of sales');
  // Find still reads only what is drawn as words.
  expect(markdownVisibleText('![chart](https://example.com/c.png)')).toBe('\n');
});

it('keeps a code example byte for byte while it tidies the spacing between blocks', () => {
  const code = 'a  \n\n\nb\n  c ';
  const markdown = `Before\n\n\n\n\`\`\`py\n${code}\n\`\`\`\n\n\n\nAfter  `;
  expect(answerPlainText(markdown)).toBe(`Before\n\n${code}\n\nAfter`);
  expect(answerPlainText(`\`\`\`\n${code}\n\`\`\``)).toBe(code);
  expect(answerPlainText(markdown, { codeBlocks: false })).toBe('Before\n\nAfter');
});

it('writes an image description without the markers around its words', () => {
  expect(answerPlainText('![**sales** up, _fast_](chart.png)')).toBe('sales up, fast');
  expect(answerHtml('![**sales** up, _fast_](chart.png)')).toBe('<p>sales up, fast</p>');
});

it('pastes markup in an answer as its words, and links only to web and mail addresses', () => {
  const html = answerHtml('Hi <script>alert(1)</script> ![chart](https://example.com/c.png)\n[web](https://example.com/a?b=1&c=2) [file](file:///C:/x) [js](javascript:alert(1))');
  expect(html).toBe('<p>Hi &lt;script&gt;alert(1)&lt;/script&gt; chart<br><a href="https://example.com/a?b=1&amp;c=2">web</a> file js</p>');
  // A task box is a character, not a form field in the pasted document.
  expect(answerHtml('- [x] done\n- [ ] todo')).toBe('<ul>\n<li>☑ done</li>\n<li>☐ todo</li>\n</ul>');
});

it('keeps the words of a block of raw HTML in a plain-text copy, as the timeline draws them', () => {
  const markdown = 'Before\n\n<div>\n<p>Important <b>decision</b></p>\n<script>alert(1)</script>\n<p>Second &amp; last</p>\n</div>\n\nAfter <i>inline</i> words';
  expect(answerPlainText(markdown)).toBe('Before\n\nImportant decision\n\nSecond & last\n\nAfter inline words');
  expect(answerPlainText('<style>p { color: red }</style>\n\nOnly this')).toBe('Only this');
  // Find reads the same words as before: a block of markup adds none.
  expect(markdownVisibleText('Before\n\n<p>Important decision</p>\n\nAfter')).toBe('Before\n\n\nAfter\n');
});
