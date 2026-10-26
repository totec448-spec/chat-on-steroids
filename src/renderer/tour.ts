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

export function initTour(deps: { markDone(): Promise<unknown> }): { offer(): void; start(): void } {
  const $ = (id: string) => document.getElementById(id)!;
  const offerBar = $('tourOffer'), card = $('tourCard'), ring = $('tourRing');
  const text = $('tourText'), stepLabel = $('tourStep'), next = $('tourNext') as HTMLButtonElement;
  let steps: Step[] = [];
  let index = 0;
  let target: HTMLElement | null = null;

  const shown = (node: HTMLElement | null): node is HTMLElement => {
    if (!node || node.closest('[hidden]')) return false;
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };

  function place(): void {
    if (!target) return;
    const box = target.getBoundingClientRect();
    Object.assign(ring.style, { left: `${box.left - 4}px`, top: `${box.top - 4}px`, width: `${box.width + 8}px`, height: `${box.height + 8}px` });
    // Beside the control: below it when there is room, else above; kept inside the window.
    const width = Math.min(320, window.innerWidth - 2 * GAP);
    const height = card.offsetHeight || 120;
    const below = box.bottom + GAP + height <= window.innerHeight;
    const top = below ? box.bottom + GAP : Math.max(GAP, box.top - GAP - height);
    const left = Math.min(Math.max(GAP, box.left), window.innerWidth - width - GAP);
    Object.assign(card.style, { left: `${left}px`, top: `${top}px`, width: `${width}px` });
  }

  function paint(): void {
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
    next.focus();
  }

  function end(): void {
    target?.classList.remove('is-tour-target');
    target = null;
    card.hidden = true;
    ring.hidden = true;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    void deps.markDone().catch(() => undefined);
    (document.getElementById('chatInput') as HTMLTextAreaElement | null)?.focus();
  }

  function go(delta: number): void {
    const to = index + delta;
    if (to < 0) return;
    if (to >= steps.length) { end(); return; }
    index = to;
    paint();
  }

  function onKey(event: KeyboardEvent): void {
    if (card.hidden) return;
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
    window.addEventListener('resize', place);
    paint();
  }

  next.addEventListener('click', () => go(1));
  $('tourSkip').addEventListener('click', () => end());
  $('tourOfferYes').addEventListener('click', () => start());
  $('tourOfferNo').addEventListener('click', () => { offerBar.hidden = true; void deps.markDone().catch(() => undefined); });

  return { offer() { offerBar.hidden = false; }, start };
}
