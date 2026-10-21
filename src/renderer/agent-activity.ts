import type { ActivitySummary, SessionEvent, ToolCallRecord } from '../shared/session.js';
import { normalizedToolOutcome, toolCallSummary, workSequence } from '../shared/session.js';
import { clockTime, el, icon } from './dom.js';
import { t } from './i18n.js';

/** Sprite id per tool-call family. Deliberately reuses the existing icon set. */
export const KIND_ICON: Record<ActivitySummary['kind'], string> = {
  edit: 'i-pencil',
  create: 'i-plus',
  delete: 'i-trash',
  move: 'i-out',
  read: 'i-eye',
  search: 'i-search',
  browse: 'i-folder',
  run: 'i-terminal',
  process: 'i-terminal',
  screen: 'i-monitor',
  input: 'i-monitor',
  clipboard: 'i-copy',
  session: 'i-steps',
  agent: 'i-bolt',
  other: 'i-bolt'
};

export interface WorkerAction {
  callId: string;
  time: number;
  summary: ActivitySummary;
  failed: boolean;
}

export interface WorkerFile {
  path: string;
  added: number;
  removed: number;
  approximate: boolean;
  /** What the worker last did to it. */
  kind: 'edit' | 'create' | 'delete' | 'move';
}

/**
 * A worker's actions and the files it changed, from the part of its history the panel loaded (#105).
 * A call is recorded again as it completes (its process exits, its output arrives); the latest record
 * of each call counts, at the place the call first appeared. Internal code-mode calls are not actions.
 */
export function workerActivity(events: readonly SessionEvent[]): { actions: WorkerAction[]; files: WorkerFile[]; partial: boolean } {
  const latest = new Map<string, { call: ToolCallRecord; time: number; order: number }>();
  for (const event of events) {
    if (event.kind !== 'tool_call' || event.call.nested) continue;
    const seen = latest.get(event.call.callId);
    latest.set(event.call.callId, { call: event.call, time: seen?.time ?? event.time, order: seen?.order ?? workSequence(event) });
  }
  const calls = [...latest.values()].sort((a, b) => a.order - b.order);
  const actions = calls.map(({ call, time }) => {
    const outcome = normalizedToolOutcome(call);
    return { callId: call.callId, time, summary: toolCallSummary(call), failed: outcome !== null && outcome !== 'ok' };
  });
  const files = new Map<string, WorkerFile>();
  for (const { call } of calls) {
    if (normalizedToolOutcome(call) !== 'ok') continue;
    const kind = call.summary.kind === 'create' || call.summary.kind === 'delete' || call.summary.kind === 'move' ? call.summary.kind : 'edit';
    for (const change of call.changes ?? []) {
      const file = files.get(change.path);
      if (file) {
        file.added += change.added; file.removed += change.removed;
        file.approximate ||= change.approximate;
        // A file the worker created stays created however often it edits it after.
        file.kind = file.kind === 'create' && kind === 'edit' ? 'create' : kind;
      } else files.set(change.path, { path: change.path, added: change.added, removed: change.removed, approximate: change.approximate, kind });
    }
  }
  // The panel loads a window of the latest events; one without the session's start leaves earlier work out.
  const partial = events.length > 0 && !events.some(event => event.kind === 'session_start');
  return { actions, files: [...files.values()], partial };
}

const FILE_VERB: Record<WorkerFile['kind'], string> = { edit: 'Edited', create: 'Created', delete: 'Deleted', move: 'Moved' };

/** The Activity view of one worker: its task, what it did in order, and the files it changed. */
export function renderWorkerActivity(events: readonly SessionEvent[], task: string): HTMLElement[] {
  const { actions, files, partial } = workerActivity(events);
  const nodes: HTMLElement[] = [];
  const section = (heading: () => string, count?: number): HTMLElement => {
    const head = el('h3', 'agent-activity-heading');
    head.append(el('span', '', heading));
    if (count !== undefined) head.append(el('span', 'agent-activity-count', String(count)));
    return head;
  };
  nodes.push(section(() => t('Task')), el('p', 'agent-activity-task', task));
  nodes.push(section(() => t('Activity'), actions.length));
  if (!actions.length) nodes.push(el('p', 'meta agent-activity-empty', () => t('No actions yet')));
  else {
    const list = el('ol', 'agent-activity-list');
    if (partial) list.append(el('li', 'agent-activity-earlier', () => t('Earlier actions are in the conversation.')));
    for (const action of actions) {
      const row = el('li', 'agent-activity-row');
      row.dataset.kind = action.summary.kind; row.dataset.tone = action.failed ? 'bad' : action.summary.tone;
      const time = el('time', 'agent-activity-time', clockTime(action.time));
      time.setAttribute('datetime', new Date(action.time).toISOString());
      const what = el('span', 'agent-activity-title', action.summary.title);
      if (action.summary.detail) what.append(el('em', '', action.summary.detail));
      row.append(time, icon(KIND_ICON[action.summary.kind] ?? 'i-bolt', 'ico agent-activity-icon'), what);
      if (action.summary.metric) row.append(el('span', 'agent-activity-metric', action.summary.metric));
      row.title = [action.summary.title, action.summary.detail, action.summary.metric].filter(Boolean).join(' · ');
      list.append(row);
    }
    nodes.push(list);
  }
  if (files.length) {
    nodes.push(section(() => t('Files changed'), files.length));
    const list = el('ul', 'agent-activity-files');
    for (const file of files) {
      const row = el('li', 'agent-activity-file');
      row.dataset.kind = file.kind;
      const name = file.path.split(/[\\/]/).pop() || file.path;
      const label = el('span', 'agent-activity-file-name', name);
      const folder = file.path.slice(0, file.path.length - name.length).replace(/[\\/]$/, '');
      if (folder) label.append(el('em', '', folder));
      const counts = el('span', 'agent-activity-file-counts');
      if (file.kind === 'delete') counts.append(el('span', 'is-removed', () => t('Deleted')));
      else {
        if (file.added) counts.append(el('span', 'is-added', `+${file.added}`));
        if (file.removed) counts.append(el('span', 'is-removed', `−${file.removed}`));
        if (file.approximate) counts.append(el('span', '', () => t(' (approx.)')));
      }
      row.append(icon(KIND_ICON[file.kind], 'ico agent-activity-icon'), label, counts);
      row.title = `${t(FILE_VERB[file.kind])} ${file.path}`;
      list.append(row);
    }
    nodes.push(list);
  }
  return nodes;
}
