import { expect, it, vi } from 'vitest';
import { showConnectionLossNotice } from '../src/main/connection-loss-notice.js';

function noticeFixture() {
  let quitting = false;
  const state = { focused: false, supported: true };
  const show = vi.fn();
  const click = vi.fn();
  const create = vi.fn(() => ({
    on: (event: 'click', listener: () => void) => { expect(event).toBe('click'); click(listener); },
    show
  }));
  const showWindow = vi.fn();
  const mainText = vi.fn((text: string) => `translated:${text}`);
  const notify = (surface: 'core' | 'desktop' | 'plugins') => showConnectionLossNotice(surface, {
    isQuitting: () => quitting,
    isFocused: () => state.focused,
    isSupported: () => state.supported,
    text: mainText,
    create,
    showWindow
  });
  return { notify, state, setQuitting: (value: boolean) => { quitting = value; }, create, show, click, showWindow, mainText };
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
  if (reason === 'quitting') fixture.setQuitting(true);
  expect(fixture.notify('core')).toBe(false);
  expect(fixture.create).not.toHaveBeenCalled();
  expect(fixture.show).not.toHaveBeenCalled();
  expect(fixture.showWindow).not.toHaveBeenCalled();
});
