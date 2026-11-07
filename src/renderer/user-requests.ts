import { currentLanguage, ui, t, tn } from './i18n.js';
import { disclosureChevron, el, icon, run, toast } from './dom.js';
import type { UserRequestView } from '../shared/user-requests.js';

/**
 * A step ChatGPT handed to the person (#1695): the exact command, its folder, why and what it should
 * leave behind. The app never runs it and says so; nothing here reads as "checked" or "safe". Only
 * the person's click marks it done or skipped.
 */
export interface UserRequestActions {
  answer(request: UserRequestView, answer: 'done' | 'skipped'): Promise<void>;
  readOnly(): boolean;
  /** Where keyboard focus goes when no step action is left to hold it (the composer). */
  focusFallback?(): void;
}

const STEP_ACTION = '.user-request[data-state="open"] .user-request-actions button:not(:disabled)';

/**
 * Replaces step cards without dropping keyboard focus (CodeRabbit on #2049): when focus was on a
 * step inside `container`, it moves to the step now in the same place (or the one before it), and
 * when no open step is left, `fallback` takes it. Focus elsewhere is never moved.
 */
export function keepStepFocus(container: HTMLElement, replace: () => void, fallback?: () => void): void {
  const active = document.activeElement;
  // A clicked button is disabled while its answer is saved, which can drop focus to the body;
  // the card marks itself so the place is still known.
  const answering = container.querySelector<HTMLElement>('.user-request[data-answering]');
  const holder = active && active !== document.body && container.contains(active) ? active : answering;
  const cards = holder ? [...container.querySelectorAll<HTMLElement>('.user-request')] : [];
  const index = holder ? cards.findIndex(card => card.contains(holder)) : -1;
  replace();
  if (!holder || index < 0) return;
  const now = document.activeElement;
  if (now && now !== document.body && container.contains(now)) return;
  const open = [...container.querySelectorAll<HTMLButtonElement>(STEP_ACTION)]
    .filter(button => button === button.closest('.user-request')!.querySelector(STEP_ACTION));
  const next = open[Math.min(index, open.length - 1)];
  if (next) next.focus();
  else fallback?.();
}

/** In the app's language, with its own unit names. */
function size(bytes: number): string {
  const [value, unit] = bytes < 1024 ? [bytes, 'byte'] : bytes < 1024 * 1024 ? [bytes / 1024, 'kilobyte'] : [bytes / (1024 * 1024), 'megabyte'];
  // Bytes in full words ("9 bytes"; the short form reads "9 byte"), larger sizes as kB and MB.
  return new Intl.NumberFormat(currentLanguage(), { style: 'unit', unit, unitDisplay: unit === 'byte' ? 'long' : 'short', maximumFractionDigits: 1 }).format(value);
}

