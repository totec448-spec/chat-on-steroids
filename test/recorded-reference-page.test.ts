import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

const source = readFileSync('extension/recorded-reference-page.js', 'utf8').replace('export async function', 'async function');
const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const messageId = '11111111-2222-4333-8444-555555555555';
let page: JSDOM;
afterEach(() => page?.window.close());
function fixture() {
  page = new JSDOM('<span data-file-reference="true" role="button">report.py</span>', { url: `https://chatgpt.com/c/${conversationId}`, runScripts: 'outside-only' });
  const w = page.window;
  const ref = { type: 'file', sandbox_path: '/mnt/data/report.py', file_name: 'report.py', message_id: messageId };
  const item = { type: 'assistant-message', messageId, contentReferences: [ref] };
  const control = w.document.querySelector('span')!;
  const owner = { memoizedProps: { turn: { items: [item] }, conversationId }, return: null };
  (control as any).__reactFiber$test = { memoizedProps: { reference: ref, contentReferenceIndex: 0 }, return: owner };
  (control as any).getClientRects = () => [{}]; control.scrollIntoView = vi.fn();
  const clicked = vi.fn(); control.addEventListener('click', clicked);
  // Bound negative fixture waits without changing production's readiness deadline.
  w.setTimeout = ((callback: () => void) => setTimeout(callback, 5)) as any;
  w.clearTimeout = clearTimeout as any;
  w.eval(source);
  return { w, ref, item, owner, clicked, control, run: (w as any).openRecordedReferencePage,
    args: { conversationId, messageId, reference: { index: 0, type: 'file', path: '/mnt/data/report.py', name: 'report.py', sourceMessageId: messageId } } };
}

it('opens only the exact current native reference control and dispatches once', async () => {
  const f = fixture(); expect(await f.run(f.args)).toEqual({ requested: true });
  expect(f.clicked).toHaveBeenCalledTimes(1);
  f.w.document.body.append(f.w.document.createElement('div')); await Promise.resolve();
  expect(f.clicked).toHaveBeenCalledTimes(1);
});

it('opens the native file-card preview without requiring the code-chip data attribute', async () => {
  const f = fixture(), button = f.w.document.createElement('button');
  button.setAttribute('aria-label', 'Open preview of report.py');
  (button as any).__reactFiber$test = (f.control as any).__reactFiber$test;
  (button as any).getClientRects = () => [{}]; button.scrollIntoView = vi.fn();
  const clicked = vi.fn(); button.addEventListener('click', clicked);
  f.control.replaceWith(button);
  expect(await f.run(f.args)).toEqual({ requested: true }); expect(clicked).toHaveBeenCalledTimes(1);
  (button as any).__reactFiber$test = { memoizedProps: {}, return: f.owner };
  expect((await f.run(f.args)).requested).not.toBe(true);
  expect(clicked).toHaveBeenCalledTimes(1);
});

it.each(['path', 'sourceMessageId', 'messageId', 'conversationId'])('rejects a mismatched %s without clicking', async field => {
  const f = fixture();
  const args = structuredClone(f.args);
  if (field === 'path') args.reference.path = '/mnt/data/other.py';
  else if (field === 'sourceMessageId') args.reference.sourceMessageId = 'aaaaaaaa-1111-4111-8111-222222222222';
  else args[field as 'messageId' | 'conversationId'] = 'aaaaaaaa-1111-4111-8111-222222222222';
  expect((await f.run(args)).requested).not.toBe(true); expect(f.clicked).not.toHaveBeenCalled();
});

it('does not spend filename equality or a cloned reference as native identity', async () => {
  const f = fixture(); (f.control as any).__reactFiber$test.memoizedProps.reference = { ...f.ref };
  expect((await f.run(f.args)).requested).not.toBe(true); expect(f.clicked).not.toHaveBeenCalled();
});

it('accepts a copied native reference only with its exact message wrapper and unique canonical file tuple', async () => {
  const f = fixture(), holder = f.w.document.createElement('div');
  holder.setAttribute('data-chatgpt-selection-message-id', messageId);
  holder.setAttribute('data-chatgpt-selection-conversation-id', conversationId);
  f.control.replaceWith(holder); holder.append(f.control);
  (f.control as any).__reactFiber$test.memoizedProps.reference = { ...f.ref };
  expect(await f.run(f.args)).toEqual({ requested: true }); expect(f.clicked).toHaveBeenCalledTimes(1);
  f.item.contentReferences.push({ ...f.ref });
  expect((await f.run(f.args)).requested).not.toBe(true); expect(f.clicked).toHaveBeenCalledTimes(1);
  f.item.contentReferences.pop(); holder.setAttribute('data-chatgpt-selection-message-id', 'another-message');
  expect((await f.run(f.args)).requested).not.toBe(true);
});

it('rejects duplicate native controls and quoted extension surfaces', async () => {
  const f = fixture(), other = f.control.cloneNode(true) as HTMLElement;
  (other as any).__reactFiber$test = (f.control as any).__reactFiber$test; (other as any).getClientRects = () => [{}];
  f.w.document.body.append(other);
  expect((await f.run(f.args)).error).toContain('Multiple'); expect(f.clicked).not.toHaveBeenCalled();
  other.remove(); const wrapper = f.w.document.createElement('div'); wrapper.className = 'clf-stream'; wrapper.append(f.control); f.w.document.body.append(wrapper);
  expect((await f.run(f.args)).requested).not.toBe(true); expect(f.clicked).not.toHaveBeenCalled();
});
