import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_ANSWER_MS, APPROVAL_FRESH_MS, APPROVAL_NOTICE_GRACE_MS, approvalAnswerFor, approvalCardView, approvalCardWaiting, noteApprovalCard,
  requestApprovalAnswer, resetApprovalWaits, settleApprovalAnswer, type ApprovalWaitDeps
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

// The maintainer asked to answer the card from the app (2026-10-14). The app only ever relays a
// person's click, for the exact card it showed them; it never answers on its own.
describe('answering the card from the app', () => {
  let deps: ApprovalWaitDeps;
  const card = (id: string, allow = true) => ({ id, lines: ['Gmail', 'Allow ChatGPT to use Gmail?', 'Creates a draft.'], allow });
  beforeEach(() => {
    resetApprovalWaits();
    deps = { record: async () => ({ seq: 1, time: 1 }), notify: () => undefined, log: () => undefined };
  });

  it('shows the card the page reported and relays one answer for exactly that card', async () => {
    await noteApprovalCard('chat', true, 'session', deps, 1_000, card('c1'));
    expect(approvalCardView('chat', 1_000)).toMatchObject({ id: 'c1', lines: ['Gmail', 'Allow ChatGPT to use Gmail?', 'Creates a draft.'], allow: true, answer: null });
    expect(approvalAnswerFor('chat', 1_000)).toBeNull();
    const asked = requestApprovalAnswer('chat', 'c1', 'deny', 1_100);
    expect(asked).toMatchObject({ ok: true });
    const token = asked.ok ? asked.token : '';
    expect(approvalAnswerFor('chat', 1_200)).toEqual({ token, cardId: 'c1', choice: 'deny' });
    // A second click while the first is on its way changes nothing.
    expect(requestApprovalAnswer('chat', 'c1', 'allow', 1_300)).toEqual({ ok: false, error: 'answer_pending' });
    expect(settleApprovalAnswer('chat', 'not-the-token', 'clicked')).toBe(false);
    expect(settleApprovalAnswer('chat', token, 'clicked')).toBe(true);
    expect(approvalAnswerFor('chat', 1_500)).toBeNull();
    expect(approvalCardView('chat', 1_500)?.answer).toMatchObject({ choice: 'deny', outcome: 'clicked' });
  });

  it('refuses a stale card, a missing card and Allow where ChatGPT itself disabled it', async () => {
    expect(requestApprovalAnswer('chat', 'c1', 'deny', 1_000)).toEqual({ ok: false, error: 'no_card' });
    await noteApprovalCard('chat', true, 'session', deps, 1_000, card('c1', false));
    expect(requestApprovalAnswer('chat', 'c1', 'allow', 1_100)).toEqual({ ok: false, error: 'allow_unavailable' });
    expect(requestApprovalAnswer('chat', 'old-card', 'deny', 1_100)).toEqual({ ok: false, error: 'card_changed' });
    expect(requestApprovalAnswer('chat', 'c1', 'always' as never, 1_100)).toEqual({ ok: false, error: 'bad_choice' });
  });

  it('drops an answer for a card that was replaced or one the page never took', async () => {
    await noteApprovalCard('chat', true, 'session', deps, 1_000, card('c1'));
    const first = requestApprovalAnswer('chat', 'c1', 'allow', 1_100);
    expect(first.ok).toBe(true);
    // ChatGPT shows a different card: the answer for the old one must never reach it.
    await noteApprovalCard('chat', true, 'session', deps, 1_200, card('c2'));
    expect(approvalAnswerFor('chat', 1_200)).toBeNull();
    expect(approvalCardView('chat', 1_200)).toMatchObject({ id: 'c2', answer: null });
    const second = requestApprovalAnswer('chat', 'c2', 'deny', 1_300);
    expect(second.ok).toBe(true);
    expect(approvalAnswerFor('chat', 1_300 + APPROVAL_ANSWER_MS)).toBeNull();
    expect(approvalCardView('chat', 1_300 + APPROVAL_ANSWER_MS)?.answer).toMatchObject({ choice: 'deny', outcome: 'expired' });
  });
});

describe('the page detector', () => {
  const source = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
  let dom: JSDOM;
  let api: { approvalWaiting(): boolean; approvalCard(): null | { node: Element; lines: string[]; allow: boolean }; answerApprovalCard(node: Element, choice: string): string };
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

  // The live card's buttons on 2026-10-14 (German UI, Gmail): Deny carries an Esc key hint, Allow
  // once a Return hint, with a menu of further options beside it. No label is read.
  const liveCard = (allowDisabled = false) => `<div data-codex-approval-surface="true"><div role="alert" aria-atomic="true">
    <div><div><svg></svg><span>Gmail</span></div><div><div>ChatGPT erlauben, Gmail zu verwenden?</div>
    <div>Erstellt einen Entwurf. <button aria-haspopup="dialog">Details anzeigen</button></div></div></div></div>
    <div><div><button>Ablehnen<span><kbd>Esc</kbd></span></button>
    <div><button ${allowDisabled ? 'disabled' : ''}><span>Einmal zulassen</span><span><kbd>⏎</kbd></span></button><button aria-haspopup="menu" aria-label="Genehmigungsoptionen"></button></div></div></div></div>`;

  it('reads the card\'s words without its buttons, and whether Allow once can be pressed', () => {
    const main = dom.window.document.querySelector('main')!;
    main.innerHTML = liveCard();
    expect(api.approvalCard()).toMatchObject({ lines: ['Gmail', 'ChatGPT erlauben, Gmail zu verwenden?', 'Erstellt einen Entwurf.'], allow: true });
    main.innerHTML = liveCard(true);
    expect(api.approvalCard()?.allow).toBe(false);
    main.innerHTML = '';
    expect(api.approvalCard()).toBeNull();
  });

  it('presses Deny or Allow once by their key hints, never the options menu, and only on that card', () => {
    const main = dom.window.document.querySelector('main')!;
    main.innerHTML = liveCard();
    const clicks: string[] = [];
    for (const button of main.querySelectorAll('button')) button.addEventListener('click', () => clicks.push(button.textContent!.replace(/\s+/g, ' ').trim() || button.getAttribute('aria-label')!));
    const found = api.approvalCard()!;
    expect(api.answerApprovalCard(found.node, 'deny')).toBe('clicked');
    expect(api.answerApprovalCard(found.node, 'allow')).toBe('clicked');
    expect(clicks).toEqual(['AblehnenEsc', 'Einmal zulassen⏎']);
    expect(api.answerApprovalCard(found.node, 'always')).toBe('unavailable');
    main.innerHTML = liveCard(true);
    expect(api.answerApprovalCard(api.approvalCard()!.node, 'allow')).toBe('unavailable');
    // A card that is gone, or another one, is never answered by the old reference.
    const old = api.approvalCard()!.node;
    main.innerHTML = liveCard();
    expect(api.answerApprovalCard(old, 'deny')).toBe('card_changed');
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
