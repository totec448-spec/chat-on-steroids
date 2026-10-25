import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_ANSWER_MS, APPROVAL_FRESH_MS, APPROVAL_GONE_MS, APPROVAL_NOTICE_GRACE_MS, approvalAnswerFor, approvalCardView, approvalCardWaiting, approvalWaitingChats, noteApprovalCard,
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

  it('takes back "answered" when the same card returns at once, so a redrawn card stays one request', async () => {
    // VM, 2026-10-20: ChatGPT redrew the card; it was gone for 1.2 s. The chat said the approval
    // was answered (nobody had answered) and showed the same request again below.
    const card = { id: 'node-1', lines: ['Allow ChatGPT to use Chat On Steroids Core?', 'Start a worker.'], allow: true };
    await noteApprovalCard('chat', true, 'session', deps, 1_000, card);
    await noteApprovalCard('chat', true, 'session', deps, 1_000 + APPROVAL_NOTICE_GRACE_MS, card);
    expect(deps.notices).toEqual(['session']);
    await noteApprovalCard('chat', false, 'session', deps, 40_000);
    await noteApprovalCard('chat', true, 'session', deps, 40_000 + APPROVAL_GONE_MS - 1, { ...card, id: 'node-2' });
    const id = deps.rows[0]![1];
    expect(deps.rows.every(row => row[1] === id)).toBe(true);
    expect(deps.rows.at(-1)![2]).toBe(APPROVAL_WAITING_TEXT);
    expect(deps.notices).toEqual(['session']);
    expect(approvalCardWaiting('chat', 40_000 + APPROVAL_GONE_MS)).toBe(true);
    expect(approvalCardView('chat', 40_000 + APPROVAL_GONE_MS)?.id).toBe('node-2');

    // A real answer later still reads as answered.
    await noteApprovalCard('chat', false, 'session', deps, 60_000);
    expect(deps.rows.at(-1)![2]).toBe(APPROVAL_ANSWERED_TEXT);
    expect(approvalCardWaiting('chat', 60_000)).toBe(false);
  });

  it('keeps an answer when a different card follows it, or the same one only after a while', async () => {
    const first = { id: 'a', lines: ['Allow ChatGPT to use Chat On Steroids Core?', 'Run one command.'], allow: true };
    const second = { id: 'b', lines: ['Allow ChatGPT to use Chat On Steroids Core?', 'Write one file.'], allow: true };
    await noteApprovalCard('chat', true, 'session', deps, 1_000, first);
    await noteApprovalCard('chat', false, 'session', deps, 2_000);
    await noteApprovalCard('chat', true, 'session', deps, 3_000, second);
    await noteApprovalCard('chat', false, 'session', deps, 4_000);
    await noteApprovalCard('chat', true, 'session', deps, 4_000 + APPROVAL_GONE_MS, { ...second, id: 'c' });
    const episodes = new Set(deps.rows.map(row => row[1]));
    expect(episodes.size).toBe(3);
    expect(deps.rows.filter(row => row[2] === APPROVAL_ANSWERED_TEXT)).toHaveLength(2);
  });

  it('takes over the row an earlier app run left waiting instead of adding another', async () => {
    // VM, 2026-10-20: every restart while one card waited added a "waiting" row, five in the end.
    const lookups: string[] = [];
    deps.previous = async sessionId => {
      lookups.push(sessionId);
      return { progressId: 'approval-wait:chat:earlier-run', anchor: { seq: 3, time: 5 } };
    };
    await noteApprovalCard('chat', true, 'session', deps, 1_000);
    expect(lookups).toEqual(['session']);
    expect(deps.rows).toEqual([]);
    await noteApprovalCard('chat', false, 'session', deps, 2_000);
    expect(deps.rows).toEqual([['session', 'approval-wait:chat:earlier-run', APPROVAL_ANSWERED_TEXT, { seq: 3, time: 5 }]]);
  });

  it('starts its own row when the last one was answered, belongs to another chat, or is missing', async () => {
    for (const previous of [null, { progressId: 'approval-wait:other-chat:1', anchor: { seq: 3, time: 5 } }]) {
      resetApprovalWaits();
      deps.rows.length = 0;
      deps.previous = async () => previous;
      await noteApprovalCard('chat', true, 'session', deps, 1_000);
      expect(deps.rows.map(row => row[2])).toEqual([APPROVAL_WAITING_TEXT]);
      expect(deps.rows[0]![1]).toMatch(/^approval-wait:chat:/);
    }
  });

  it('holds recovery for a chat the app has not recorded, without a row or notice', async () => {
    await noteApprovalCard('chat', true, null, deps, 1_000);
    await noteApprovalCard('chat', true, null, deps, 1_000 + APPROVAL_NOTICE_GRACE_MS);
    expect(approvalCardWaiting('chat', 1_000 + APPROVAL_NOTICE_GRACE_MS)).toBe(true);
    expect(deps.rows).toEqual([]);
    expect(deps.notices).toEqual([]);
  });
});

