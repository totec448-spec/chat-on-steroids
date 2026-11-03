import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('compact Projects/Chats rows', () => {
  it('keeps ordinary rows compact while preserving the focus target and title sizing', () => {
    const row = rule('#sessionList:not(.is-inbox) .sess:not(.sess-card)');
    const control = rule('#sessionList:not(.is-inbox) .sess:not(.sess-card) .sess-top');
    const title = rule('#sessionList:not(.is-inbox) .sess:not(.sess-card) .sess-top > b');

    expect(row).toMatch(/min-height:\s*32px/);
    expect(row).toMatch(/margin-block:\s*1px/);
    expect(row).toMatch(/padding-block:\s*4px/);
    expect(control).toMatch(/min-height:\s*24px/);
    expect(title).toMatch(/line-height:\s*1\.4/);
  });

  it('paints keyboard focus on the unmasked row', () => {
    const focusedRow = rule('#sessionList:not(.is-inbox) .sess:has(> .sess-top:focus-visible)');
    const focusedControl = rule('#sessionList:not(.is-inbox) .sess:has(> .sess-top:focus-visible) > .sess-top');

    expect(focusedRow).toMatch(/outline:\s*2px solid var\(--blue\)/);
    expect(focusedRow).toMatch(/outline-offset:\s*-2px/);
    expect(focusedControl).toMatch(/outline:\s*none/);
  });
});
