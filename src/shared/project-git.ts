export type ProjectGitStatus = 'M' | 'A' | 'D' | 'R' | 'U';

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
}

/** Git metadata changed. This is only an invalidation signal; main rereads Git before publishing. */
export interface ProjectGitChanged {
  projectId: string;
}
