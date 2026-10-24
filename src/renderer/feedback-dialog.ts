import type { AppApi } from '../preload/index.js';
import { isNewer, type UpdateStatus } from '../shared/types.js';
import { onLanguageChange, t } from './i18n.js';

type Kind = 'bug' | 'idea';
type Frequency = 'Every time' | 'Sometimes' | 'It happened once';

/**
 * Send feedback: a problem report or an idea, written here and finished on GitHub, where the form
 * opens filled in. A problem report needs the diagnostics report, which is saved first (the issue
 * form closes reports without one); a newer release is pointed out first, since many problems are
 * already fixed in it. What was typed stays until it reached GitHub, so closing by mistake loses nothing.
 */
export function initFeedbackDialog(
  api: Pick<AppApi, 'openFeedbackIssue' | 'saveDiagnosticsReport' | 'writeClipboard'>,
  deps: { update: () => UpdateStatus | null; openActivity: () => void }
): { open(kind?: Kind): void } {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = $<HTMLDialogElement>('feedbackDialog');
  const form = $<HTMLFormElement>('feedbackForm');
  const done = $('feedbackDone');
  const kinds = [...form.querySelectorAll<HTMLInputElement>('input[name="feedbackKind"]')];
  const what = $<HTMLTextAreaElement>('feedbackWhat');
  const steps = $<HTMLTextAreaElement>('feedbackSteps');
  const frequency = $<HTMLSelectElement>('feedbackFrequency');
  const problem = $<HTMLTextAreaElement>('feedbackProblem');
  const proposal = $<HTMLTextAreaElement>('feedbackProposal');
  const report = $('feedbackSaveReport') as HTMLButtonElement;
  const reportRow = report.closest<HTMLElement>('.feedback-report')!;
  const reportNote = $('feedbackReportNote');
  const update = $('feedbackUpdate');
  const error = $('feedbackError');
  const submit = $<HTMLButtonElement>('feedbackSubmit');
  // The diagnostics report saved for this draft, by file name; the next draft saves its own.
  let savedReport: string | null = null;
  let busy = false;
  let sent: { kind: Kind; trimmed: boolean; report: string | null } | null = null;

  const kind = (): Kind => kinds.find(input => input.checked)?.value === 'idea' ? 'idea' : 'bug';
  const newer = (): string | null => {
    const status = deps.update();
    return status?.latest && isNewer(status.latest, status.current) ? status.latest : null;
  };
  const paint = () => {
    const bug = kind() === 'bug';
    $('feedbackBug').hidden = !bug;
    $('feedbackIdea').hidden = bug;
    const latest = bug ? newer() : null;
    update.hidden = !latest;
    $('feedbackUpdateText').textContent = latest
      ? t('Version {0} is out and may already fix this. Update first.', [latest]) : '';
    reportRow.classList.toggle('is-saved', Boolean(savedReport));
    reportNote.textContent = savedReport
      ? t('Saved as {0}. Read it, then attach it on GitHub.', [savedReport])
      : t('Needed for a problem report. Read it before you attach it.');
    report.textContent = savedReport ? t('Save again…') : t('Save report…');
    report.disabled = busy;
    submit.disabled = busy;
    for (const input of kinds) input.disabled = busy;
    if (sent) {
      $('feedbackDoneText').textContent = sent.kind === 'bug' && sent.report
        ? t('GitHub is open in your browser. Attach {0} in its Diagnostics report box yourself, then submit.', [sent.report])
        : t('GitHub is open in your browser. Read the form there, then submit it.');
      $('feedbackDoneTrimmed').hidden = !sent.trimmed;
    }
  };
  const showError = (message: string | null, field?: HTMLElement) => {
    error.hidden = !message;
    error.textContent = message ?? '';
    // The sentence sits above the buttons; in a short window the fields scroll, so it is brought into view.
    if (message) error.scrollIntoView?.({ block: 'nearest' });
    field?.focus({ preventScroll: true });
  };
  const close = () => { if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open'); };
  const showForm = (formShown: boolean) => { form.hidden = !formShown; done.hidden = formShown; };

  for (const input of kinds) input.addEventListener('change', () => { showError(null); paint(); });
  report.addEventListener('click', async () => {
    if (busy) return;
    busy = true; showError(null); paint();
    try {
      const reply = await api.saveDiagnosticsReport();
      if (!reply.ok) showError(t(reply.error));
      else if (reply.data.saved) savedReport = reply.data.name;
    } catch (failure) {
      showError(t(failure instanceof Error ? failure.message : String(failure)));
    } finally { busy = false; paint(); }
  });
  $('feedbackUpdateOpen').addEventListener('click', () => { close(); deps.openActivity(); });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const chosen = kind();
    if (chosen === 'bug' && !what.value.trim()) return showError(t('Write what happened.'), what);
    if (chosen === 'bug' && !savedReport) return showError(t('Save the diagnostics report first. A problem report on GitHub needs it.'), report);
    if (chosen === 'idea' && !problem.value.trim()) return showError(t('Write what problem it would solve.'), problem);
    if (chosen === 'idea' && !proposal.value.trim()) return showError(t('Write what the app should do.'), proposal);
    const sending = chosen === 'bug'
      ? { kind: 'bug' as const, what: what.value, ...(steps.value.trim() ? { steps: steps.value } : {}),
          ...(frequency.value ? { frequency: frequency.value as Frequency } : {}) }
      : { kind: 'idea' as const, problem: problem.value, proposal: proposal.value };
    busy = true; showError(null); paint();
    try {
      const reply = await api.openFeedbackIssue(sending);
      if (!reply.ok) { showError(t(reply.error)); return; }
      if (reply.data.trimmed) {
        // The link carries what fits; the whole text waits on the clipboard to be pasted there.
        const whole = sending.kind === 'bug'
          ? [sending.what.trim(), sending.steps?.trim()].filter(Boolean).join('\n\n')
          : `${sending.problem.trim()}\n\n${sending.proposal.trim()}`;
        // A failed copy keeps the draft: GitHub then holds only the shortened text, and the rest is here.
        const copied = await api.writeClipboard(whole).catch(() => null);
        if (!copied?.ok || !copied.data) {
          showError(t('GitHub opened with a shortened text. The whole text could not be copied, so it stays here.'));
          return;
        }
      }
      sent = { kind: chosen, trimmed: reply.data.trimmed, report: savedReport };
      for (const field of [what, steps, problem, proposal]) field.value = '';
      frequency.value = '';
      savedReport = null;
      showForm(false);
      paint();
      $('feedbackDoneClose').focus();
    } catch (failure) {
      showError(t(failure instanceof Error ? failure.message : String(failure)));
    } finally { busy = false; paint(); }
  });
  for (const id of ['feedbackCancel', 'feedbackClose', 'feedbackDoneClose']) $(id).addEventListener('click', () => close());
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!busy) close(); });
  onLanguageChange(() => { if (dialog.open) paint(); });

  return {
    open(next?: Kind) {
      sent = null;
      showForm(true);
      showError(null);
      if (next) for (const input of kinds) input.checked = input.value === next;
      paint();
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
      (kind() === 'bug' ? what : problem).focus();
    }
  };
}
