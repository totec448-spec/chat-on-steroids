/**
 * Tool rows in the person's language (2.1.47 release round). The app records a call's title, detail
 * and metric in English (main/session/summarize.ts, and the process completion in session/store.ts),
 * saved chats included. They are worded from a fixed set of phrases, so each is translated where it is
 * shown, old recordings too. What is not one of those phrases (a file path, a command, a query, an
 * error) stays exactly as it was recorded.
 */
import type { AgeUnit } from '../shared/age.js';
import { compactAgeText } from './dom.js';
import { currentLanguage, t, tn } from './i18n.js';

/**
 * Every phrase summarize.ts words a call with: done, while it runs, and its infinitive for a call that
 * did not happen ("Could not read …", "Refused to read …"). Null where summarize.ts has no such form:
 * a running call then reads "Running <tool>", a failed one "Failed: <title>".
 */
const PHRASES: ReadonlyArray<readonly [done: string, running: string | null, infinitive: string | null]> = [
  ['Read {0}', 'Reading {0}', 'read {0}'],
  ['Searched {0}', 'Searching {0}', 'search {0}'],
  ['Applied a patch', 'Applying a patch', 'apply a patch'],
  ['Created {0}', 'Creating {0}', 'create {0}'],
  ['Deleted {0}', 'Deleting {0}', 'delete {0}'],
  ['Moved {0}', 'Moving {0}', 'move {0}'],
  ['Edited {0}', 'Editing {0}', 'edit {0}'],
  ['Ran {0}', 'Running {0}', 'run {0}'],
  ['Started {0}', 'Starting {0}', 'start {0}'],
  ['Completed {0}', null, null],
  ['Command failed {0}', null, null],
  ['Stopped session {0}', 'Stopping session {0}', 'stop session {0}'],
  ['Interrupted session {0}', 'Interrupting session {0}', 'interrupt session {0}'],
  ['Wrote to session {0}', 'Writing to session {0}', 'write to session {0}'],
  ['Waited on session {0}', 'Waiting on session {0}', 'wait on session {0}'],
  ['Waited for {0}', 'Waiting for {0}', 'wait for {0}'],
  ['Listed open windows', 'Listing open windows', 'list open windows'],
  ['Looked for {0}', 'Looking for {0}', 'look for {0}'],
  ['Looked at the screen', 'Looking at the screen', 'look at the screen'],
  ['Inspected a window', 'Inspecting a window', 'inspect a window'],
  ['Listed installed apps', 'Listing installed apps', 'list installed apps'],
  ['Inspected window state', 'Inspecting window state', 'inspect window state'],
  ['Requested an app launch', 'Requesting an app launch', 'request an app launch'],
  ['Clicked in a window', 'Clicking in a window', 'click in a window'],
  ['Pressed keys in a window', 'Pressing keys in a window', 'press keys in a window'],
  ['Typed in a window', 'Typing in a window', 'type in a window'],
  ['Scrolled in a window', 'Scrolling in a window', 'scroll in a window'],
  ['Replaced a field value', 'Replacing a field value', 'replace a field value'],
  ['Dragged in a window', 'Dragging in a window', 'drag in a window'],
  ['Acted on a window control', 'Acting on a window control', 'act on a window control'],
  ['Focused a window', 'Focusing a window', 'focus a window'],
  ['Read the clipboard', 'Reading the clipboard', 'read the clipboard'],
  ['Replaced the clipboard text', 'Replacing the clipboard text', 'replace the clipboard text'],
  ['Clicked', 'Clicking', 'click'],
  ['Filled in a field', 'Filling in a field', 'fill in a field'],
  ['Double-clicked', 'Double-clicking', 'double-click'],
  ['Moved the pointer', 'Moving the pointer', 'move the pointer'],
  ['Dragged', 'Dragging', 'drag'],
  ['Scrolled', 'Scrolling', 'scroll'],
  ['Typed', 'Typing', 'type'],
  ['Pressed keys', 'Pressing keys', 'press keys'],
  ['Waited', 'Waiting', 'wait'],
  ['Acted on the desktop', 'Acting on the desktop', 'act on the desktop'],
  ['Acted', 'Acting', 'act'],
  ['Updated the task plan', 'Updating the task plan', null],
  ['Cleared the task plan', 'Clearing the task plan', null],
  ['Searched recordings {0}', 'Searching recordings {0}', 'search recordings {0}'],
  ['Listed recent recordings', 'Listing recent recordings', 'list recent recordings'],
  ['Opened one recorded tool call', 'Opening one recorded tool call', 'open one recorded tool call'],
  ['Continued reading a recorded session', null, null],
  ['Read a recorded session', 'Reading a recorded session', 'read a recorded session'],
  ['Messaged {0}', 'Messaging {0}', 'message {0}'],
  ['Messaged the prime agent', 'Messaging the prime agent', 'message the prime agent'],
  ['Reported the finished task', 'Reporting the finished task', 'report the finished task'],
  ['Checked agent status', 'Checking agent status', 'check agent status']
];

