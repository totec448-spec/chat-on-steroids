/**
 * The Goal step reviewer (#1832, Haz's review): after a Goal step that edited files, a worker in
 * the Goal chat's own family reads the step's changes and reports problems into the next step.
 * It reviews and may run commands such as tests, but it does not change files or start workers. This file is what it is told; the broker, the hold and the next message are
 * elsewhere (see AGENTS.md, "Goal step reviewer").
 *
 * Provenance before volume: every file the step changed is named with its counts and how many
 * edits made it, from the same records as the "Changed files" card, and the brief says plainly
 * that files changed by commands are not among them. The net diffs follow in the order the files
 * were first changed, whole, as many as fit; the ones that do not fit are named for the reviewer
 * to read itself through Core.
 */

/** The reviewer's opening message (or next-step message), at most. Well under a ChatGPT message. */
export const REVIEW_BRIEF_CHARS = 24_000;
const TEXT_CHARS = 1_500;
const PATH_CHARS = 300;
/** Room kept for the line naming the diffs that did not fit. */
const LEFT_OUT_CHARS = 1_200;

export interface ReviewFile {
  path: string;
  state: 'edited' | 'created' | 'deleted' | 'unchanged';
  added: number;
  removed: number;
  approximate: boolean;
  edits: number;
  /** The net unified diff's hunks; null when an end of it was not recorded. */
  diff: string | null;
  unavailable?: 'too-large' | 'not-kept' | null;
}

export interface ReviewBriefInput {
  /** The Goal's own objective, or the request the Goal chat started from. */
  objective: string;
  /** The message that started this step. */
  step: string;
  files: readonly ReviewFile[];
  /** Files the step changed beyond the ones listed. */
  more: number;
}

const clip = (text: string, max: number): string => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const oneLine = (path: string): string => clip(path.replace(/[\r\n\t]+/g, ' '), PATH_CHARS);

function counts(file: ReviewFile): string {
  const parts = [
    file.added || file.state === 'created' ? `+${file.added}` : '',
    file.removed || file.state === 'deleted' ? `−${file.removed}` : ''
  ].filter(Boolean).join(' ');
  return parts && file.approximate ? `about ${parts}` : parts;
}

function listed(file: ReviewFile): string {
  if (file.state === 'unchanged') return `- ${oneLine(file.path)}: changed and put back, no net change`;
  const edits = file.edits === 1 ? '1 edit' : `${file.edits} edits`;
  const missing = file.unavailable === 'too-large' ? ' (diff too large to record: read the file)'
    : file.diff === null ? ' (diff not recorded: read the file)' : '';
  return `- ${oneLine(file.path)}: ${[file.state, counts(file), edits].filter(Boolean).join(', ')}${missing}`;
}

export function reviewBrief(input: ReviewBriefInput): string {
  const head = [
    'Review this Goal step\'s changes. Read files and run commands such as tests as you need, but do not edit, create, move or delete files, and do not start or message other workers: the Goal chat makes the changes.',
    'Report real problems in these changes only: bugs, wrong or missing tests, callers this breaks, edge cases the step skipped. Give each one with its file and line. If there are none, answer exactly: No problems found.',
    'Start your answer with "BLOCKING:" only when the Goal cannot safely go on: data loss, a broken build, or a security problem the next step would build on.',
    'When you finish with RESULT / CHANGES / VALIDATION / BLOCKERS, the review is the RESULT: put the problems, "No problems found." or "BLOCKING: ..." there.',
    '',
    `The Goal: ${clip(input.objective.trim(), TEXT_CHARS)}`,
    `This step's instruction: ${clip(input.step.trim(), TEXT_CHARS)}`,
    '',
    'Changed in this step, as recorded by Chat On Steroids\' edit tools (files changed by commands are not listed):',
    ...input.files.map(listed),
    ...(input.more > 0 ? [`- and ${input.more} more files not listed`] : [])
  ].join('\n');
  const diffs: string[] = [];
  const leftOut: string[] = [];
  let used = head.length + '\n\nNet diffs (before this step, after it):'.length + LEFT_OUT_CHARS;
  for (const file of input.files) {
    if (file.state === 'unchanged' || !file.diff) continue;
    const path = oneLine(file.path);
    const block = `--- a/${path}\n+++ b/${path}\n${file.diff}`;
    if (used + block.length + 1 > REVIEW_BRIEF_CHARS) { leftOut.push(path); continue; }
    diffs.push(block);
    used += block.length + 1;
  }
  let left = leftOut.length ? `Diffs not included, read them through Core: ${leftOut.join(', ')}` : '';
  if (left.length > LEFT_OUT_CHARS) left = `${left.slice(0, LEFT_OUT_CHARS - 40)}… and the other files listed above`;
  const brief = [head, ...(diffs.length ? ['', 'Net diffs (before this step, after it):', ...diffs] : []), ...(left ? ['', left] : [])].join('\n');
  return brief.length > REVIEW_BRIEF_CHARS ? brief.slice(0, brief.lastIndexOf('\n', REVIEW_BRIEF_CHARS)) : brief;
}
