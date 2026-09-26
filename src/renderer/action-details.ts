import type { StoredText, ToolCallRecord } from '../shared/session.js';
import { normalizedToolOutcome } from '../shared/session.js';
import { el } from './dom.js';
import { t } from './i18n.js';

/** Presentation budgets, independent of the recorder's inline/overflow limits. */
export const ACTION_DETAILS_LIMITS = {
  jsonChars: 256 * 1024,
  textChars: 24_000,
  lines: 240,
  lineChars: 2_000,
  fieldChars: 1_000,
  items: 20
} as const;

type RecordValue = Record<string, unknown>;
type Budget = { chars: number; lines: number; clipped: boolean };
type Field = readonly [key: string, label: string];
const browserTools = new Set([
  'browser_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_navigate',
  'browser_action', 'browser_evaluate', 'browser_console', 'browser_network'
]);
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const incomplete = (value: StoredText): boolean => value.truncated || value.chars > value.text.length;

function storedObject(value: StoredText): RecordValue | null {
  // A valid-looking prefix is still incomplete evidence. Never repair cut JSON or
  // fetch its overflow asset, the filesystem, a browser tab or current Git state here.
  if (incomplete(value) || value.text.length > ACTION_DETAILS_LIMITS.jsonChars) return null;
  try { return record(JSON.parse(value.text)); } catch { return null; }
}

