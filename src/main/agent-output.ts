import { StringDecoder } from 'node:string_decoder';
import { redactSecretText } from './redaction.js';

/**
 * One person's read-only view of an agent's running command (#1920): the output so far, then new
 * output a few times a second, then how it ended. Text is decoded across chunk boundaries and, when
 * the shield is on, masked with the shapes tool results use. Masking a stream is harder than masking
 * a result (Haz on #2052): a piece shown early must never split a secret into parts that each pass.
 * So whole lines go out as they end; a line without its end goes out only up to a safe cut, which
 * holds back its newest words and never falls inside anything the masking would change; a private
 * key's lines stay hidden until its END line, however many flushes they arrive over; and the lines
 * cut by the gap of a long command's kept output are dropped.
 */
export const AGENT_OUTPUT_FLUSH_MS = 250;
/** A partial line is shown after this long, or once it is this long, so a progress bar still moves. */
const PARTIAL_LINE_MS = 1_000;
const PARTIAL_LINE_BYTES = 4_096;
/** Words of a partial line held back: room for a header, its scheme and a token still being written. */
const HELD_WORDS = 8;
/** A line without spaces is held up to this long; past it, all but its newest part is shown. */
const HELD_RUN_MAX = 65_536;
const HELD_RUN_KEEP = 4_096;
const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----[^\n]*\n?/;
/** The line between the kept head and tail of a long command's output (formatOutputOmissionMarker). */
const OMISSION = /^\.\.\. \d+ bytes omitted \.\.\.$/m;
/**
 * A credential header still waiting for its value at the end of what would be shown. The masking
 * shapes let the value follow on the next line, so the header is held until it does, or until the
 * command ends (CodeRabbit on #2052).
 */
const DANGLING_HEADER = /(?:\bAuthorization:\s*(?:(?:Basic|Bearer|Token)\s*)?|\bBearer\s*)$/i;
/** A line of a private key's body: what is left of a key whose BEGIN line was omitted. */
const KEY_BODY_LINE = /^[A-Za-z0-9+/=]{40,}$/;
const KEY_MASK = '[redacted private key]';

export class AgentOutputStream {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private partialSince: number | null = null;
  private inKey = false;
  private keyOpenAfterStart = false;

  /**
   * `note` hears each deliberate hiding once, when it starts, in fixed words without the text
   * (CodeRabbit on #2052): the IPC writes it to the log.
   */
  constructor(private readonly shield: boolean, private readonly emit: (text: string) => void,
    private readonly note: (reason: string) => void = () => undefined) {}

  /** The output so far, shown at once: whole lines, and the line still being written up to a safe cut. */
  start(history: Buffer): void {
    let text = this.decoder.write(history);
    const gap = this.shield ? OMISSION.exec(text) : null;
    if (gap) {
      // The head was cut at a byte count and the tail starts at one: the line on each side of the gap is a piece.
      const before = text.slice(0, gap.index), after = text.slice(gap.index + gap[0].length);
      const headEnd = before.replace(/\n$/, '').lastIndexOf('\n') + 1;
      const tailStart = after.replace(/^\n/, '').indexOf('\n');
      const tail = tailStart < 0 ? '' : after.replace(/^\n/, '').slice(tailStart + 1);
      text = `${before.slice(0, headEnd)}${gap[0]}\n${this.keyCutByGap(tail)}`;
    }
    this.pending += text;
    this.flush(Date.now(), false, true);
    if (this.keyOpenAfterStart) { this.keyOpenAfterStart = false; this.inKey = true; }
  }

