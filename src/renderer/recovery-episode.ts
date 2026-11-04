import type { SessionEvent } from '../shared/session.js';

/**
 * One recovery episode (#1883): what went wrong in this chat and what the app tried since it last
 * worked normally. A run of ChatGPT errors, reloads, automatic Continues and notes used to show as
 * one row at a time, or none once nothing was scheduled; the person could not tell a chat still
 * being recovered from one that had stopped (2026-11-01: a chat sat two days after about twenty of
 * them). The episode starts after the last completed turn or the person's own message.
 */
export interface EpisodeItem {
  time: number;
  kind: 'error' | 'reload' | 'continue' | 'turn' | 'note';
  /** Recorded text, or a key for the renderer to translate ('continue', 'fresh-turn', 'turn-failed'). */
  text: string;
}
export interface RecoveryEpisode {
  since: number;
  items: EpisodeItem[];
  /** Reloads and automatic Continues the app made. */
  tries: number;
  /** The app's own last word is that it stopped; nothing is scheduled to go on by itself. */
  stopped: boolean;
  /** Nothing healthy has happened since the newest item: the chat is still where the episode left it. */
  current: boolean;
}

/** App notes that say the app stopped trying, as main writes them (English, recorded once). */
const STOPPED_NOTES = ['This chat stopped', 'Stopped trying to recover', 'The browser did not pick up this chat', 'Goal paused',
  'Compact & Resume is still waiting'];
export const isStoppedNote = (text: string): boolean => STOPPED_NOTES.some(prefix => text.startsWith(prefix));
/** The app's fresh-turn message (#1402), which is routine, not recovery. */
const FRESH_TURN = 'Continue the task from where you are.';
const EPISODE_LIMIT = 50;

export function recoveryEpisode(events: readonly SessionEvent[]): RecoveryEpisode | null {
  let items: EpisodeItem[] = [];
  const reloads = new Map<string, EpisodeItem>();
  // When the chat last did something healthy; the episode is current while nothing healthy came after
  // its newest step. Times, not positions: a folded reload keeps its first place but its last time.
  let healthyAt = -Infinity;
  const reset = (): void => { items = []; reloads.clear(); healthyAt = -Infinity; };
  for (const event of events) {
    if (event.kind === 'turn_end' && event.outcome === 'completed') { reset(); continue; }
    if (event.kind === 'user_message' && !event.automatic && event.source !== 'app') { reset(); continue; }
    // A tool call, an answer or a new turn: the chat moved on.
    if (event.kind === 'tool_call' || event.kind === 'turn_start' || (event.kind === 'assistant_message' && event.source === 'extension')) {
      if (items.length) healthyAt = Math.max(healthyAt, event.time);
      continue;
    }
    let item: EpisodeItem | null = null;
    if (event.kind === 'chat_error' && event.source === 'extension') {
      item = { time: event.time, kind: 'error', text: event.message.text };
    } else if (event.kind === 'progress' && event.source === 'app' && event.progressId?.startsWith('browser-repair:')) {
      // One reload is one row: its "Trying…" line is replaced by how it ended.
      const known = reloads.get(event.progressId);
      // Moved to where it ended, so the list stays in time order and its newest step is the newest (CodeRabbit on #2062).
      if (known) {
        known.text = event.message.text; known.time = event.updatedAt ?? event.time;
        continue;
      }
      // Already folded (the window keeps one row per reload): its newest update says when it ended.
      item = { time: event.updatedAt ?? event.time, kind: 'reload', text: event.message.text };
      reloads.set(event.progressId, item);
    } else if (event.kind === 'user_message' && event.automatic) {
      // A fresh turn mid-work is routine; it belongs to an episode only once one has started.
      const fresh = event.message.text.startsWith(FRESH_TURN);
      if (fresh && !items.length) continue;
      item = { time: event.time, kind: 'continue', text: fresh ? 'fresh-turn' : 'continue' };
    } else if (event.kind === 'turn_end' && event.outcome === 'failed') {
      item = { time: event.time, kind: 'turn', text: 'turn-failed' };
    } else if (event.kind === 'note' && event.source === 'app' && !event.continuation) {
      item = { time: event.time, kind: 'note', text: event.message.text };
    }
    if (!item) continue;
    items.push(item);
  }
  if (!items.length) return null;
  // In time order, so the newest step is the newest and a reload sits where it ended; only then the
  // newest 50 are kept, so a reload that ended late is never the one dropped (CodeRabbit on #2062).
  items.sort((a, b) => a.time - b.time);
  if (items.length > EPISODE_LIMIT) items = items.slice(-EPISODE_LIMIT);
  const last = items.at(-1)!;
  return {
    since: items[0]!.time,
    items,
    tries: items.filter(item => item.kind === 'reload' || (item.kind === 'continue' && item.text === 'continue')).length,
    stopped: last.kind === 'note' && isStoppedNote(last.text),
    current: !(healthyAt > items.at(-1)!.time)
  };
}
