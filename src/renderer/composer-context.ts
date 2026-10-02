import type { LocalProject } from '../shared/projects.js';
import type { ProjectGitSnapshot } from '../shared/project-git.js';
import { $, el, icon } from './dom.js';
import { t, ui } from './i18n.js';

/** A disposable projection of the selected workspace. Main's Git reader owns the facts. */
export function createComposerContext(openReview: () => void) {
  const header = $('composerContext'), name = $('composerWorkspaceName'), branch = $('composerBranch');
  const stats = $('composerGitStats'), review = $<HTMLButtonElement>('composerReview');
  let project: LocalProject | null = null, generation = 0, signature = '', dismissed = false;
  function paint(snapshot?: ProjectGitSnapshot): void {
    header.hidden = !project || dismissed;
    name.textContent = project?.name ?? '';
    name.title = project?.path ?? '';
    branch.textContent = snapshot?.state === 'ready' ? snapshot.currentBranch ?? 'HEAD' : '';
    branch.hidden = !branch.textContent;
    stats.replaceChildren();
    stats.hidden = snapshot?.state !== 'ready';
    if (snapshot?.state === 'ready') {
      const exact = !snapshot.truncated && snapshot.changes.every(change => change.additions !== null && change.deletions !== null);
      if (exact) stats.append(
        el('span', 'metric-added', `+${snapshot.changes.reduce((sum, change) => sum + change.additions!, 0)}`),
        el('span', 'metric-removed', `−${snapshot.changes.reduce((sum, change) => sum + change.deletions!, 0)}`));
      else stats.append(el('span', '', () => t('{0} changed files', [`${snapshot.changes.length}${snapshot.truncated ? '+' : ''}`])));
    }
    review.disabled = !project;
  }
  async function refresh(): Promise<void> {
    const owner = project, epoch = ++generation;
    paint();
    if (!owner || typeof window.api.getProjectGitSnapshot !== 'function') return;
    const reply = await window.api.getProjectGitSnapshot(owner.id);
    if (epoch !== generation || project !== owner) return;
    paint(reply.ok && reply.data?.projectId === owner.id ? reply.data : undefined);
  }
  review.append(icon('i-git-diff'), el('span', '', () => t('Review changes')));
  review.onclick = openReview;
  $('composerContextDismiss').onclick = () => { dismissed = true; header.hidden = true; };
  $('composerWorkspace').onclick = () => { dismissed = false; void refresh(); };
  ui($('composerWorkspace'), 'title', () => t('Workspace'));
  const unsubscribe = window.api.onProjectGitChanged?.(change => {
    if (project?.id === change.projectId) void refresh();
  });
  window.addEventListener('beforeunload', () => { generation++; unsubscribe?.(); }, { once: true });
  return {
    update(next: LocalProject | null, revision: string): void {
      const nextSignature = `${next?.id ?? ''}:${revision}`;
      if (signature === nextSignature) return;
      if (project?.id !== next?.id) dismissed = false;
      project = next; signature = nextSignature;
      void refresh();
    }
  };
}
