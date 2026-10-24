/** Modified, added, deleted, renamed, untracked, or C: an unmerged path in a merge, rebase or cherry-pick. */
export type ProjectGitStatus = 'M' | 'A' | 'D' | 'R' | 'U' | 'C';

/** One real Git change, expressed relative to the selected Local Project. */
export interface ProjectGitChange {
  status: ProjectGitStatus;
  path: string;
  previousPath?: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface ProjectGitSnapshot {
  projectId: string;
  state: 'ready' | 'not-repository' | 'unavailable';
  changes: ProjectGitChange[];
  truncated: boolean;
  /** Stable content identity used to avoid remounting an unchanged open diff. */
  revision: string;
  /** The checked-out branch, or a short commit when HEAD is detached. */
  currentBranch?: string;
  /** Local and locally cached remote branches; selecting one never checks it out or fetches. */
  branches?: Array<{ ref: string; label: string }>;
  branchesTruncated?: boolean;
  /** Present only for committed branch comparisons (merge-base → HEAD). */
  comparison?: { ref: string; label: string; baseOid: string; headOid: string };
  message?: string;
}

export interface ProjectGitDiff {
  projectId: string;
  status: ProjectGitStatus;
  path: string;
  previousPath?: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  tooLarge: boolean;
  baseText: string | null;
  currentText: string | null;
  note?: string;
  /**
   * Only for a working-tree `C` path: Git's index stages 1 (common base), 2 (ours, HEAD) and
   * 3 (theirs). Null is a side without that file (added or deleted there). Absent when a side
   * is binary, too large or unreadable.
   */
  conflict?: { base: string | null; ours: string | null; theirs: string | null };
}

/** Git metadata changed. This is only an invalidation signal; main rereads Git before publishing. */
export interface ProjectGitChanged {
  projectId: string;
}
