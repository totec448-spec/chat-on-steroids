import type { ToolCallRecord } from '../shared/session.js';
import { t } from './i18n.js';

export function toolCommand(call: ToolCallRecord): string | null {
  if (call.tool !== 'exec_command') return null;
  try {
    const args = JSON.parse(call.args.text);
    if (typeof args.cmd === 'string') return args.cmd;
    if (Array.isArray(args.cmds) && args.cmds.every((cmd: unknown) => typeof cmd === 'string')) return args.cmds.join('\n');
  } catch { /* A cut argument is still available through inspection. */ }
  return null;
}

/** Structured values remain in inspection. Only actual text/output enters the execution tree. */
export function readableToolOutput(call: ToolCallRecord, readable: string): string {
  if (call.tool === 'apply_patch' && call.outcome === 'ok') return '';
  try {
    const envelope = JSON.parse(call.result.text);
    const structured = envelope.structuredContent;
    if (typeof structured?.output === 'string') return structured.output;
  } catch { /* Plain text recordings have no envelope. */ }
  if (['exec_command', 'write_stdin'].includes(call.tool) && /^(?:Chunk ID:|Wall time:)/.test(readable)) {
    const marker = readable.indexOf('\nOutput:\n');
    if (marker >= 0) return readable.slice(marker + 9);
  }
  try {
    const result = JSON.parse(readable);
    if (typeof result === 'string') return result;
    for (const field of ['output', 'text', 'message', 'error']) {
      if (typeof result?.[field] === 'string') return result[field];
    }
    return '';
  } catch {
    // A truncated JSON object is a payload prefix, not a readable terminal result.
    if (/^\s*(?:\{|\[\s*\{)/.test(readable)) return '';
    return readable;
  }
}

export function executionRecap(calls: readonly HTMLElement[]): string {
  let commands = 0, files = 0, edits = 0, other = 0;
  for (const call of calls) {
    const kind = call.dataset.toolKind;
    if (kind === 'run' || kind === 'process') commands++;
    else if (kind === 'read') files += Number(call.dataset.fileCount) || 1;
    else if (['edit', 'create', 'delete', 'move'].includes(kind ?? '')) edits++;
    else other++;
  }
  const parts: string[] = [];
  if (commands) parts.push(commands === 1 ? t('Executed 1 command') : t('Executed {0} commands', [commands]));
  if (files) parts.push(files === 1 ? t('Read 1 file') : t('Read {0} files', [files]));
  if (edits) parts.push(edits === 1 ? t('1 edit') : t('{0} edits', [edits]));
  if (other) parts.push(other === 1 ? t('1 other action') : t('{0} other actions', [other]));
  return parts.join(' · ');
}