/** Every title template, as the catalogs key it. */
export const TOOL_TITLE_TEMPLATES: readonly string[] = [
  ...PHRASES.flatMap(([done, running, infinitive]) => [done, running,
    infinitive && `Could not ${infinitive}`, infinitive && `Refused to ${infinitive}`]).filter((form): form is string => !!form),
  'Failed: {0}', 'Refused: {0}', 'Tool {0} failed', 'Patch didn’t match'
];

/** The words of details and metrics that are not counts. */
export const TOOL_DETAIL_WORDS: readonly string[] = ['in file contents', 'by name', 'started', '✓ finished', 'refused', '✕ failed',
  'not applied', '✕ timed out', 'finished (exit unknown)', 'lines {0}–{1}', 'from line {0}', '{0} +{1} more', '{0} / {1} completed',
  '✕ exit {0}', '{0}ms', 'a command'];

const FIXED = new Set(TOOL_TITLE_TEMPLATES.filter(template => !template.includes('{0}')));
/** Searches name their query in quotes; a title that does not is not this phrase ("Searched for x"). */
const QUOTED = new Set(PHRASES.filter(([done]) => ['Searched {0}', 'Looked for {0}', 'Searched recordings {0}'].includes(done))
  .flatMap(([done, running, infinitive]) => [done, running, `Could not ${infinitive}`, `Refused to ${infinitive}`]));
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// With a subject: the longest fixed start first, so "Searched recordings …" is not read as "Searched …".
const OPEN = TOOL_TITLE_TEMPLATES.filter(template => template.includes('{0}'))
  .sort((a, b) => b.indexOf('{0}') - a.indexOf('{0}'))
  .map(template => [template, new RegExp(`^${escape(template).replace('\\{0\\}', '(.+)')}$`, 's')] as const);

/** A title's subject: counts and the app's own words translated, a path, command or query as it is. */
function subject(text: string): string {
  const count = /^(\d+) (paths?|files?|worker agents?|agents?)$/.exec(text);
  if (count) {
    const n = Number(count[1]);
    const noun = count[2]!.replace(/s$/, '');
    if (noun === 'path') return tn('{0} path', '{0} paths', n);
    if (noun === 'file') return tn('{0} file', '{0} files', n);
    if (noun === 'worker agent') return tn('{0} worker agent', '{0} worker agents', n);
    return tn('{0} agent', '{0} agents', n);
  }
  const commands = /^(\d+) commands: (.+)$/s.exec(text);
  if (commands) return tn('{0} command: {1}', '{0} commands: {1}', Number(commands[1]), [commands[1], commands[2]]);
  if (text === 'a command') return t(text);
  return text;
}