// The sidebar's Inbox ranks every chat, not only the open one, so the list carries the waits.
describe('the session list view', () => {
  beforeEach(() => resetApprovalWaits());
  afterEach(() => { vi.useRealTimers(); resetApprovalWaits(); });

  it('lists the chats whose card waits and drops one once answered or no longer reported, saying so each time', async () => {
    vi.useFakeTimers();
    const changes: string[] = [];
    const deps: ApprovalWaitDeps = { record: async () => ({ seq: 1, time: 1 }), notify: () => undefined, log: () => undefined,
      changed: () => { changes.push('changed'); } };
    await noteApprovalCard('answered', true, 'session-a', deps, 1_000);
    await noteApprovalCard('unrecorded', true, null, deps, 1_000);
    expect(approvalWaitingChats(1_000).sort()).toEqual(['answered', 'unrecorded']);
    expect(changes).toHaveLength(2);
    // Another poll of the same card changes nothing.
    await noteApprovalCard('answered', true, 'session-a', deps, 3_000);
    expect(changes).toHaveLength(2);
    await noteApprovalCard('answered', false, 'session-a', deps, 5_000);
    expect(approvalWaitingChats(5_000)).toEqual(['unrecorded']);
    expect(changes).toHaveLength(3);
    // A page that stopped reporting: the same freshness rule as the recovery hold, and one push
    // when it runs out, because no poll is left to cause one.
    expect(approvalWaitingChats(1_000 + APPROVAL_FRESH_MS - 1)).toEqual(['unrecorded']);
    expect(approvalWaitingChats(1_000 + APPROVAL_FRESH_MS)).toEqual([]);
    await vi.advanceTimersByTimeAsync(APPROVAL_FRESH_MS);
    expect(changes).toHaveLength(4);
  });

  it('pushes the list once the wait has gone stale, even when its timer fires a moment early', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const pushed: string[][] = [];
    const deps: ApprovalWaitDeps = { record: async () => ({ seq: 1, time: 1 }), notify: () => undefined, log: () => undefined,
      changed: () => { pushed.push(approvalWaitingChats()); } };
    // The poll's clock reads 20 ms past the timer's start: the timer comes due 20 ms before the wait goes stale.
    await noteApprovalCard('chat', true, null, deps, 20);
    expect(pushed).toEqual([['chat']]);
    await vi.advanceTimersByTimeAsync(APPROVAL_FRESH_MS);
    // Due, but the wait is still fresh: a push now would say waiting, with nothing left to push again.
    expect(approvalWaitingChats()).toEqual(['chat']);
    await vi.advanceTimersByTimeAsync(20);
    expect(approvalWaitingChats()).toEqual([]);
    expect(pushed.at(-1)).toEqual([]);
    expect(pushed).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(APPROVAL_FRESH_MS);
    expect(pushed).toHaveLength(2);
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

  // Rows the live card may also produce: a term or value wrapped in its own div, two terms in a row,
  // a term and a value in different rows, and a value too long to share a line with its label.
  it('pairs a label only with the value of its own row, keeps wrapped parts together and never cuts a value', () => {
    const long = 'v'.repeat(290);
    dom.window.document.querySelector('main')!.innerHTML = `<div data-codex-approval-surface="true"><div role="alert"><dl>
      <div class="grid"><dt><div>Ordner</div></dt><dd><div>C:/demo</div></dd></div>
      <div class="grid"><dt>Schlüssel</dt><dd><div>Access</div><div>key</div></dd></div>
      <div class="grid"><dt>Erster</dt><dt>Zweiter</dt><dd>Wert</dd></div>
      <div class="grid"><dt>Allein</dt></div><div class="grid"><dd>Fremd</dd></div>
      <div class="grid"><dt>Beschreibung lang</dt><dd>${long}</dd></div></dl></div>
      <button>Ablehnen<kbd>Esc</kbd></button><button>Einmal zulassen<kbd>⏎</kbd></button></div>`;
    expect(api.approvalCard()?.lines).toEqual(['Ordner: C:/demo', 'Schlüssel: Access key', 'Erster', 'Zweiter: Wert', 'Allein', 'Fremd', 'Beschreibung lang', long]);
  });

  // The live card on 2026-10-25 (German UI, a key-shaped value in the request) lists the shared data
  // as a <dl>: a label and its value in one grid row. Read as one block they ran together into
  // "Zugangsschlüsselsk-proj-…" in the app's copy of the card.
  it('keeps a shared-data label and its value apart', () => {
    dom.window.document.querySelector('main')!.innerHTML = `<div data-codex-approval-surface="true"><div role="alert">
      <div>ChatGPT erlauben, Chat On Steroids Core zu verwenden?</div><div>Zu den geteilten Daten gehören:</div>
      <dl class="@container"><div class="grid"><dt>Zugangsschlüssel</dt><dd><span class="min-w-0"><span>sk-proj-FAKE0123</span></span></dd></div>
      <div class="grid"><dt>Befehl</dt><dd><span>echo test</span></dd></div>
      <div class="grid"><dd>ohne Label</dd></div><div class="grid"><dt>Nur Label</dt></div></dl></div>
      <button>Ablehnen<kbd>Esc</kbd></button><button>Einmal zulassen<kbd>⏎</kbd></button></div>`;
    expect(api.approvalCard()?.lines).toEqual(['ChatGPT erlauben, Chat On Steroids Core zu verwenden?', 'Zu den geteilten Daten gehören:',
      'Zugangsschlüssel: sk-proj-FAKE0123', 'Befehl: echo test', 'ohne Label', 'Nur Label']);
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
