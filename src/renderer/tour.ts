import { t, ui } from './i18n.js';

/**
 * The first-run tour (#1833, Haz's review): offered once after Setup, never started by itself.
 * Three steps, each one sentence beside the real control with a ring around it: the composer with
 * its modes, Projects, and Review. Next and Skip tour; Enter/→ next, ← back, Escape skips. It only
 * points: nothing is clicked, sent or changed. A step whose control is not on screen (a collapsed
 * sidebar, a narrow window) is left out. Afterwards focus is back in the composer, and the tour is
 * never offered again; Settings can replay it.
 */

interface Step { target: string; text: () => string }

const STEPS: Step[] = [
  { target: 'composer', text: () => t('Write your task here, and pick Normal, Plan or Goal for how ChatGPT works on it.') },
  { target: 'addProject', text: () => t('A project is a folder you approve, and its chats start there.') },
  { target: 'rightDockToggle', text: () => t('Review shows every change ChatGPT made to your files.') }
];

const GAP = 12;

/** `markDone` says whether the once-only answer was saved; the caller tells the person when it was not. */
export function initTour(deps: { markDone(): Promise<boolean> }): { offer(): void; start(): void } {
  const $ = (id: string) => document.getElementById(id)!;
  const offerBar = $('tourOffer'), card = $('tourCard'), ring = $('tourRing');
  const text = $('tourText'), stepLabel = $('tourStep'), next = $('tourNext') as HTMLButtonElement;
  let steps: Step[] = [];
  let index = 0;
  let target: HTMLElement | null = null;

  // On screen for real: not hidden by an attribute or a style, with a box inside the window.
  const shown = (node: HTMLElement | null): node is HTMLElement => {
    if (!node || node.closest('[hidden]')) return false;
    for (let at: HTMLElement | null = node; at; at = at.parentElement) {
      const style = window.getComputedStyle(at);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.left < window.innerWidth && box.top < window.innerHeight;
  };

  function place(): void {
    if (!target) return;
    const box = target.getBoundingClientRect();
    // 4 px around the control, but never past the window's edge (a control in its corner).
    const left = Math.max(2, box.left - 4), top = Math.max(2, box.top - 4);
    const right = Math.min(window.innerWidth - 2, box.right + 4), bottom = Math.min(window.innerHeight - 2, box.bottom + 4);
    Object.assign(ring.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
    // Beside the control: below it when there is room, else above; kept inside the window.
    // The width first: the text wraps by it, and the height (measured next) follows.
    const width = Math.min(320, window.innerWidth - 2 * GAP);
    card.style.width = `${width}px`;
    const height = card.offsetHeight || 120;
    // Clear of the ring (4 px outside the control) by the gap.
    const below = box.bottom + 4 + GAP + height <= window.innerHeight;
    const cardTop = below ? box.bottom + 4 + GAP : Math.max(GAP, box.top - 4 - GAP - height);
    const cardLeft = Math.min(Math.max(GAP, box.left), window.innerWidth - width - GAP);
    Object.assign(card.style, { left: `${cardLeft}px`, top: `${cardTop}px` });
  }

  /** A step whose control left the screen (a narrower window, a collapsed sidebar) is left out, the current one too. */
  function onResize(): void {
    const current = steps[index];
    const stays = shown(target);
    steps = steps.filter(step => step === current ? stays : shown(document.getElementById(step.target)));
    if (!steps.length) { end(); return; }
    // A resize repaints without taking the focus from where the person is typing.
    index = stays ? steps.indexOf(current!) : Math.min(index, steps.length - 1);
    paint(false);
  }

  function paint(moveFocus = true): void {
    target?.classList.remove('is-tour-target');
    const step = steps[index]!;
    target = document.getElementById(step.target);
    target?.classList.add('is-tour-target');
    ui(text, 'textContent', step.text);
    const at = index + 1, of = steps.length;
    ui(stepLabel, 'textContent', () => t('{0} of {1}', [at, of]));
    ui(next, 'textContent', () => index === steps.length - 1 ? t('Done') : t('Next'));
    ring.hidden = false;
    card.hidden = false;
    place();
    if (moveFocus) next.focus();
  }

  function end(): void {
    target?.classList.remove('is-tour-target');
    target = null;
    card.hidden = true;
    ring.hidden = true;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    void deps.markDone().catch(() => undefined);
    (document.getElementById('chatInput') as HTMLTextAreaElement | null)?.focus();
  }

  function go(delta: number): void {
    // A control can leave the screen without a resize (a sidebar collapsed by a click): skip it.
    let to = index + delta;
    while (to >= 0 && to < steps.length && !shown(document.getElementById(steps[to]!.target))) to += delta;
    if (to < 0) return;
    if (to >= steps.length) { end(); return; }
    index = to;
    paint();
  }

  function onKey(event: KeyboardEvent): void {
    // The card does not trap the focus: keys elsewhere, the composer's included, stay theirs.
    if (card.hidden || !card.contains(document.activeElement)) return;
    if (event.key === 'Escape') { event.preventDefault(); end(); }
    // Enter on another button (Skip tour) does what that button says.
    else if (event.key === 'ArrowRight' || (event.key === 'Enter' && !((event.target as Element | null)?.tagName === 'BUTTON' && event.target !== next))) { event.preventDefault(); go(1); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); go(-1); }
  }

  function start(): void {
    offerBar.hidden = true;
    steps = STEPS.filter(step => shown(document.getElementById(step.target)));
    if (!steps.length) { void deps.markDone().catch(() => undefined); return; }
    index = 0;
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    paint();
  }

  next.addEventListener('click', () => go(1));
  $('tourSkip').addEventListener('click', () => end());
  $('tourOfferYes').addEventListener('click', () => start());
  $('tourOfferNo').addEventListener('click', () => { offerBar.hidden = true; void deps.markDone().catch(() => undefined); });

  return { offer() { offerBar.hidden = false; }, start };
}