function clock(at: number): string {
  // The hour as the timeline writes its own times ("5:02 PM", not "05:02 PM"; 2.1.51 polish pass).
  return new Date(at).toLocaleString(currentLanguage(), { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
}

function copyButton(label: () => string, value: string): HTMLButtonElement {
  const button = el('button', 'tool-copy', label) as HTMLButtonElement;
  button.type = 'button';
  button.addEventListener('click', () => void (async () => {
    if (await run(window.api.writeClipboard(value))) ui(button, 'textContent', () => t('Copied'));
    else toast(t('Could not copy text.'));
  })());
  return button;
}

/** One step, in the timeline or in the list above the composer. */
export function userRequestCard(request: UserRequestView, actions: UserRequestActions): HTMLElement {
  const card = el('section', 'user-request');
  card.dataset.requestId = request.id;
  card.dataset.state = request.state;
  ui(card, 'aria-label', () => t('Step for you'));

  const head = el('div', 'user-request-head');
  head.append(icon('i-terminal'), el('b', '', () => t('Step for you')));
  const state = el('span', 'user-request-state', () => request.state === 'open' ? t('Waiting for you')
    : request.state === 'done' ? t('Marked done') : t('Skipped'));
  head.append(state);
  card.append(head);
  if (request.from) card.append(el('p', 'user-request-from', () => t('From the sub-agent “{0}”', [request.from!.title || t('New chat')])));
  card.append(el('p', 'user-request-purpose', request.purpose));

  const command = el('div', 'tool-output user-request-command');
  const header = el('div', 'tool-output-header');
  header.append(el('strong', '', () => t('Command')), copyButton(() => t('Copy'), request.command));
  const pre = el('pre', 'pre', request.command);
  command.append(header, pre);
  card.append(command);

  const facts = el('dl', 'user-request-facts');
  const folder = el('dd');
  folder.append(el('code', '', request.folder));
  facts.append(el('dt', '', () => t('Folder')), folder);
  card.append(facts);
  // Purpose, command, folder and the buttons always show; what the step should leave behind and its
  // note fold into one line when they run long (Haz on #2049), so the card stays easy to read.
  const extra = el('dl', 'user-request-facts');
  if (request.expected.length) {
    const list = el('ul', 'user-request-files');
    for (const file of request.expected) {
      const found = request.found.find(row => row.path === file.path);
      const item = el('li');
      item.append(el('code', '', file.path));
      const note = el('span', 'user-request-file-state', () => !found || request.state !== 'open' ? ''
        : found.state === 'found' ? t('found, {0}, {1}', [size(found.size ?? 0), clock(found.modifiedAt ?? 0)])
        : found.state === 'missing' ? t('not there yet') : t('not checked'));
      if (found) note.dataset.found = found.state;
      item.append(note);
      list.append(item);
    }
    const dd = el('dd');
    dd.append(list);
    extra.append(el('dt', '', () => t('Expected')), dd);
  }
  if (request.constraints) extra.append(el('dt', '', () => t('Note')), el('dd', '', request.constraints));
  if (request.expected.length >= 2 || (request.constraints?.length ?? 0) > 120) {
    const more = el('details', 'user-request-more');
    const summary = el('summary', '', () => [
      request.expected.length ? tn('{0} expected file', '{0} expected files', request.expected.length) : '',
      request.constraints ? t('Note') : ''
    ].filter(Boolean).join(' · '));
    summary.prepend(disclosureChevron());
    more.append(summary, extra);
    card.append(more);
  } else if (extra.childElementCount) {
    card.append(extra);
  }

  if (request.state === 'open') {
    card.append(el('p', 'user-request-note', () => t('Run it yourself, in your own terminal: Chat On Steroids does not run or check it.')));
    if (actions.readOnly()) card.append(el('p', 'user-request-note', () => t('Read-only is on in the app. This step runs in your own terminal, outside it.')));
    const buttons = el('div', 'user-request-actions');
    const done = el('button', 'btn btn-solid', () => t('Mark as done')) as HTMLButtonElement;
    const skip = el('button', 'btn', () => t('Skip')) as HTMLButtonElement;
    for (const [button, answer] of [[done, 'done'], [skip, 'skipped']] as const) {
      button.type = 'button';
      button.addEventListener('click', () => void (async () => {
        if (document.activeElement === button) card.dataset.answering = '';
        done.disabled = true; skip.disabled = true;
        try { await actions.answer(request, answer); }
        finally {
          delete card.dataset.answering;
          if (button.isConnected) { done.disabled = false; skip.disabled = false; }
        }
      })());
    }
    buttons.append(done, skip);
    card.append(buttons);
  } else if (request.answeredAt) {
    card.append(el('p', 'user-request-answered', () => request.state === 'done'
      ? t('You marked it done at {0}.', [clock(request.answeredAt!)])
      : t('You skipped it at {0}. ChatGPT is told it did not happen.', [clock(request.answeredAt!)])));
  }
  return card;
}

/**
 * The quiet line above the composer while steps wait (#1695): "1 step waiting for you", opening to
 * the steps themselves, so one is never lost far up a long chat.
 */
export function renderUserRequestsDock(host: HTMLElement, sessionId: string | null, requests: readonly UserRequestView[], actions: UserRequestActions): void {
  const open = sessionId ? requests.filter(request => request.state === 'open') : [];
  if (host.dataset.sessionId !== (sessionId ?? '')) { host.replaceChildren(); host.dataset.sessionId = sessionId ?? ''; delete host.dataset.signature; }
  if (!open.length) {
    keepStepFocus(host, () => { host.hidden = true; host.replaceChildren(); }, actions.focusFallback);
    delete host.dataset.signature;
    return;
  }
  const signature = JSON.stringify([open, actions.readOnly()]);
  if (host.dataset.signature === signature) return;
  const wasOpen = host.querySelector<HTMLDetailsElement>('.user-requests-shell')?.open ?? false;
  const shell = el('details', 'user-requests-shell') as HTMLDetailsElement;
  shell.open = wasOpen;
  const heading = el('summary', 'user-requests-heading');
  heading.append(icon('i-terminal'), el('span', 'user-requests-title', () => tn('{0} step waiting for you', '{0} steps waiting for you', open.length)));
  const body = el('div', 'user-requests-body');
  for (const request of open) body.append(userRequestCard(request, actions));
  shell.append(heading, body);
  keepStepFocus(host, () => host.replaceChildren(shell), actions.focusFallback);
  host.hidden = false;
  host.dataset.signature = signature;
}
