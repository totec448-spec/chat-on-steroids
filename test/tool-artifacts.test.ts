import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { renderEditCards } from '../src/renderer/tool-artifacts.js';
import type { ToolCallRecord } from '../src/shared/session.js';

let dom: JSDOM;
afterEach(() => { dom?.window.document.body.replaceChildren(); dom?.window.close(); });
const call = {
  callId: 'recorded-call', summary: { kind: 'edit' },
  changes: [{ path: 'app.txt', added: 1, removed: 1, reviewAssetId: 'immutable-asset' }]
} as ToolCallRecord;
const snapshot = { callId: call.callId, changeIndex: 0, path: 'app.txt', baseText: 'old\n', currentText: '<script>new</script>\n' };
function mount(load: ReturnType<typeof vi.fn>, current = () => true): HTMLDetailsElement {
  dom = new JSDOM('<main></main>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  Object.assign(dom.window, { api: { getToolEditReview: load, writeClipboard: vi.fn().mockResolvedValue({ ok: true, data: true }) } });
  document.querySelector('main')!.append(renderEditCards(call, 'local-session', current));
  return document.querySelector('details')!;
}
function open(card: HTMLDetailsElement): void { card.open = true; card.dispatchEvent(new dom.window.Event('toggle')); }

it('loads exact recorded snapshots on demand and copies their text without interpreting markup', async () => {
  const load = vi.fn().mockResolvedValue({ ok: true, data: snapshot });
  const card = mount(load);
  expect(load).not.toHaveBeenCalled();
  open(card);
  await vi.waitFor(() => expect(card.querySelector('.is-added .diff-code')?.textContent).toBe('<script>new</script>'));
  expect(load).toHaveBeenCalledWith('local-session', call.callId, 0);
  expect(card.querySelector('script')).toBeNull();
  card.querySelector<HTMLButtonElement>('.tool-copy')!.click();
  expect(window.api.writeClipboard).toHaveBeenCalledWith(snapshot.currentText);
  card.open = false; open(card);
  expect(load).toHaveBeenCalledTimes(1);
});

it.each(['callId', 'changeIndex', 'path'] as const)('rejects snapshots whose %s belongs to a different recorded edit', async field => {
  const reply = { ...snapshot, [field]: field === 'changeIndex' ? 1 : 'another-owner' };
  const card = mount(vi.fn().mockResolvedValue({ ok: true, data: reply })); open(card);
  await vi.waitFor(() => expect(card.textContent).toContain('Recorded edit is unavailable.'));
  expect(card.querySelector<HTMLButtonElement>('.tool-copy')!.disabled).toBe(true);
  expect(card.querySelector('.diff-line')).toBeNull();
});

it.each(['navigation', 'removal'] as const)('discards an edit loaded after %s retires its owner', async retirement => {
  let accept = true;
  let resolve!: (reply: unknown) => void;
  const load = vi.fn(() => new Promise(done => { resolve = done; }));
  const card = mount(load, () => accept); open(card);
  if (retirement === 'navigation') accept = false; else card.remove();
  resolve({ ok: true, data: snapshot });
  await new Promise(done => setTimeout(done, 20));
  expect(card.querySelector('.diff-line')).toBeNull();
  expect(card.querySelector<HTMLButtonElement>('.tool-copy')!.disabled).toBe(true);
});

it('keeps oversized assets visibly unavailable with copying disabled', async () => {
  const card = mount(vi.fn().mockResolvedValue({ ok: true, data: { ...snapshot, currentText: 'x'.repeat(512 * 1024) } }));
  open(card);
  await vi.waitFor(() => expect(card.textContent).toContain('Recorded edit is unavailable.'));
  expect(card.querySelector<HTMLButtonElement>('.tool-copy')!.disabled).toBe(true);
});
