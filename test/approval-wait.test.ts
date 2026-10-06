import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_FRESH_MS, APPROVAL_NOTICE_GRACE_MS, approvalCardWaiting, noteApprovalCard, resetApprovalWaits, type ApprovalWaitDeps
} from '../src/main/approval-wait.js';
import { APPROVAL_ANSWERED_TEXT, APPROVAL_WAITING_TEXT } from '../src/shared/approval-wait.js';

// VM stress test, 2026-10-06: ChatGPT's own approval card stalled a Loop and nobody was told.

describe('approval card episodes', () => {
  let deps: ApprovalWaitDeps & { rows: Array<[string, string, string, unknown]>; notices: string[] };
  beforeEach(() => {
    resetApprovalWaits();
    const rows: Array<[string, string, string, unknown]> = [], notices: string[] = [];
    deps = {
      rows, notices,
      record: async (sessionId, progressId, text, anchor) => { rows.push([sessionId, progressId, text, anchor]); return anchor ?? { seq: 7, time: 1 }; },
      notify: sessionId => { notices.push(sessionId); },
      log: () => undefined
    };
  });

  it('writes the row at once, notices once after the grace, and rewrites the row when answered', async () => {
    await noteApprovalCard('chat', true, 'session', deps, 1_000);
    expect(approvalCardWaiting('chat', 1_000)).toBe(true);
    expect(deps.rows).toEqual([['session', expect.stringMatching(/^approval-wait:chat:/), APPROVAL_WAITING_TEXT, undefined]]);
    expect(deps.notices).toEqual([]);
    await noteApprovalCard('chat', true, 'session', deps, 1_000 + APPROVAL_NOTICE_GRACE_MS);
    await noteApprovalCard('chat', true, 'session', deps, 1_000 + APPROVAL_NOTICE_GRACE_MS + 10_000);
    expect(deps.notices).toEqual(['session']);
    expect(deps.rows).toHaveLength(1);
    await noteApprovalCard('chat', false, 'session', deps, 1_000 + APPROVAL_NOTICE_GRACE_MS + 20_000);
    expect(approvalCardWaiting('chat', 1_000 + APPROVAL_NOTICE_GRACE_MS + 20_000)).toBe(false);
    expect(deps.rows[1]).toEqual(['session', deps.rows[0]![1], APPROVAL_ANSWERED_TEXT, { seq: 7, time: 1 }]);
  });

  it('answered before the grace: no notice at all', async () => {
    await noteApprovalCard('chat', true, 'session', deps, 1_000);
    await noteApprovalCard('chat', false, 'session', deps, 1_000 + APPROVAL_NOTICE_GRACE_MS - 1);
    await noteApprovalCard('chat', false, 'session', deps, 1_000 + APPROVAL_NOTICE_GRACE_MS + 1);
    expect(deps.notices).toEqual([]);
  });

  it('a page that stopped reporting ends the hold without claiming an answer', async () => {
    await noteApprovalCard('chat', true, 'session', deps, 1_000);
    expect(approvalCardWaiting('chat', 1_000 + APPROVAL_FRESH_MS - 1)).toBe(true);
    expect(approvalCardWaiting('chat', 1_000 + APPROVAL_FRESH_MS)).toBe(false);
    // The card is seen again later: a new episode with its own row, never "answered".
    await noteApprovalCard('chat', true, 'session', deps, 1_000 + APPROVAL_FRESH_MS + 5_000);
    expect(deps.rows.map(row => row[2])).toEqual([APPROVAL_WAITING_TEXT, APPROVAL_WAITING_TEXT]);
    expect(deps.rows[0]![1]).not.toBe(deps.rows[1]![1]);
  });

  it('holds recovery for a chat the app has not recorded, without a row or notice', async () => {
    await noteApprovalCard('chat', true, null, deps, 1_000);
    await noteApprovalCard('chat', true, null, deps, 1_000 + APPROVAL_NOTICE_GRACE_MS);
    expect(approvalCardWaiting('chat', 1_000 + APPROVAL_NOTICE_GRACE_MS)).toBe(true);
    expect(deps.rows).toEqual([]);
    expect(deps.notices).toEqual([]);
  });
});

describe('the page detector', () => {
  const source = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
  let dom: JSDOM;
  let api: { approvalWaiting(): boolean };
  beforeEach(() => {
    dom = new JSDOM('<main></main>', { url: 'https://chatgpt.com/c/chat', runScripts: 'outside-only', pretendToBeVisual: true });
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', {
      value(this: HTMLElement) { return this.closest('[hidden]') ? [] : [{ width: 10, height: 10 }]; }
    });
    dom.window.eval(source);
    api = (dom.window as unknown as { CLF_DOM: typeof api }).CLF_DOM;
  });
  afterEach(() => { dom.window.close(); vi.restoreAllMocks(); });

  // The live card's shape on 2026-10-06 (German UI), reduced to its structure.
  const card = (buttons = '<button>Ablehnen</button><button>Einmal zulassen</button>') =>
    `<div data-codex-approval-surface="true"><div role="alert"><p>ChatGPT erlauben, Chat On Steroids Core zu verwenden?</p></div>${buttons}</div>`;

  it('sees a waiting card in any language and nothing without one', () => {
    expect(api.approvalWaiting()).toBe(false);
    dom.window.document.querySelector('main')!.innerHTML = card();
    expect(api.approvalWaiting()).toBe(true);
  });

  it('ignores an answered card, a hidden one and one on a kept page', () => {
    const main = dom.window.document.querySelector('main')!;
    main.innerHTML = card('<button disabled>Ablehnen</button><button disabled>Einmal zulassen</button>');
    expect(api.approvalWaiting()).toBe(false);
    main.innerHTML = `<div hidden>${card()}</div>`;
    expect(api.approvalWaiting()).toBe(false);
    main.innerHTML = `<div data-app-shell-page-surface style="display:none">${card()}</div>`;
    expect(api.approvalWaiting()).toBe(false);
  });
});
