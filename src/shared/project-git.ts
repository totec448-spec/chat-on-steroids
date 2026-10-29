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
  /** The project's code checkpoints, newest first; `ref` is a `checkpoint:<id>` comparison choice. */
  /** `available` is false once Git's garbage collection removed the checkpoint's tree; it can be neither compared nor restored. */
  checkpoints?: Array<{ ref: string; createdAt: number; reason: 'turn' | 'restore'; available: boolean }>;
  /**
   * A branch comparison (merge-base → HEAD), or with `checkpoint` the working tree against a
   * checkpoint tree (`baseOid`), untracked files included.
   */
  comparison?: { ref: string; label: string; baseOid: string; headOid: string; checkpoint?: true };
  message?: string;
}

export const CHECKPOINT_REF_PREFIX = 'checkpoint:';

/** Outcome of a confirmed checkpoint Restore. `undoRef` compares against the state before it. */
export interface CheckpointRestoreResult {
  confirmed: boolean;
  restored: string[];
  skipped: Array<{ path: string; reason: 'changed' | 'conflict' | 'unsupported' | 'failed' }>;
  undoRef: string | null;
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

/** Commit & PR: whether the GitHub CLI can create a pull request here. */
export type GhStatus = 'ready' | 'signed-out' | 'missing';
export interface CommitState {
  /** Null on a detached HEAD. */
  branch: string | null;
  /** The remote's default branch (its HEAD), when known. */
  defaultBranch: string | null;
  /** The remote pushes go to: the branch's upstream remote, else `origin`, else the only one. */
  remote: string | null;
  upstream: string | null;
  github: { owner: string; repo: string } | null;
  /** Only asked when the remote is on GitHub. */
  gh: GhStatus | null;
  /** The working-tree changes the dialog lists, as Review shows them. */
  changes: ProjectGitChange[];
  /** Names these changes and their exact content; Commit refuses anything else. */
  token: string;
}