  /**
   * The kept tail of a long command's output, when the gap may have swallowed a private key's BEGIN
   * line (CodeRabbit on #2052): key lines before any BEGIN in the tail are hidden through their END,
   * and when no END is there yet, until it arrives. Fails closed: the masking alone would not know.
   */
  private keyCutByGap(tail: string): string {
    const begin = tail.search(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    const before = begin < 0 ? tail : tail.slice(0, begin);
    const end = KEY_END.exec(before);
    if (end) {
      this.note('a private key\'s lines were kept after the omitted part; hidden');
      return `${KEY_MASK}\n${tail.slice(end.index + end[0].length)}`;
    }
    const first = before.split('\n').find(line => line.trim() !== '');
    if (first === undefined || !KEY_BODY_LINE.test(first.trim())) return tail;
    // Still being printed (no BEGIN in the tail, so nothing else is kept): what follows stays hidden
    // until its END line passes, from right after the output so far is shown.
    this.keyOpenAfterStart = true;
    this.note('a private key\'s lines were kept after the omitted part; hidden until its END line');
    return `${KEY_MASK}\n`;
  }

  push(chunk: Buffer): void { this.pending += this.decoder.write(chunk); }

  /** Called on a timer and at the end; `final` shows everything left. */
  flush(now = Date.now(), final = false, partialDue = false): void {
    if (final) this.pending += this.decoder.end();
    if (!this.pending) { this.partialSince = null; return; }
    const lastBreak = this.pending.lastIndexOf('\n');
    let take = lastBreak + 1;
    const partial = this.pending.length - take;
    if (partial > 0) {
      this.partialSince ??= now;
      if (final) take = this.pending.length;
      else if (partialDue || partial >= PARTIAL_LINE_BYTES || now - this.partialSince >= PARTIAL_LINE_MS) {
        take = this.shield ? this.safeCut(take) : this.pending.length;
      }
    }
    // A credential header at the end waits for its value, which may start the next line.
    if (!final && this.shield && take > 0) {
      const dangling = DANGLING_HEADER.exec(this.pending.slice(0, take));
      if (dangling) take = this.pending.lastIndexOf('\n', dangling.index - 1) + 1;
    }
    if (take === 0) return;
    const text = this.pending.slice(0, take);
    this.pending = this.pending.slice(take);
    if (!this.pending) this.partialSince = null;
    this.show(text);
  }

  /** Where a line without its end can be cut now: never inside its newest words or a match. */
  private safeCut(lineStart: number): number {
    const text = this.pending;
    const cuts: number[] = [];
    for (const space of text.slice(lineStart).matchAll(/\s+/g)) cuts.push(lineStart + space.index + space[0].length);
    const candidates = cuts.slice(0, Math.max(0, cuts.length - HELD_WORDS + 1)).reverse();
    // One long run without spaces: shown once it is very long, its newest part held as overlap.
    if (!candidates.length && text.length - lineStart > HELD_RUN_MAX) {
      for (let cut = text.length - HELD_RUN_KEEP; cut > lineStart; cut -= HELD_RUN_KEEP) candidates.push(cut);
    }
    const whole = redactSecretText(text);
    // A cut is safe when masking the shown part alone gives what masking everything gives for it.
    for (const cut of candidates) {
      const shown = text.slice(0, cut);
      if (!DANGLING_HEADER.test(shown) && whole.startsWith(redactSecretText(shown))) return cut;
    }
    return lineStart;
  }

  private show(text: string): void {
    if (!this.shield) { this.emit(text); return; }
    let rest = text;
    if (this.inKey) {
      // Inside a private key shown as "[redacted private key]": nothing until its END line has passed.
      const end = KEY_END.exec(rest);
      if (!end) return;
      rest = rest.slice(end.index + end[0].length);
      this.inKey = false;
    }
    const begins = [...rest.matchAll(KEY_BEGIN)];
    const lastBegin = begins.at(-1);
    if (lastBegin && !KEY_END.test(rest.slice(lastBegin.index + lastBegin[0].length))) {
      this.inKey = true;
      this.note('a private key is being printed; hidden until its END line');
    }
    const out = redactSecretText(rest);
    if (out) this.emit(out);
  }
}

/** "Exited with 1 after 4m 12s" — the words the tab ends with, in English; the window translates them. */
export function exitSummary(exitCode: number | null, durationMs: number): { exitCode: number | null; seconds: number } {
  return { exitCode, seconds: Math.max(0, Math.round(durationMs / 1000)) };
}
