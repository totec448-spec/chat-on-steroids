import { StringDecoder } from 'node:string_decoder';
import { redactSecretText } from './redaction.js';

/**
 * One person's read-only view of an agent's running command (#1920): the output so far, then new
 * output a few times a second, then how it ended. Text is decoded across chunk boundaries and, when
 * the shield is on, masked the way tool results are, line by line, so a secret split over two chunks
 * is still found. A line without its end yet is held back briefly, then shown as it is.
 */
export const AGENT_OUTPUT_FLUSH_MS = 250;
/** A partial line is shown after this long, or once it is this long, so a progress bar still moves. */
const PARTIAL_LINE_MS = 1_000;
const PARTIAL_LINE_BYTES = 4_096;

export class AgentOutputStream {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private partialSince: number | null = null;

  constructor(private readonly shield: boolean, private readonly emit: (text: string) => void) {}

  /** The output so far, shown at once. */
  start(history: Buffer): void {
    const text = this.decoder.write(history);
    if (text) this.emit(this.shield ? redactSecretText(text) : text);
  }

  push(chunk: Buffer): void { this.pending += this.decoder.write(chunk); }

  /** Called on a timer and at the end; `final` shows everything left. */
  flush(now = Date.now(), final = false): void {
    if (final) this.pending += this.decoder.end();
    if (!this.pending) { this.partialSince = null; return; }
    const lastBreak = this.pending.lastIndexOf('\n');
    let take = lastBreak + 1;
    const partial = this.pending.length - take;
    if (partial > 0) {
      this.partialSince ??= now;
      if (final || partial >= PARTIAL_LINE_BYTES || now - this.partialSince >= PARTIAL_LINE_MS) take = this.pending.length;
    }
    if (take === 0) return;
    const text = this.pending.slice(0, take);
    this.pending = this.pending.slice(take);
    if (!this.pending) this.partialSince = null;
    this.emit(this.shield ? redactSecretText(text) : text);
  }
}

/** "Exited with 1 after 4m 12s" — the words the tab ends with, in English; the window translates them. */
export function exitSummary(exitCode: number | null, durationMs: number): { exitCode: number | null; seconds: number } {
  return { exitCode, seconds: Math.max(0, Math.round(durationMs / 1000)) };
}
