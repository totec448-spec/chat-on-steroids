import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compactHtml } from '../electron.vite.config';

describe('Quick Chat renderer entry', () => {
  const workspaceEntry = '<script type="module" src="./main.ts"></script>';
  const compactEntry = '<script type="module" src="./quick-chat.ts"></script>';
  it('preserves the original Workspace entry and derives the compact page without copying markup', () => {
    const workspace = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
    expect(workspace.split(workspaceEntry)).toHaveLength(2);
    const compact = compactHtml(workspace);
    expect(compact).not.toContain(workspaceEntry);
    expect(compact.split(compactEntry)).toHaveLength(2);
    expect(compact.replace(compactEntry, workspaceEntry)).toBe(workspace);
  });
  it('refuses a missing or ambiguous Workspace entry instead of booting two renderers', () => {
    expect(() => compactHtml('<body></body>')).toThrow('exactly one');
    expect(() => compactHtml(workspaceEntry + workspaceEntry)).toThrow('exactly one');
  });
});
