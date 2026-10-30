import { describe, it, expect } from 'vitest';
import { sidebarDragAction, SIDEBAR_SHELF_MIME } from '../src/renderer/sidebar-shelf-drag.js';

describe('sidebar cross-shelf drag semantics', () => {
  it('labels all valid shelf moves and never accepts snoozing without a deadline', () => {
    expect(sidebarDragAction('active', 'pinned')).toEqual({ shelf: 'pinned', label: 'Pin' });
    expect(sidebarDragAction('active', 'settled')).toEqual({ shelf: 'settled', label: 'Settle · Sidebar only' });
    expect(sidebarDragAction('pinned', 'active')?.label).toBe('Unpin');
    expect(sidebarDragAction('settled', 'active')?.label).toBe('Un-settle');
    expect(sidebarDragAction('snoozed', 'active')?.label).toBe('Wake');
    expect(sidebarDragAction('snoozed', 'pinned')?.label).toBe('Pin');
    expect(sidebarDragAction('active', 'active')).toBeNull();
    expect(sidebarDragAction('active', 'snoozed')).toBeNull();
    expect(SIDEBAR_SHELF_MIME).toMatch(/^application\/x-/);
  });
});
