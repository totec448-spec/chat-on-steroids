import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

const { resizeWindow } = createRequire(import.meta.url)('../scripts/ui-check-window.cjs') as {
  resizeWindow: (win: FakeWindow, width: number, height: number, options?: { content?: boolean; timeoutMs?: number; pollMs?: number }) => Promise<{ width: number; height: number }>;
};

// A BrowserWindow stand-in. `settle` is how many reads of the size pass before a request takes effect;
// a tiling window manager (issues #2233, #2234) resizes late, or never.
class FakeWindow {
  size: [number, number] = [1100, 900];
  private pending: [number, number] | null = null;
  private reads = 0;
  constructor(private settle: number | null) {}
  private request(width: number, height: number) { this.pending = [width, height]; this.reads = 0; }
  setSize(width: number, height: number) { this.request(width, height); }
  setContentSize(width: number, height: number) { this.request(width, height); }
  private read(): [number, number] {
    if (this.pending && this.settle !== null && ++this.reads > this.settle) { this.size = this.pending; this.pending = null; }
    return this.size;
  }
  getSize() { return this.read(); }
  getContentSize() { return this.read(); }
}

it('waits until a window manager that resizes late has applied the size, then returns it', async () => {
  const win = new FakeWindow(4);
  expect(await resizeWindow(win, 820, 656, { pollMs: 1, timeoutMs: 500 })).toEqual({ width: 820, height: 656 });
});

it('measures the content area when asked, since a hidden window can differ from its frame', async () => {
  const win = new FakeWindow(0);
  expect(await resizeWindow(win, 760, 900, { content: true, pollMs: 1, timeoutMs: 500 })).toEqual({ width: 760, height: 900 });
});

it('fails with the window manager as the reason when the width never arrives, not on a layout assertion', async () => {
  const win = new FakeWindow(null);
  await expect(resizeWindow(win, 820, 656, { pollMs: 1, timeoutMs: 30 })).rejects.toThrow(/did not resize.*820.*1100/s);
});

// macOS clamps a window taller than its work area; the layout checks that ask for a tall window accept that.
it('accepts a window that is shorter than asked when the width is right', async () => {
  const win = new FakeWindow(0);
  win.setSize = (width: number) => { (win as unknown as { size: [number, number] }).size = [width, 700]; };
  expect(await resizeWindow(win, 830, 900, { pollMs: 1, timeoutMs: 30 })).toEqual({ width: 830, height: 700 });
});

// CodeRabbit on #2314: a window taller than asked is not a work-area clamp, so a layout check must not pass on it.
it('rejects a window that is taller than asked, even with the right width', async () => {
  const win = new FakeWindow(0);
  win.setSize = (width: number) => { (win as unknown as { size: [number, number] }).size = [width, 800]; };
  await expect(resizeWindow(win, 830, 700, { pollMs: 1, timeoutMs: 30 })).rejects.toThrow(/did not resize.*830x700.*830x800/s);
});
