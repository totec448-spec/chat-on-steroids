import { describe, expect, it } from 'vitest';
import { createSidebarSelection } from '../src/renderer/sidebar-selection.js';

describe('T3-style sidebar selection', () => {
  it('toggles without changing the current conversation and keeps an anchor', () => {
    const selection = createSidebarSelection();
    selection.toggle('a'); selection.toggle('b'); selection.toggle('a');
    expect(selection.ids()).toEqual(['b']);
    expect(selection.anchor).toBe('a');
    selection.navigate('b');
    expect(selection.ids()).toEqual([]);
    expect(selection.anchor).toBe('b');
  });
  it('adds inclusive Shift ranges in rendered order without erasing existing selections', () => {
    const selection = createSidebarSelection();
    selection.toggle('a'); selection.toggle('d');
    selection.range('b', ['a', 'b', 'c', 'd']);
    expect(selection.ids()).toEqual(['a', 'd', 'b', 'c']);
    expect(selection.anchor).toBe('d');
    selection.range('e', ['a', 'b', 'c', 'd', 'e']);
    expect(selection.ids()).toContain('e');
  });
  it('falls back to one row if anchor is hidden; prunes invisible selection', () => {
    const selection = createSidebarSelection();
    selection.toggle('old'); selection.range('new', ['new', 'next']);
    expect(selection.ids()).toEqual(['old', 'new']);
    selection.retain(new Set(['new']));
    expect(selection.ids()).toEqual(['new']);
    expect(selection.anchor).toBe('new');
    selection.clear();
    expect(selection.ids()).toEqual([]);
  });
});
