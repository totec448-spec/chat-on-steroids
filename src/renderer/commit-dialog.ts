import type { AppApi } from '../preload/index.js';
import type { CommitFlow } from '../shared/types.js';
import type { CommitState, ProjectGitChange } from '../shared/project-git.js';
import { branchNameFrom, commitMessageDraft } from '../shared/commit-message.js';
import { el, icon } from './dom.js';
import { onLanguageChange, t, tn } from './i18n.js';

type Api = Pick<AppApi, 'commitState' | 'commitProject' | 'pushProject' | 'createPullRequest' | 'setCommitFlow' | 'openLink'>;
type Step = { key: 'commit' | 'push' | 'pr'; state: 'working' | 'done' | 'failed'; text: () => string; link?: string };

const CHANGED = 'The changes changed. Review them again before committing.';

/**
 * Commit & PR from Review. The dialog lists the working-tree changes as Review shows them, starts
 * the message from the chat's task, and remembers how far to go: commit only, commit and then ask
 * to push, or commit, push and open a pull request. Each step reports its own result, and a failed
 * step can be tried again without repeating the ones before it.
 *
 * Main's errors are fixed sentences, translated here; what Git, a hook or gh printed follows on the
 * next lines and stays as it was.
 */
export function initCommitDialog(api: Api, deps: { flow: () => CommitFlow | undefined; task: (projectId: string) => string | null }): { open(projectId: string): void } {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = $<HTMLDialogElement>('commitDialog');
  const form = $<HTMLFormElement>('commitForm');
  const done = $('commitDone');
  const where = $('commitWhere');
  const message = $<HTMLTextAreaElement>('commitMessage');
  const filesLabel = $('commitFilesLabel');
  const files = $('commitFiles');
  const all = $<HTMLButtonElement>('commitFilesAll');
  const flows = [...form.querySelectorAll<HTMLInputElement>('input[name="commitFlow"]')];
  const flowNote = $('commitFlowNote');
  const closeButton = $('commitClose') as HTMLButtonElement;
  const branchField = $('commitBranchField');
  const branch = $<HTMLInputElement>('commitBranch');
  const error = $('commitError');
  const submit = $<HTMLButtonElement>('commitSubmit');
  const steps = $('commitSteps');
  const stepError = $('commitStepError');
  const notNow = $<HTMLButtonElement>('commitNotNow');
  const stepAction = $<HTMLButtonElement>('commitStepAction');
  const doneClose = $<HTMLButtonElement>('commitDoneClose');

  let projectId = '';
  let state: CommitState | null = null;
  let chosen = new Set<string>();
  let busy = false;
  // The branch field was typed into; a changed message no longer renames it.
  let branchEdited = false;
  let generation = 0;
  let progress: Step[] = [];
  let next: (() => Promise<void>) | null = null;
  const MAX_PR_TITLE = 256;
  let committedSubject = '';
  let committedBody = '';

  const translated = (text: string) => { const [head, ...rest] = text.split('\n'); return [t(head!), ...rest].join('\n'); };
  const failure = (caught: unknown) => translated(caught instanceof Error ? caught.message : String(caught));
  const flow = (): CommitFlow => (flows.find(input => input.checked)?.value as CommitFlow | undefined) ?? 'ask-push';
  const canPush = () => Boolean(state?.remote);
  const canPr = () => Boolean(state?.remote && state.github);
  /** A pull request comes from its own branch; a detached HEAD needs one to commit at all. */
  // Not knowing the default branch, the current one may be it: a pull request then gets its own branch too.
  const needsBranch = () => !state?.branch || (flow() === 'pr' && (state.defaultBranch === null || state.branch === state.defaultBranch));
  const showError = (text: string | null) => { error.hidden = !text; error.textContent = text ?? ''; if (text) error.scrollIntoView?.({ block: 'nearest' }); };

  function paintFiles(changes: readonly ProjectGitChange[]): void {
    files.replaceChildren(...changes.map(change => {
      const row = el('label', 'commit-file');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = chosen.has(change.path);
      box.addEventListener('change', () => { if (box.checked) chosen.add(change.path); else chosen.delete(change.path); paint(); });
      const status = el('span', `file-change-status is-${change.status.toLowerCase()}`, change.status);
      status.setAttribute('aria-hidden', 'true');
      const name = el('span', 'commit-file-path', change.previousPath ? `${change.previousPath} → ${change.path}` : change.path);
      name.title = name.textContent ?? '';
      if (change.status === 'C') { box.disabled = true; row.title = t('Resolve the conflicts first, then commit.'); }
      row.append(box, status, name);
      return row;
    }));
  }

  function paint(): void {
    const total = state?.changes.length ?? 0;
    filesLabel.textContent = t('Files ({0} of {1})', [chosen.size, total]);
    all.textContent = chosen.size ? t('Select none') : t('Select all');
    where.textContent = !state ? '' : state.branch
      ? state.remote ? t('On branch {0} · pushes to {1}', [state.branch, state.remote]) : t('On branch {0}', [state.branch])
      : t('Not on a branch');
    for (const input of flows) input.disabled = busy || (input.value !== 'commit' && !canPush()) || (input.value === 'pr' && !canPr());
    // A choice the repository cannot do falls back to the furthest one it can.
    if (flows.find(input => input.checked)?.disabled) {
      const fallback = flows.filter(input => !input.disabled).at(-1);
      if (fallback) fallback.checked = true;
    }
    // A choice that is not offered says why, whichever one is chosen.
    const note = !state ? '' : !canPush() ? t('This repository has no remote to push to.')
      : !state.github ? t('Pull requests need a remote on GitHub.')
      : flow() === 'pr' && state.gh === 'ready' ? t('The GitHub CLI creates the pull request.')
      : flow() === 'pr' && state.gh === 'signed-out' ? t("The GitHub CLI is not signed in, so GitHub's page opens to create the pull request.")
      : flow() === 'pr' ? t("GitHub's page opens to create the pull request. With the GitHub CLI (gh) signed in, the app creates it directly.")
      : '';
    flowNote.hidden = !note;
    flowNote.textContent = note;
    branchField.hidden = !needsBranch();
    if (needsBranch() && !branchEdited) branch.value = branchNameFrom(message.value);
    // How many files go in, and for a pull request that it pushes too: a remembered choice is spelled out here (Haz on #1825).
    submit.textContent = flow() === 'pr'
      ? tn('Commit {0} file, push and open a pull request', 'Commit {0} files, push and open a pull request', chosen.size)
      : tn('Commit {0} file', 'Commit {0} files', chosen.size);
    submit.disabled = busy || !state || !chosen.size;
    // While a step runs the dialog stays: its result belongs to this dialog, and a push cannot be called back.
    closeButton.disabled = busy;
    message.disabled = busy;
    all.disabled = busy || !total;
  }

  /** True once the list was read; false when it could not be (its error is shown) or a newer read took over. */
  async function load(keepMessage: boolean): Promise<boolean> {
    const asked = ++generation;
    state = null;
    showError(null);
    paint();
    const reply = await api.commitState(projectId);
    if (asked !== generation) return false;
    if (!reply.ok) { showError(failure(new Error(reply.error))); return false; }
    const before = chosen;
    state = reply.data;
    const committable = state.changes.filter(change => change.status !== 'C').map(change => change.path);
    // Reopened after a change: keep the files still listed that were chosen, and choose new ones.
    chosen = keepMessage ? new Set(committable.filter(file => before.has(file) || !before.size)) : new Set(committable);
    if (!keepMessage) {
      message.value = commitMessageDraft(deps.task(projectId), committable);
      branchEdited = false;
      const remembered = deps.flow() ?? 'ask-push';
      for (const input of flows) input.checked = input.value === remembered;
    }
    paintFiles(state.changes);
    paint();
    return true;
  }

  // ------------------------------------------------------------ the steps after Commit

  function paintSteps(): void {
    steps.replaceChildren(...progress.map(step => {
      const item = el('li', `commit-step is-${step.state}`);
      item.append(step.state === 'working' ? el('span', 'commit-step-spinner') : icon(step.state === 'done' ? 'i-check' : 'i-warning', 'ico commit-step-icon'));
      const text = el('span', 'commit-step-text', step.text());
      item.append(text);
      if (step.link) {
        const open = el('button', 'btn commit-step-link', () => t('Open')) as HTMLButtonElement;
        open.type = 'button';
        open.addEventListener('click', () => void api.openLink(step.link!, { external: true }));
        item.append(open);
      }
      return item;
    }));
  }

  function showDone(): void { form.hidden = true; done.hidden = false; }
  function setStep(step: Step): void { progress = [...progress.filter(item => item.key !== step.key), step]; paintSteps(); }
  function offer(action: { label: string; run: () => Promise<void> } | null, laterLabel?: boolean): void {
    next = action?.run ?? null;
    stepAction.hidden = !action;
    stepAction.textContent = action?.label ?? '';
    notNow.hidden = !laterLabel;
    doneClose.hidden = Boolean(action);
    (action ? stepAction : doneClose).focus();
  }
  function stepFailed(key: Step['key'], text: () => string, caught: unknown, retry: () => Promise<void>): void {
    setStep({ key, state: 'failed', text });
    stepError.hidden = false;
    stepError.textContent = failure(caught);
    offer({ label: t('Try again'), run: retry });
    doneClose.hidden = false;
  }

  async function push(then: 'pr' | 'stop'): Promise<void> {
    const session = generation;
    stepError.hidden = true;
    offer(null); doneClose.hidden = true;
    setStep({ key: 'push', state: 'working', text: () => t('Pushing…') });
    const reply = await api.pushProject(projectId).catch(caught => ({ ok: false as const, error: caught instanceof Error ? caught.message : String(caught) }));
    if (session !== generation) return;
    if (!reply.ok) { stepFailed('push', () => t('Not pushed'), new Error(reply.error), () => push(then)); return; }
    setStep({ key: 'push', state: 'done', text: () => t('Pushed {0} to {1}', [reply.data.branch, reply.data.remote]) });
    if (then === 'pr') await pullRequest();
    else offer(null);
  }

  async function pullRequest(): Promise<void> {
    const session = generation;
    stepError.hidden = true;
    offer(null); doneClose.hidden = true;
    setStep({ key: 'pr', state: 'working', text: () => t('Opening a pull request…') });
    const reply = await api.createPullRequest(projectId, committedSubject, committedBody)
      .catch(caught => ({ ok: false as const, error: caught instanceof Error ? caught.message : String(caught) }));
    if (session !== generation) return;
    if (!reply.ok) { stepFailed('pr', () => t('No pull request yet'), new Error(reply.error), pullRequest); return; }
    const { url, via } = reply.data;
    setStep(via === 'browser'
      ? { key: 'pr', state: 'done', text: () => t("GitHub's page opened in your browser. Create the pull request there.") }
      : { key: 'pr', state: 'done', text: () => via === 'existing' ? t('This branch already has a pull request.') : t('Pull request opened'), link: url });
    offer(null);
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !state) return;
    const text = message.value.trim();
    if (!text) { showError(t('Write a commit message.')); message.focus(); return; }
    if (!chosen.size) { showError(t('Choose at least one file to commit.')); return; }
    const newBranch = needsBranch() ? branch.value.trim() : undefined;
    if (needsBranch() && !newBranch) { showError(t('Name the new branch.')); branch.focus(); return; }
    const chosenFlow = flow();
    busy = true; showError(null); paint();
    void api.setCommitFlow(chosenFlow);
    try {
      const reply = await api.commitProject({ projectId, message: text, paths: [...chosen], ...(newBranch ? { newBranch } : {}), expectedToken: state.token });
      if (!reply.ok) {
        if (reply.error === CHANGED) {
          // What was reviewed moved on: the list is read again, the message kept, and the person decides again.
          busy = false;
          if (await load(true)) showError(t('The changes changed, so the list was read again. Check it, then commit.'));
          return;
        }
        showError(failure(new Error(reply.error)));
        return;
      }
      const [subject, ...rest] = text.split('\n');
      // GitHub takes a pull request title of at most 256 characters: the rest of a longer first line
      // opens the description, so a retry never meets the same refusal again.
      const first = Array.from(subject!.trim());
      const cut = first.length > MAX_PR_TITLE;
      committedSubject = cut ? `${first.slice(0, MAX_PR_TITLE - 1).join('')}…` : first.join('');
      committedBody = [cut ? `…${first.slice(MAX_PR_TITLE - 1).join('')}` : '', rest.join('\n').trim()].filter(Boolean).join('\n\n');
      const count = chosen.size;
      progress = [];
      stepError.hidden = true;
      showDone();
      setStep({ key: 'commit', state: 'done', text: () => tn('Committed {0} file as {1} on {2}', 'Committed {0} files as {1} on {2}', count, [count, reply.data.commit, reply.data.branch]) });
      if (chosenFlow === 'ask-push') offer({ label: t('Push'), run: () => push('stop') }, true);
      else if (chosenFlow === 'pr') await push('pr');
      else offer(null);
    } catch (caught) {
      showError(failure(caught));
    } finally {
      busy = false;
      paint();
    }
  });

  for (const input of flows) input.addEventListener('change', () => { showError(null); paint(); });
  message.addEventListener('input', () => { if (needsBranch() && !branchEdited) branch.value = branchNameFrom(message.value); });
  branch.addEventListener('input', () => { branchEdited = true; });
  all.addEventListener('click', () => {
    const committable = state?.changes.filter(change => change.status !== 'C').map(change => change.path) ?? [];
    chosen = chosen.size ? new Set() : new Set(committable);
    paintFiles(state?.changes ?? []);
    paint();
  });
  stepAction.addEventListener('click', async () => {
    const run = next;
    if (!run || busy) return;
    busy = true; paint();
    try { await run(); } finally { busy = false; paint(); }
  });
  const close = () => { generation += 1; if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open'); };
  for (const button of [closeButton, $('commitCancel'), doneClose, notNow]) button.addEventListener('click', () => { if (!busy) close(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!busy) close(); });
  onLanguageChange(() => { if (dialog.open) { paint(); paintSteps(); } });

  return {
    open(id: string) {
      projectId = id;
      busy = false;
      progress = [];
      form.hidden = false;
      done.hidden = true;
      chosen = new Set();
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
      void load(false).then(() => { if (dialog.open && !form.hidden) message.focus(); });
    }
  };
}
