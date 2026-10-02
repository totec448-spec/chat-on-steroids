import { describe, expect, it } from 'vitest';
// @ts-expect-error The checker is a plain Node script without type declarations.
import { checkPullRequest } from '../scripts/pr-check.mjs';

const check = checkPullRequest as (pr: { body: string; files: Array<{ path: string; changes: number }>; draft?: boolean;
  fromFork?: boolean; maintainerCanModify?: boolean }) => string[];

const good = `Fixes #744

## Why

React remounts the composer before Send, so the draft lease is lost.

## What changed

The lease follows a replaced composer once before Send authorization.

## Test

\`follows a remounted composer once\` in test/content-script.test.ts fails without the change.
`;

describe('pull request checklist', () => {
  it('passes a complete fix with a test', () => {
    expect(check({ body: good, files: [{ path: 'extension/content.js', changes: 40 }, { path: 'test/content-script.test.ts', changes: 60 }] })).toEqual([]);
  });

  it('passes the unfilled template for nothing, and names every missing part', () => {
    const template = '<!-- note -->\n\nFixes #\n\n## Why\n\n<!-- x -->\n\n## What changed\n\n## Test\n';
    const problems = check({ body: template, files: [{ path: 'src/main/bridge.ts', changes: 10 }] });
    expect(problems.join('\n')).not.toMatch(/issue/i);
    expect(problems.join('\n')).toMatch(/## Why/);
    expect(problems.join('\n')).toMatch(/## What changed/);
    expect(problems.join('\n')).toMatch(/Add or update a test/);
  });

  it('needs no issue: the description carries the why and the what', () => {
    expect(check({ body: good.replace('Fixes #744\n\n', ''), files: [{ path: 'extension/content.js', changes: 40 }, { path: 'test/content-script.test.ts', changes: 60 }] })).toEqual([]);
  });

  it('requires a test or a stated reason for code changes, and a failing-first claim', () => {
    const code = [{ path: 'src/main/goal.ts', changes: 12 }];
    expect(check({ body: good.replace(/## Test[\s\S]*/, '## Test\n\n'), files: code }).join()).toMatch(/Add or update a test/);
    expect(check({ body: good.replace(/## Test[\s\S]*/, '## Test\n\nNo test: the change only renames a log line.'), files: code })).toEqual([]);
    expect(check({ body: good.replace(/fails without the change/, 'passes'), files: [...code, { path: 'test/goal.test.ts', changes: 5 }] }).join())
      .toMatch(/fails without your change/);
  });

  it('asks for screenshots when the interface changes', () => {
    const files = [{ path: 'src/renderer/styles.css', changes: 4 }, { path: 'test/ui.test.ts', changes: 4 }];
    expect(check({ body: good, files }).join()).toMatch(/screenshots/);
    expect(check({ body: `${good}\n## Screenshots\n\n![before](https://example.com/a.png)\n`, files })).toEqual([]);
    expect(check({ body: `${good}\nNo visual change: only which transcript reads happen changes.`, files })).toEqual([]);
  });

  it('rejects stray notes and logs', () => {
    const files = [{ path: 'docs/worklog-2026-09-29-footer.md', changes: 22 }, { path: 'debug.log', changes: 3 }];
    expect(check({ body: good, files }).join()).toMatch(/worklog-2026-09-29-footer\.md, debug\.log/);
  });

  it('bounds large changes but not tests or translations', () => {
    const big = [{ path: 'src/main/control-api.ts', changes: 700 }, { path: 'test/a.test.ts', changes: 2000 }];
    expect(check({ body: good, files: big }).join()).toMatch(/700 changed lines/);
    expect(check({ body: `${good}\nLarge change: one new API route and its schema.`, files: big })).toEqual([]);
    expect(check({ body: good, files: [{ path: 'src/renderer/locales/de.json', changes: 900 }, { path: 'extension/_locales/de/messages.json', changes: 900 }] })).toEqual([]);
  });

  it('treats documentation-only changes as needing no test', () => {
    expect(check({ body: good.replace(/## Test[\s\S]*/, ''), files: [{ path: 'README.md', changes: 5 }] })).toEqual([]);
  });

  it('accepts the section names contributors already use', () => {
    const body = 'For #82.\n\n## Problem\n\nA stuck owner never answers a read.\n\n## What\n\nReads answer 504 after fifteen seconds.\n\n## Tests\n\nBreaking the deadline fails the new tests.\n';
    expect(check({ body, files: [{ path: 'src/main/control-api.ts', changes: 50 }, { path: 'test/control-api-reads.test.ts', changes: 90 }] })).toEqual([]);
  });

  it('asks for AGENTS.md or a stated reason when a shared contract changes', () => {
    const files = [{ path: 'src/preload/index.ts', changes: 3 }, { path: 'test/ipc.test.ts', changes: 10 }];
    expect(check({ body: good, files }).join()).toMatch(/update AGENTS\.md/);
    expect(check({ body: good, files: [...files, { path: 'AGENTS.md', changes: 4 }] })).toEqual([]);
    expect(check({ body: `${good}\nNo contract change: only a comment in the preload file moved.`, files })).toEqual([]);
    expect(check({ body: good, files: [{ path: 'src/shared/session.ts', changes: 6 }, { path: 'test/a.test.ts', changes: 2 }] }).join())
      .toMatch(/shared contract/);
  });

  it('asks a fork to allow maintainer edits', () => {
    const files = [{ path: 'extension/content.js', changes: 4 }, { path: 'test/content-script.test.ts', changes: 4 }];
    expect(check({ body: good, files, fromFork: true, maintainerCanModify: false }).join()).toMatch(/Allow edits by maintainers/);
    expect(check({ body: good, files, fromFork: true, maintainerCanModify: true })).toEqual([]);
    expect(check({ body: good, files, fromFork: false, maintainerCanModify: false })).toEqual([]);
  });

  it('keeps a PR that depends on another one a draft', () => {
    const files = [{ path: 'extension/content.js', changes: 4 }, { path: 'test/content-script.test.ts', changes: 4 }];
    const stacked = `${good}\nDepends on #774.`;
    expect(check({ body: stacked, files }).join()).toMatch(/keep it a draft/);
    expect(check({ body: stacked, files, draft: true })).toEqual([]);
  });
});
