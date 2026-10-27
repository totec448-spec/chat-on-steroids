/**
 * The Commit dialog's starting message: the chat's task as the first line, the changed files
 * below. The person edits it before committing; nothing here is sent anywhere.
 */

const SUBJECT = 72;
const LISTED = 10;

function subjectOf(task: string): string {
  const line = task.trim().split(/\r?\n/, 1)[0]!.trim();
  const chars = [...line];
  if (chars.length <= SUBJECT) return line;
  const cut = chars.slice(0, SUBJECT + 1).join('');
  // A whole first sentence reads better than the start of the next one; a short opener ("Hi.") is no subject.
  const sentence = [...cut.matchAll(/[.!?](?=\s)/g)].map(match => match.index!).filter(at => at >= 20).at(-1);
  if (sentence !== undefined) return cut.slice(0, sentence + 1).replace(/[\s,.;:–-]+$/u, '');
  const space = cut.lastIndexOf(' ');
  return (space > 20 ? cut.slice(0, space) : chars.slice(0, SUBJECT).join('')).replace(/[\s,.;:–-]+$/u, '');
}

export function commitMessageDraft(task: string | null, paths: readonly string[]): string {
  const name = (file: string) => file.split('/').at(-1) ?? file;
  const subject = task?.trim() ? subjectOf(task) : paths.length === 1 ? `Update ${name(paths[0]!)}` : `Update ${paths.length} files`;
  const listed = paths.slice(0, LISTED).map(file => `- ${file}`);
  if (paths.length > LISTED) listed.push(`- and ${paths.length - LISTED} more`);
  return `${subject}\n\n${listed.join('\n')}\n`;
}

/** A branch name from a message's first line: lower case, ASCII, words joined by "-". */
export function branchNameFrom(message: string): string {
  const words = message.split(/\r?\n/, 1)[0]!.replace(/ß/g, 'ss').normalize('NFD').replace(/\p{M}+/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const short = words.length > 48 ? words.slice(0, 48).replace(/-[^-]*$/, '') || words.slice(0, 48) : words;
  return short.replace(/^-+|-+$/g, '') || 'changes';
}
