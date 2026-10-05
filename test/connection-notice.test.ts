import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

// Exercise the production Electron adapter without starting the app or an OS notification daemon.
function noticeFixture() {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const adapter = source.slice(source.indexOf('setConnectionLossNotifier('), source.indexOf('\nsetBrowserWorkArea('))
    .replaceAll(' as const', '');
  let notify!: (surface: 'core' | 'desktop' | 'plugins') => boolean;
  const show = vi.fn();
  const click = vi.fn();
  const create = vi.fn();
  const showWindow = vi.fn();
  const state = { focused: false, supported: true };
  const mainText = vi.fn((text: string) => `translated:${text}`);
  const context = vm.createContext({
    quitting: false,
    window: { isFocused: () => state.focused },
    setConnectionLossNotifier: (listener: typeof notify) => { notify = listener; },
    mainText,
    showWindow,
    Notification: class {
      static isSupported() { return state.supported; }
      constructor(options: unknown) { create(options); }
      on(event: string, listener: () => void) { expect(event).toBe('click'); click(listener); }
      show = show;
    }
  });
  vm.runInContext(adapter, context);
  return { notify, state, context, create, show, click, showWindow, mainText };
}

it.each(['core', 'desktop', 'plugins'] as const)('localizes the %s loss notice and opens the app on click', surface => {
  const fixture = noticeFixture();
  expect(fixture.notify(surface)).toBe(true);
  const title = { core: 'Core connection lost', desktop: 'Desktop connection lost', plugins: 'Plugins connection lost' }[surface];
  const body = 'The tunnel disconnected unexpectedly. Open Chat On Steroids to check the connection.';
  expect(fixture.mainText.mock.calls).toEqual([[title], [body]]);
  expect(fixture.create).toHaveBeenCalledExactlyOnceWith({ title: `translated:${title}`, body: `translated:${body}` });
  expect(fixture.show).toHaveBeenCalledTimes(1);
  expect(fixture.showWindow).not.toHaveBeenCalled();
  fixture.click.mock.calls[0]![0]();
  expect(fixture.showWindow).toHaveBeenCalledTimes(1);
});

it.each(['focused', 'unsupported', 'quitting'])('suppresses the notice while %s', reason => {
  const fixture = noticeFixture();
  if (reason === 'focused') fixture.state.focused = true;
  if (reason === 'unsupported') fixture.state.supported = false;
  if (reason === 'quitting') fixture.context.quitting = true;
  expect(fixture.notify('core')).toBe(false);
  expect(fixture.create).not.toHaveBeenCalled();
  expect(fixture.show).not.toHaveBeenCalled();
  expect(fixture.showWindow).not.toHaveBeenCalled();
});