function clippedText(value: string, budget: Budget, maximum = budget.chars): string {
  let end = Math.min(value.length, Math.max(0, maximum), budget.chars);
  // Keep a UTF-16 pair intact when a view boundary falls inside an authored character.
  if (end > 0 && end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
  budget.chars -= end;
  if (end < value.length) budget.clipped = true;
  return value.slice(0, end);
}

function note(parent: HTMLElement, text: string): void {
  parent.append(el('p', 'action-details-note', () => t(text)));
}

function field(parent: HTMLElement, label: string, value: unknown, budget: Budget): void {
  if (!(typeof value === 'string' || typeof value === 'boolean' ||
      typeof value === 'number' && Number.isFinite(value))) return;
  const text = clippedText(String(value), budget, ACTION_DETAILS_LIMITS.fieldChars);
  if (!text && value !== '') return;
  const row = el('div', 'action-details-field');
  row.append(el('dt', '', () => t(label)), el('dd', '', text));
  parent.append(row);
}

function fields(parent: HTMLElement, data: RecordValue | null, names: readonly Field[], budget: Budget): void {
  if (!data) return;
  for (const [key, label] of names) field(parent, label, data[key], budget);
}

function listField(parent: HTMLElement, label: string, value: unknown, budget: Budget): void {
  if (!Array.isArray(value)) return;
  if (value.length > ACTION_DETAILS_LIMITS.items) budget.clipped = true;
  for (const entry of value.slice(0, ACTION_DETAILS_LIMITS.items)) {
    if (typeof entry === 'string') field(parent, label, entry, budget);
  }
}

/** Preserve every displayed prefix, including +/-, without inventing source line numbers. */
function code(parent: HTMLElement, label: string, value: string, budget: Budget, patch = false): void {
  const shown = clippedText(value, budget);
  if (!shown && value.length) return;
  parent.append(el('h4', 'action-details-label', () => t(label)));
  const pre = el('pre', 'action-details-code');
  pre.dir = 'ltr';
  const lines = shown.split('\n', budget.lines + 1);
  let inFile = false;
  for (let index = 0; index < lines.length; index++) {
    if (budget.lines <= 0) { budget.clipped = true; break; }
    budget.lines--;
    let line = lines[index]!.replace(/\r$/, '');
    if (line.length > ACTION_DETAILS_LIMITS.lineChars) {
      let end: number = ACTION_DETAILS_LIMITS.lineChars;
      if (/[\uD800-\uDBFF]/.test(line[end - 1]!)) end--;
      line = line.slice(0, end);
      budget.clipped = true;
    }
    let kind = 'context';
    if (patch) {
      if (/^\*\*\* (?:Add|Update|Delete) File: .+/.test(line)) { inFile = true; kind = 'file'; }
      else if (inFile && /^\*\*\* Move to: .+/.test(line)) kind = 'file';
      else if (line === '*** End Patch') { inFile = false; kind = 'hunk'; }
      else if (inFile && /^@@(?: |$)/.test(line)) kind = 'hunk';
      else if (inFile && line.startsWith('+')) kind = 'added';
      else if (inFile && line.startsWith('-')) kind = 'removed';
    }
    pre.append(el('span', `action-details-line action-details-line-${kind}`, line + (index < lines.length - 1 ? '\n' : '')));
  }
  parent.append(pre);
}

function structuredResult(value: RecordValue | null): RecordValue | null {
  if (!value) return null;
  return Object.hasOwn(value, 'structuredContent') ? record(value.structuredContent) : value;
}

/** Only explicit text/output fields are readable output; binary/protocol objects stay raw. */
function commandOutput(parent: HTMLElement, call: ToolCallRecord, parsed: RecordValue | null,
  result: RecordValue | null, budget: Budget): void {
  if (typeof result?.output === 'string') {
    code(parent, 'Recorded output', result.output, budget);
    if (result.truncated === true) note(parent, 'The recorded command output is truncated.');
    return;
  }
  if (Array.isArray(parsed?.content)) {
    const blocks = parsed.content;
    if (blocks.length > ACTION_DETAILS_LIMITS.items) budget.clipped = true;
    for (const block of blocks.slice(0, ACTION_DETAILS_LIMITS.items)) {
      const item = record(block);
      const value = item?.type === 'text' ? item.text : item?.type === 'resource' ? record(item.resource)?.text : null;
      if (typeof value === 'string') code(parent, 'Recorded output', value, budget);
    }
    return;
  }
  // A truncated or malformed envelope can end inside an image. Do not turn that
  // prefix into output. Plain legacy process output remains useful as bounded text.
  const prefix = call.result.text.slice(0, ACTION_DETAILS_LIMITS.jsonChars);
  if (!parsed && !/^\s*[\[{]/.test(prefix)) code(parent, 'Recorded output', call.result.text, budget);
}

function commandDetails(parent: HTMLElement, metadata: HTMLElement, call: ToolCallRecord,
  args: RecordValue | null, parsed: RecordValue | null, budget: Budget): void {
  const result = structuredResult(parsed);
  field(metadata, 'Requested working directory', args?.workdir ?? t('Not recorded'), budget);
  fields(metadata, args, [['shell', 'Requested shell'], ['session_id', 'Requested process session']], budget);
  const process = call.process;
  const completed = typeof process?.completedAt === 'number' && Number.isFinite(process.completedAt) && process.completedAt > 0;
  const processExit = completed && integer(process?.exitCode) ? process.exitCode : null;
  // The later recorder revision supersedes the original launch response, including
  // an explicitly unknown final exit. Never infer an exit from text or summary tone.
  const exit = completed ? processExit : integer(result?.exit_code) ? result.exit_code : null;
  const session = process?.sessionId ?? result?.completed_session_id ?? result?.session_id;
  if (session !== undefined) field(metadata, 'Recorded process session', session, budget);
  field(metadata, 'Exit code', exit ?? t('Not recorded'), budget);
  if (completed || exit !== null || integer(result?.completed_session_id)) {
    field(metadata, 'Process status', t('Completion recorded'), budget);
  } else if (session !== undefined) {
    field(metadata, 'Process status', t('Started; completion not recorded'), budget);
  }
  const benign = completed ? process?.benignExit === true : result?.benign_exit === true;
  if (benign && exit !== null && exit !== 0) note(parent, 'The nonzero exit was recorded as expected.');
  if (result?.output_replayed === true) note(parent, 'This result replays retained output; it does not record another execution.');
  if (typeof args?.cmd === 'string') code(parent, 'Submitted command', args.cmd, budget);
  if (Array.isArray(args?.cmds)) {
    if (args.cmds.length > ACTION_DETAILS_LIMITS.items) budget.clipped = true;
    for (const command of args.cmds.slice(0, ACTION_DETAILS_LIMITS.items)) {
      if (typeof command === 'string') code(parent, 'Submitted command', command, budget);
    }
  }
  if (typeof args?.chars === 'string' && args.chars) code(parent, 'Submitted input', args.chars, budget);
  commandOutput(parent, call, parsed, result, budget);
}

function browserDetails(metadata: HTMLElement, args: RecordValue | null, parsed: RecordValue | null, budget: Budget): void {
  fields(metadata, args, [
    ['action', 'Requested action'], ['tabId', 'Requested tab'], ['pageId', 'Requested page'],
    ['frameId', 'Requested frame'], ['url', 'Requested URL'], ['ref', 'Requested element'],
    ['selector', 'Selector'], ['filter', 'Filter'], ['mode', 'Requested mode'], ['format', 'Requested format'],
    ['key', 'Requested key'], ['requestId', 'Requested network request']
  ], budget);
  const result = structuredResult(parsed);
  const observed = parsed && Object.hasOwn(parsed, 'structuredContent') ? record(result?.value) : result;
  fields(metadata, observed, [
    ['title', 'Recorded title'], ['url', 'Recorded URL'], ['tabId', 'Recorded tab'],
    ['pageId', 'Recorded page'], ['documentId', 'Recorded document'], ['frameId', 'Recorded frame'],
    ['inspectionOnly', 'Inspection only at observation'], ['created', 'Tab creation recorded'],
    ['attached', 'Attachment recorded'], ['accepted', 'Acceptance recorded'],
    ['status', 'Recorded status'], ['readyState', 'Readiness at observation'], ['truncated', 'Result truncated']
  ], budget);
  if (Array.isArray(observed?.tabs)) field(metadata, 'Tabs in recorded response', observed.tabs.length, budget);
  // Access hints, page markup, headers and arbitrary evaluation values are not
  // detail fields. In particular, a past observation never supplies action controls.
}

/**
 * Add inside chat.ts's existing lazy appendToolOutput, before its raw arguments/result.
 * This function only creates text nodes. The caller retains raw text, overflow references,
 * image handling, disclosure ownership and chronology unchanged.
 */
export function renderActionDetails(call: ToolCallRecord): HTMLElement | null {
  const tool = call.tool;
  if (!['apply_patch', 'exec_command', 'write_stdin', 'read', 'find'].includes(tool) && !browserTools.has(tool)) return null;
  const args = storedObject(call.args), parsed = storedObject(call.result);
  const budget: Budget = { chars: ACTION_DETAILS_LIMITS.textChars, lines: ACTION_DETAILS_LIMITS.lines, clipped: false };
  const parent = el('section', 'action-details');
  const outcome = normalizedToolOutcome(call);
  const applied = tool === 'apply_patch' && outcome === 'ok' && parsed?.isError !== true;
  const title = tool === 'apply_patch' ? applied ? 'Applied patch' : 'Proposed patch'
    : tool === 'read' ? 'Read details' : tool === 'find' ? 'Search details'
      : browserTools.has(tool) ? 'Browser details' : 'Command details';
  parent.append(el('h3', 'action-details-title', () => t(title)));
  const metadata = el('dl', 'action-details-fields');
  parent.append(metadata);
  field(metadata, 'Recorded outcome', outcome ?? t('Not recorded'), budget);
  if (!args) note(parent, 'Structured arguments are unavailable. Consult the original Arguments below.');
  if (incomplete(call.args)) note(parent, 'The recorded arguments are truncated.');
  if (incomplete(call.result)) note(parent, 'The recorded result is truncated.');
  if (call.args.text.length > ACTION_DETAILS_LIMITS.jsonChars || call.result.text.length > ACTION_DETAILS_LIMITS.jsonChars)
    note(parent, 'Structured details exceed the preview limit. The original raw details remain available.');

  if (tool === 'apply_patch') {
    if (!applied) note(parent, 'Patch application was not confirmed. These are the submitted changes.');
    if (typeof args?.patch === 'string') {
      const patch = args.patch;
      const framed = /^\*\*\* Begin Patch\r?\n/.test(patch) && /\r?\n\*\*\* End Patch\s*$/.test(patch);
      code(parent, 'Submitted patch', patch, budget, framed);
      if (!framed) note(parent, 'Patch format is unrecognized; the submitted text is shown without hunk highlighting.');
      if (/^\*\*\* Delete File:/m.test(patch)) note(parent, 'A delete directive does not include the original file contents.');
    }
  } else if (tool === 'exec_command' || tool === 'write_stdin') {
    commandDetails(parent, metadata, call, args, parsed, budget);
  } else if (tool === 'read') {
    listField(metadata, 'Requested path', args?.paths, budget);
    fields(metadata, args, [['path', 'Requested path'], ['start_line', 'Requested first line'],
      ['end_line', 'Requested last line'], ['max_bytes', 'Requested byte limit']], budget);
  } else if (tool === 'find') {
    fields(metadata, args, [['query', 'Query'], ['path', 'Requested search path'], ['mode', 'Requested search mode'],
      ['include', 'Include pattern'], ['case_sensitive', 'Case sensitive'], ['regex', 'Regular expression'],
      ['max_results', 'Requested result limit']], budget);
    listField(metadata, 'Excluded folder', args?.exclude, budget);
  } else browserDetails(metadata, args, parsed, budget);

  if (budget.clipped) note(parent, 'Action preview truncated. The original Arguments and Result below are unchanged.');
  return parent;
}
