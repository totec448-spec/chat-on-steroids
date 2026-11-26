import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ enabled: false, rename: false, wake: vi.fn() }));
vi.mock('../src/main/config.js', () => ({
  getConfig: () => ({ sessions: { checkWebChatTitles: state.enabled, renameWebChatTitles: state.rename } })
}));
vi.mock('../src/main/browser-wake.js', () => ({ wakeBrowserWork: state.wake }));

import { acceptWebChatTitle, authorizeWebChatRename, cancelWebChatTitleCheck, offerWebChatTitleCheck, readWebChatTitle,
  renameWebChatTitle } from '../src/main/web-chat-title.js';

const conversationId = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  state.enabled = false;
  state.rename = false;
  state.wake.mockClear();
  vi.useFakeTimers();
});

it('requires independent opt-in and permits one commit from the offered browser only', async () => {
  state.enabled = true;
  const canCommit = vi.fn(async () => true);
  await expect(renameWebChatTitle(conversationId, 'Before', 'After', canCommit)).resolves.toBe(false);
  expect(state.wake).not.toHaveBeenCalled();
  state.rename = true;
  const result = renameWebChatTitle(conversationId, 'Before', 'After', canCommit);
  const { id, rename } = offerWebChatTitleCheck('browser')!;
  expect(rename).toMatchObject({ expectedTitle: 'Before', title: 'After' });
  const claim = { id, conversationId, commit: true };
  await expect(authorizeWebChatRename('other', claim)).resolves.toBe(false);
  await expect(authorizeWebChatRename('browser', claim)).resolves.toBe(true);
  await expect(authorizeWebChatRename('browser', claim)).resolves.toBe(false);
  expect(canCommit).toHaveBeenCalledOnce();
  expect(acceptWebChatTitle('browser', { id, conversationId, title: 'After' })).toBe(true);
  await expect(result).resolves.toBe(true);
});

it('refuses to commit a renamed session that rebound or became ineligible', async () => {
  state.rename = true;
  const result = renameWebChatTitle(conversationId, 'Before', 'After', async () => false);
  const { id } = offerWebChatTitleCheck('browser')!;
  await expect(authorizeWebChatRename('browser', { id, conversationId, commit: true })).resolves.toBe(false);
  expect(acceptWebChatTitle('browser', { id, conversationId, title: null, reason: 'rename-canceled' })).toBe(true);
  await expect(result).resolves.toBe(false);
});
afterEach(() => {
  cancelWebChatTitleCheck();
  vi.useRealTimers();
});

it('checks only after opt-in and accepts one reply for the offered browser and conversation', async () => {
  await expect(readWebChatTitle(conversationId)).resolves.toBeNull();
  expect(state.wake).not.toHaveBeenCalled();
  state.enabled = true;
  const result = readWebChatTitle(conversationId);
  expect(state.wake).toHaveBeenCalledOnce();
  const offer = offerWebChatTitleCheck('first-browser')!;
  expect(offer.conversationId).toBe(conversationId);
  expect(offerWebChatTitleCheck('second-browser')).toBeUndefined();
  expect(acceptWebChatTitle('second-browser', { ...offer, title: 'Other account' })).toBe(false);
  expect(acceptWebChatTitle('first-browser', { ...offer, conversationId: '22222222-2222-4222-8222-222222222222', title: 'Replacement' })).toBe(false);
  expect(acceptWebChatTitle('first-browser', { ...offer, title: '  The current title  ' })).toBe(true);
  await expect(result).resolves.toBe('The current title');
  expect(acceptWebChatTitle('first-browser', { ...offer, title: 'Late duplicate' })).toBe(false);
});

it('cancels on opt-out and does not let a stale response settle a later check', async () => {
  state.enabled = true;
  const first = readWebChatTitle(conversationId);
  const stale = offerWebChatTitleCheck('browser')!;
  state.enabled = false;
  cancelWebChatTitleCheck();
  await expect(first).resolves.toBeNull();
  state.enabled = true;
  const next = readWebChatTitle(conversationId);
  const fresh = offerWebChatTitleCheck('browser')!;
  expect(acceptWebChatTitle('browser', { ...stale, title: 'Expired title' })).toBe(false);
  expect(acceptWebChatTitle('browser', { ...fresh, title: null })).toBe(true);
  await expect(next).resolves.toBeNull();
});

it('expires without retrying if a browser cannot confirm the title', async () => {
  state.enabled = true;
  const result = readWebChatTitle(conversationId);
  const stale = offerWebChatTitleCheck('browser')!;
  await vi.advanceTimersByTimeAsync(15_000);
  await expect(result).resolves.toBeNull();
  expect(acceptWebChatTitle('browser', { ...stale, title: 'Late' })).toBe(false);
  expect(state.wake).toHaveBeenCalledOnce();
});
