import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  windows: [] as any[],
  deferLoad: false,
  resolveLoad: null as null | (() => void)
}));

vi.mock('electron', () => {
  class Emitter {
    private handlers = new Map<string, Array<{ fn: (...args: any[]) => void; once: boolean }>>();
    on(name: string, fn: (...args: any[]) => void) {
      const rows = this.handlers.get(name) ?? [];
      rows.push({ fn, once: false });
      this.handlers.set(name, rows);
      return this;
    }
    once(name: string, fn: (...args: any[]) => void) {
      const rows = this.handlers.get(name) ?? [];
      rows.push({ fn, once: true });
      this.handlers.set(name, rows);
      return this;
    }
    emit(name: string, ...args: any[]) {
      const rows = this.handlers.get(name) ?? [];
      this.handlers.set(name, rows.filter(row => !row.once));
      for (const row of rows) row.fn(...args);
    }
  }

  class Window extends Emitter {
    options: Record<string, unknown>;
    webContents = new Emitter();
    destroyed = false;
    shown = 0;
    url = '';
    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
      fake.windows.push(this);
    }
    loadURL(url: string): Promise<void> {
      this.url = url;
      if (!fake.deferLoad) return Promise.resolve();
      return new Promise(resolve => { fake.resolveLoad = resolve; });
    }
    showInactive() { this.shown += 1; }
    isDestroyed() { return this.destroyed; }
    close() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
    }
    destroy() { this.close(); }
  }

  return {
    BrowserWindow: Window,
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    }
  };
});

vi.mock('../src/main/main-texts.js', () => ({
  mainText: (value: string) => value,
  formatMainText: (value: string, args: readonly unknown[]) =>
    value.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)]))
}));

import { createDesktopControlGuardPresenter } from '../src/main/desktop-control-notice.js';

const request = {
  ownerKey: 'agent:worker-2',
  label: 'Worker 2',
  operation: 'click',
  description: 'Clicked in a window',
  countdownMs: 1_000
};

beforeEach(() => {
  fake.windows.length = 0;
  fake.deferLoad = false;
  fake.resolveLoad = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('desktop control notice', () => {
  it('shows an inactive topmost notice with bounded local content', async () => {
    const presenter = createDesktopControlGuardPresenter(() => false);
    void presenter.prompt(request);
    await Promise.resolve();
    await Promise.resolve();

    const notice = fake.windows[0]!;
    expect(notice.options).toMatchObject({
      x: 1484,
      y: 854,
      width: 420,
      height: 210,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    expect(notice.shown).toBe(1);
    const html = decodeURIComponent(notice.url.slice(notice.url.indexOf(',') + 1));
    expect(html).toContain('Worker 2 is about to control your desktop.');
    expect(html).toContain('Clicked in a window');
    expect(html).toContain('Start now');
    expect(html).toContain('Stop');
  });

  it('starts the automatic allow countdown only after the notice has loaded', async () => {
    vi.useFakeTimers();
    fake.deferLoad = true;
    const presenter = createDesktopControlGuardPresenter(() => false);
    let result: string | undefined;
    void presenter.prompt(request).then(value => { result = value; });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(result).toBeUndefined();
    expect(fake.windows[0]!.shown).toBe(0);

    fake.resolveLoad!();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.windows[0]!.shown).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe('allow');
  });

  it('resolves Start now and Stop without waiting for the timer', async () => {
    vi.useFakeTimers();
    const presenter = createDesktopControlGuardPresenter(() => false);

    const allow = presenter.prompt(request);
    await Promise.resolve();
    await Promise.resolve();
    const allowEvent = { preventDefault: vi.fn() };
    fake.windows[0]!.webContents.emit('will-navigate', allowEvent, 'cos-desktop-guard://allow');
    await expect(allow).resolves.toBe('allow');
    expect(allowEvent.preventDefault).toHaveBeenCalled();

    const stop = presenter.prompt(request);
    await Promise.resolve();
    await Promise.resolve();
    const stopEvent = { preventDefault: vi.fn() };
    fake.windows[1]!.webContents.emit('will-navigate', stopEvent, 'cos-desktop-guard://stop');
    await expect(stop).resolves.toBe('stop');
    expect(stopEvent.preventDefault).toHaveBeenCalled();
  });

  it('keeps a stopped caller blocked until Allow again is pressed', async () => {
    const presenter = createDesktopControlGuardPresenter(() => false);
    const allowAgain = vi.fn();
    presenter.blocked!(request, allowAgain);
    await Promise.resolve();
    await Promise.resolve();

    const notice = fake.windows[0]!;
    const html = decodeURIComponent(notice.url.slice(notice.url.indexOf(',') + 1));
    expect(html).toContain('Worker 2 cannot send desktop input until you allow it again.');
    expect(html).toContain('Allow again');
    const event = { preventDefault: vi.fn() };
    notice.webContents.emit('will-navigate', event, 'cos-desktop-guard://allow-again');
    expect(allowAgain).toHaveBeenCalledTimes(1);
    expect(notice.destroyed).toBe(true);
  });

  it('fails closed when the user-visible notice closes before a decision', async () => {
    const presenter = createDesktopControlGuardPresenter(() => false);
    const pending = presenter.prompt(request);
    fake.windows[0]!.close();
    await expect(pending).rejects.toThrow('closed before a decision');
  });
});
