/** Ephemeral presentation of one explicit renderer request; never delivery authority. */
export interface TaskProgress {
  requestId: string;
  phase: 'preparing' | 'generating' | 'ready' | 'retrying' | 'failed' | 'cancelled';
  text: string;
  error?: string;
  attempt?: number;
  retryAt?: number;
}
export type TaskProgressUpdate = Omit<TaskProgress, 'requestId'>;

/** Read a JSON string prefix without guessing unfinished escape sequences. */
function stringPrefix(source: string, start: number): { text: string; end: number; complete: boolean } | null {
  if (source[start] !== '"') return null;
  let text = '';
  for (let at = start + 1; at < source.length; at++) {
    const char = source[at]!;
    if (char === '"') return { text, end: at + 1, complete: true };
    if (char.charCodeAt(0) < 32) return null;
    if (char !== '\\') { text += char; continue; }
    if (++at === source.length) break;
    const escape = source[at]!;
    if (escape === 'u') {
      const digits = source.slice(at + 1, at + 5);
      if (!/^[0-9a-f]*$/i.test(digits)) return null;
      if (digits.length < 4) break;
      text += String.fromCharCode(parseInt(digits, 16)); at += 4;
    } else {
      const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (!(escape in escapes)) return null;
      text += escapes[escape];
    }
  }
  return { text, end: source.length, complete: false };
}

/** Presentation only: outer Goal reply contains an escaped JSON stages array.
 * Partial stage prose is useful immediately; protocol bytes are not. This prefix
 * reader never validates, queues or authorizes a plan, and keeps no stream state.
 */
export function planProgressText(raw: string): string {
  if (raw.length > 64_000) return '';
  const source = raw.trimStart();
  if (source[0] !== '{') return '';
  const space = (text: string, at: number): number => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; return at; };
  let at = 1;
  let reply: string | undefined;
  const keys = new Set<string>();
  while (at < source.length) {
    const key = stringPrefix(source, space(source, at));
    if (!key?.complete || !['action', 'reply'].includes(key.text) || keys.has(key.text)) return '';
    keys.add(key.text);
    at = space(source, key.end);
    if (source[at++] !== ':') return '';
    const value = stringPrefix(source, space(source, at));
    if (!value) return '';
    if (key.text === 'reply') { reply = value.text; break; }
    if (!value.complete || value.text !== 'continue') return '';
    at = space(source, value.end);
    if (source[at++] !== ',') return '';
  }
  if (reply === undefined) return '';
  const plan = reply.trimStart();
  if (plan[0] !== '{') return '';
  const key = stringPrefix(plan, space(plan, 1));
  if (!key?.complete || key.text !== 'stages') return '';
  at = space(plan, key.end);
  if (plan[at++] !== ':') return '';
  at = space(plan, at);
  if (plan[at++] !== '[') return '';
  const stages: string[] = [];
  while (stages.length < 12) {
    at = space(plan, at);
    if (at === plan.length || plan[at] === ']') break;
    const stage = stringPrefix(plan, at);
    if (!stage) return '';
    if (stage.text.trim()) stages.push(stage.text);
    if (!stage.complete) break;
    at = space(plan, stage.end);
    if (at === plan.length || plan[at] === ']') break;
    if (plan[at++] !== ',') return '';
  }
  return stages.map((stage, index) => `${index + 1}. ${stage}`).join('\n\n').slice(0, 8000);
}
