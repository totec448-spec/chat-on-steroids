import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { createComposerSlashAutocomplete, parseComposerSlashCommand } from '../src/renderer/composer-slash.js';

let dom: JSDOM;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); });

it('parses only exact built-in command messages', () => {
  expect(parseComposerSlashCommand('/plan')).toEqual({ id: 'plan' });
  expect(parseComposerSlashCommand('  /GOAL  ')).toEqual({ id: 'goal' });
  expect(parseComposerSlashCommand('/loop')).toEqual({ id: 'loop' });
  expect(parseComposerSlashCommand('/compact')).toEqual({ id: 'compact' });
  expect(parseComposerSlashCommand('/compact now')).toBeNull();
  expect(parseComposerSlashCommand('/goal\nkeep verifying')).toBeNull();
  expect(parseComposerSlashCommand('/review')).toBeNull();
  expect(parseComposerSlashCommand('Please /goal this')).toBeNull();
});

it('offers built-ins, activates click/Enter immediately, and keeps Tab as completion only', () => {
  dom = new JSDOM('<textarea id="input"></textarea><div id="popup" hidden></div>');
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('Event', dom.window.Event);
  const input = dom.window.document.getElementById('input') as HTMLTextAreaElement;
  const popup = dom.window.document.getElementById('popup')!;
  const activated = vi.fn();
  const controller = createComposerSlashAutocomplete({ input, popup, onActivate: activated });

  input.value = '/'; input.setSelectionRange(1, 1); controller.onInput();
  expect(popup.hidden).toBe(false);
  expect(popup.classList.contains('composer-command-autocomplete')).toBe(true);
  expect([...popup.querySelectorAll('strong')].map(node => node.textContent)).toEqual(['Plan', 'Goal', 'Loop', 'Compact']);
  expect(popup.querySelectorAll('.composer-command-icon')).toHaveLength(4);
  popup.querySelectorAll<HTMLButtonElement>('button')[1]!.click();
  expect(activated).toHaveBeenCalledWith(expect.objectContaining({ id: 'goal' }));
  expect(popup.hidden).toBe(true);
  expect(popup.classList.contains('composer-command-autocomplete')).toBe(false);

  input.value = '/go'; input.setSelectionRange(3, 3); controller.onInput();
  const tab = new dom.window.KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
  expect(controller.onKeydown(tab)).toBe(true);
  expect(input.value).toBe('/goal');
  expect(popup.hidden).toBe(true);

  input.value = '/lo'; input.setSelectionRange(3, 3); controller.onInput();
  const enter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
  expect(controller.onKeydown(enter)).toBe(true);
  expect(enter.defaultPrevented).toBe(true);
  expect(activated).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'loop' }));
  expect(popup.hidden).toBe(true);

  input.value = '/review'; input.setSelectionRange(7, 7);
  expect(controller.matchesInput()).toBe(false);
});
