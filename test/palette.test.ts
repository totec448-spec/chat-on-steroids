import { expect, it, vi } from 'vitest';
import { matchActions, matchesWords, type PaletteAction } from '../src/renderer/palette.js';

/**
 * #1884 (Haz): ⌘K keeps chats first and gains a short, curated Actions section, only while typing and
 * only with what matches. Every word typed must be in the action's name, case and accents folded.
 */
const action = (label: string, available = true): PaletteAction => ({ label: () => label, run: vi.fn(), available: () => available });
const actions = [action('New chat'), action('Open Review'), action('Open Terminal'), action('Open Files'), action('Keyboard shortcuts'),
  action('Settings'), action('Show sub-agents'), action('Stop the turn', false)];

it('lists only actions whose name holds every word typed', () => {
  expect(matchActions(actions, 'open').map(row => row.label())).toEqual(['Open Review', 'Open Terminal', 'Open Files']);
  expect(matchActions(actions, 'rev').map(row => row.label())).toEqual(['Open Review']);
  expect(matchActions(actions, 'open term').map(row => row.label())).toEqual(['Open Terminal']);
  expect(matchActions(actions, 'KEYBOARD').map(row => row.label())).toEqual(['Keyboard shortcuts']);
});

it('matches words by their start, so "review" does not find "Preview"', () => {
  expect(matchesWords('Preview', 'review')).toBe(false);
  expect(matchesWords('Open Review', 'rev')).toBe(true);
  expect(matchesWords('Writing style', 'writ sty')).toBe(true);
  expect(matchesWords('Übersicht', 'uber')).toBe(true);
  expect(matchesWords('Settings', '')).toBe(false);
});

it('offers nothing before anything is typed, leaves out what does not apply now, and stays short', () => {
  expect(matchActions(actions, '')).toEqual([]);
  expect(matchActions(actions, '   ')).toEqual([]);
  expect(matchActions(actions, 'stop')).toEqual([]);
  // A word that starts many names: at most four rows, so the chats stay the point of the dialog.
  const many = [...actions, action('Open Sub-agents'), action('Open Settings')];
  expect(matchActions(many, 'open')).toHaveLength(4);
});
