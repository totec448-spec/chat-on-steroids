import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { expect, it, vi } from 'vitest';
import { trackPetFocus, type PetNativeFocus } from '../src/main/pet-window-focus.js';

function fixture() {
  let foreground = 11;
  let alive = true;
  let visible = true;
  const handles = new Map([[11, { process: 101, thread: 201 }], [22, { process: 102, thread: 202 }]]);
  let notify = (_handle: number): void => undefined;
  const stop = vi.fn();
  const handle = Buffer.alloc(8); handle.writeBigUInt64LE(99n);
  const win = Object.assign(new EventEmitter(), {
    getNativeWindowHandle: () => handle,
    isDestroyed: () => !alive,
    isVisible: () => visible,
    webContents: new EventEmitter()
  });
  const native: PetNativeFocus = {
    foreground: () => foreground,
    identify: id => handles.get(id) ?? null,
    activate: vi.fn(id => { foreground = id; }),
    observe: callback => { notify = callback; return stop; }
  };
  const { release, dispose } = trackPetFocus(win as unknown as BrowserWindow, native);
  return { win, native, handles, release, dispose, stop,
    hide: () => { visible = false; },
    foreground: (id: number) => { foreground = id; },
    destroy: () => { alive = false; },
    notify: (id: number) => { notify(id); },
    press: () => { foreground = 99; notify(99); }
  };
}

it('captures the external foreground before activation and returns it once on release', () => {
  const f = fixture();
  f.press(); f.release(); f.release();
  expect(f.native.activate).toHaveBeenCalledExactlyOnceWith(11);
});

it('does not reconstruct ownership from a renderer release alone', () => {
  const f = fixture();
  f.foreground(99); f.release();
  expect(f.native.activate).not.toHaveBeenCalled();
});

it.each(['blur', 'hide', 'closed'])('revokes the return when the overlay receives %s', event => {
  const f = fixture();
  f.press(); f.win.emit(event); f.foreground(99); f.release();
  expect(f.native.activate).not.toHaveBeenCalled();
});

it('respects a new foreground choice even before the blur event arrives', () => {
  const f = fixture();
  f.press(); f.foreground(22); f.release();
  f.foreground(99); f.release();
  expect(f.native.activate).not.toHaveBeenCalled();
});

it.each(['missing', 'process', 'thread', 'overlay-destroyed'])('rejects a %s target identity', change => {
  const f = fixture(); f.press();
  if (change === 'missing') f.handles.delete(11);
  if (change === 'process') f.handles.set(11, { process: 999, thread: 201 });
  if (change === 'thread') f.handles.set(11, { process: 101, thread: 999 });
  if (change === 'overlay-destroyed') f.destroy();
  f.release();
  expect(f.native.activate).not.toHaveBeenCalled();
});

it('captures a fresh foreground for the next interaction after a revoked return', () => {
  const f = fixture();
  f.press(); f.win.emit('blur'); f.foreground(22); f.notify(22); f.press(); f.release();
  expect(f.native.activate).toHaveBeenCalledExactlyOnceWith(22);
});

it('unsubscribes from native events on destruction or renderer loss', () => {
  const f = fixture();
  Object.defineProperty(f.win, 'webContents', { get: () => { throw new Error('Object has been destroyed'); } });
  f.win.emit('closed');
  expect(f.stop).toHaveBeenCalledOnce();
  const g = fixture(); g.win.webContents.emit('render-process-gone');
  expect(g.stop).toHaveBeenCalledOnce();
});

it('does not restore ownership from late events after disposal or hiding', () => {
  for (const mode of ['dispose', 'hide'] as const) {
    const f = fixture();
    f[mode](); f.press(); f.release();
    expect(f.native.activate).not.toHaveBeenCalled();
    f.dispose(); f.win.emit('closed');
    expect(f.stop).toHaveBeenCalledOnce();
  }
});

it('rejects a delayed foreground event which no longer describes the active window', () => {
  const f = fixture();
  f.foreground(22); f.notify(99); f.foreground(99); f.release();
  expect(f.native.activate).not.toHaveBeenCalled();
});
