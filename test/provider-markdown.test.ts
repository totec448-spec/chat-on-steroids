import { afterEach, expect, it } from 'vitest';
import { Marked } from 'marked';
import { JSDOM } from 'jsdom';
import { providerMarkdown } from '../src/renderer/provider-markdown.js';
import { messagePresentation, type MessagePresentation } from '../src/shared/message-presentation.js';

const presentation: MessagePresentation = { conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', references: [
  { index: 0, type: 'web', sources: [{ title: 'An exact source', url: 'https://example.com/research' }] },
  { index: 1, type: 'file', name: 'report.py', path: '/mnt/data/report.py', sourceMessageId: '11111111-2222-4333-8444-555555555555' }
] };
const pages: JSDOM[] = [];
afterEach(() => pages.splice(0).forEach(page => page.window.close()));
const render = (source: string, metadata = presentation) => {
  const parser = new Marked(providerMarkdown(metadata));
  const page = new JSDOM(parser.parse(source, { async: false })); pages.push(page); return page.window.document;
};

it('renders native references as exact source links and leaves file access to the native preview action', () => {
  const doc = render('Evidence. :chatgpt-content-reference{index="0"}\n\n:chatgpt-content-reference{index="1"}[Download `report.py`](sandbox:/mnt/data/report.py)');
  expect(doc.body.textContent).not.toContain('chatgpt-content-reference');
  expect([...doc.querySelectorAll('a')].map(a => a.getAttribute('href'))).toEqual(['https://example.com/research', '#cos-native-file-1']);
  expect(doc.querySelector('code')?.textContent).toBe('report.py');
});

it.each(['standard', 'document'])('renders the %s writing variant without exposing transport syntax', variant => {
  const doc = render(`Introduction.\n\n:::writing{variant="${variant}" id="12345" title="A fresh start"}\n# First\n\nA **bold** paragraph.\n:::\n\nAfterward.`);
  expect(doc.querySelector('[data-cos-writing-title]')?.textContent).toBe('A fresh start');
  expect(doc.querySelector('[data-cos-writing-body] strong')?.textContent).toBe('bold');
  expect(doc.body.textContent).toContain('Afterward.');
  expect(doc.body.textContent).not.toContain(':::writing');
});

it('handles an unfinished streamed writing body without swallowing its code fence delimiter', () => {
  const doc = render(':::writing{variant="document" title="Draft"}\n```text\n:::\n```\n\nStill streaming');
  expect(doc.querySelector('[data-cos-writing-body] pre code')?.textContent?.trim()).toBe(':::');
  expect(doc.querySelector('[data-cos-writing-body]')?.textContent).toContain('Still streaming');
});

it('does not interpret literal examples inside code', () => {
  const doc = render('`:chatgpt-content-reference{index="0"}`\n\n```md\n:::writing{variant="document" title="Literal"}\nbody\n:::\n```');
  expect(doc.querySelectorAll('a,[data-cos-writing-block]')).toHaveLength(0);
  expect(doc.body.textContent).toContain(':chatgpt-content-reference');
});

it('escapes writing titles rather than creating markup', () => {
  const doc = render(':::writing{variant="email" title="<img src=x onerror=alert(1)>"}\nBody\n:::');
  expect(doc.querySelector('img')).toBeNull();
  expect(doc.querySelector('[data-cos-writing-title]')?.textContent).toContain('<img');
});

it('retains an unknown file label without treating its provider path as a local file', () => {
  const doc = render('[Unverified](sandbox:/mnt/data/other.py) :chatgpt-content-reference{index="55"}');
  expect(doc.querySelector('a')).toBeNull();
  expect(doc.body.textContent).toContain('Unverified');
  expect(doc.body.textContent).toContain('[reference unavailable]');
});

it('rejects ambiguous, oversized and executable metadata at the public boundary', () => {
  expect(messagePresentation({ ...presentation, references: [presentation.references[0], presentation.references[0]] })).toBeUndefined();
  expect(messagePresentation({ ...presentation, references: Array(65).fill(presentation.references[0]) })).toBeUndefined();
  const data = messagePresentation({ ...presentation, token: 'PRIVATE', references: [
    { ...presentation.references[0], sources: [{ title: 'X', url: 'javascript:alert(1)' }] },
    { ...presentation.references[1], path: '/mnt/data/../private' }
  ] });
  expect(data?.references).toEqual([]);
  expect(JSON.stringify(data)).not.toContain('PRIVATE');
});