/** A recorded tool title in the person's language; anything else unchanged. */
export function localToolTitle(title: string): string {
  if (FIXED.has(title)) return t(title);
  // A desktop call of several kinds: "Clicked and 2 more", also "Could not click and 2 more".
  const more = /^(.+) and (\d+) more$/.exec(title);
  if (more && FIXED.has(more[1]!)) return tn('{0} and {1} more', '{0} and {1} more', Number(more[2]), [t(more[1]!), more[2]]);
  const wrapped = /^(Failed|Refused): (.+)$/s.exec(title);
  if (wrapped) return t(`${wrapped[1]}: {0}`, [localToolTitle(wrapped[2]!)]);
  const tool = /^Tool (.+) failed$/s.exec(title);
  if (tool) return t('Tool {0} failed', [tool[1]]);
  for (const [template, pattern] of OPEN) {
    const match = pattern.exec(title);
    if (match && (!QUOTED.has(template) || /^".*"$/s.test(match[1]!))) return t(template, [subject(match[1]!)]);
  }
  return title;
}

/** A recorded tool detail ("3 matches in file contents", "lines 1–40") in the person's language. */
export function localToolDetail(detail: string): string {
  let match: RegExpExecArray | null;
  if (detail === 'in file contents' || detail === 'by name') return t(detail);
  if ((match = /^lines (\d+)–(\d+)$/.exec(detail))) return t('lines {0}–{1}', [match[1], match[2]]);
  if ((match = /^from line (\d+)$/.exec(detail))) return t('from line {0}', [match[1]]);
  if ((match = /^(\d+) \/ (\d+) completed$/.exec(detail))) return t('{0} / {1} completed', [match[1], match[2]]);
  if ((match = /^(\d+) (match|matches)( in file contents)?$/.exec(detail))) {
    const n = Number(match[1]);
    return match[3] ? tn('{0} match in file contents', '{0} matches in file contents', n) : tn('{0} match', '{0} matches', n);
  }
  if ((match = /^(\d+) (windows?|controls?|actions?|sessions?|entry|entries|messages?)$/.exec(detail))) {
    const n = Number(match[1]);
    switch (match[2]!.replace(/s$/, '').replace(/^entrie$/, 'entry')) {
      case 'window': return tn('{0} window', '{0} windows', n);
      case 'control': return tn('{0} control', '{0} controls', n);
      case 'action': return tn('{0} action', '{0} actions', n);
      case 'session': return tn('{0} session', '{0} sessions', n);
      case 'entry': return tn('{0} entry', '{0} entries', n);
      default: return tn('{0} message', '{0} messages', n);
    }
  }
  // Several paths read at once: "a.ts, b.ts +3 more"; the paths stay as they are.
  if ((match = /^(.+) \+(\d+) more$/s.exec(detail))) return t('{0} +{1} more', [match[1], match[2]]);
  return detail;
}

const DURATION_UNITS: Readonly<Record<string, AgeUnit>> = { s: 'second', m: 'minute', h: 'hour', d: 'day' };

/** "120ms", "2.1s", "4m 5s" as summarize.ts writes a command's time, in the person's units. */
function localDuration(text: string): string | null {
  let match: RegExpExecArray | null;
  if ((match = /^(\d+)ms$/.exec(text))) return t('{0}ms', [match[1]]);
  if ((match = /^(\d+\.\d)s$/.exec(text))) {
    return t('{0}s', [new Intl.NumberFormat(currentLanguage(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Number(match[1]))]);
  }
  const parts = text.split(' ').map(part => /^(\d+)([smhd])$/.exec(part));
  if (!parts.length || parts.length > 2 || parts.some(part => !part)) return null;
  return parts.map(part => compactAgeText(Number(part![1]), DURATION_UNITS[part![2]!]!)).join(' ');
}

/** A recorded tool metric ("✓ 2.1s", "✕ exit 1", "3 lines") in the person's language; a line delta as it is. */
export function localToolMetric(metric: string): string {
  let match: RegExpExecArray | null;
  if (TOOL_DETAIL_WORDS.includes(metric) && !metric.includes('{')) return t(metric);
  if ((match = /^(\d+) lines?$/.exec(metric))) return tn('{0} line', '{0} lines', Number(match[1]));
  if ((match = /^✕ exit (-?\d+)$/.exec(metric))) return t('✕ exit {0}', [match[1]]);
  if ((match = /^✓ (.+)$/.exec(metric))) {
    const took = localDuration(match[1]!);
    if (took !== null) return `✓ ${took}`;
  }
  return metric;
}
