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

  it('does not count text a split HTML comment hides from readers (code scanning)', () => {
    // One pass of comment removal turned `<!<!-- -->-- … -->` into a new, still hidden comment.
    const hidden = good.replace('React remounts the composer before Send, so the draft lease is lost.',
      '<!<!-- x -->-- React remounts the composer before Send, so the draft lease is lost. -->');
    expect(check({ body: hidden, files: [{ path: 'extension/content.js', changes: 40 }, { path: 'test/content-script.test.ts', changes: 60 }] }).join('\n')).toMatch(/## Why/);
  });

  it('needs no issue: the description carries the why and the what', () => {
    expect(check({ body: good.replace('Fixes #744\n\n', ''), files: [{ path: 'extension/content.js', changes: 40 }, { path: 'test/content-script.test.ts', changes: 60 }] })).toEqual([]);
  });

  it('requires a test or a stated reason for code changes, and leaves the fail-first proof to its job', () => {
    const code = [{ path: 'src/main/goal.ts', changes: 12 }];
    expect(check({ body: good.replace(/## Test[\s\S]*/, '## Test\n\n'), files: code }).join()).toMatch(/Add or update a test/);
    expect(check({ body: good.replace(/## Test[\s\S]*/, '## Test\n\nNo test: the change only renames a log line.'), files: code })).toEqual([]);
    // The "Fail-first test" job runs the new test against main; the description need not say so.
    expect(check({ body: good.replace(/fails without the change/, 'passes'), files: [...code, { path: 'test/goal.test.ts', changes: 5 }] })).toEqual([]);
  });

  it('asks for screenshots when the interface changes', () => {
    const files = [{ path: 'src/renderer/styles.css', changes: 4 }, { path: 'test/ui.test.ts', changes: 4 }];
    expect(check({ body: good, files }).join()).toMatch(/screenshots/);
    expect(check({ body: `${good}\n## Screenshots\n\n![before](https://example.com/a.png)\n`, files })).toEqual([]);
    expect(check({ body: `${good}\nNo visual change: only which transcript reads happen changes.`, files })).toEqual([]);
    expect(check({ body: `${good}\n- [x] No visual changes: only which transcript reads happen changes.`, files })).toEqual([]);
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
    // Answered as a checklist item, singular or plural (#1274).
    expect(check({ body: `${good}\n- [x] No contract changes: only the suggested filename is corrected.`, files })).toEqual([]);
    expect(check({ body: `${good}\n* No contract change: only a comment in the preload file moved.`, files })).toEqual([]);
    // A mention inside a sentence is not the stated line.
    expect(check({ body: `${good}\nThere is No contract change: here, I think.`, files }).join()).toMatch(/shared contract/);
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

// 2026-10-15, user: a contributor PR that changes app behavior shows it working in the real app,
// so a review only needs smaller checks. Maintainers and PRs opened earlier are not asked.
// @ts-expect-error The checker is a plain Node script without type declarations.
import { LIVE_PROOF_SINCE } from '../scripts/pr-check.mjs';

describe('live proof for behavior changes', () => {
  const contributor = { maintainer: false, createdAt: '2026-10-16T09:00:00Z' };
  const fix = [{ path: 'extension/content.js', changes: 40 }, { path: 'test/content-script.test.ts', changes: 60 }];
  const checkLive = check as (pr: Parameters<typeof check>[0] & { maintainer?: boolean; createdAt?: string }) => string[];
  const proof = (text: string) => `${good}\n## Live proof\n\n${text}\n`;

  it('asks a new contributor PR that changes the app for live proof', () => {
    expect(Date.parse(LIVE_PROOF_SINCE)).toBeLessThan(Date.parse(contributor.createdAt));
    expect(checkLive({ body: good, files: fix, ...contributor })).toEqual([expect.stringContaining('## Live proof')]);
    expect(checkLive({ body: proof('It works, trust me.'), files: fix, ...contributor })).toHaveLength(1);
  });

  it('accepts a screenshot, a recording link or a log excerpt from the real app', () => {
    expect(checkLive({ body: proof('![after](https://github.com/user-attachments/assets/0480676d-ab5b-4ddc-b7c4-0ed664d9b432)'), files: fix, ...contributor })).toEqual([]);
    expect(checkLive({ body: proof('https://github.com/user-attachments/assets/0480676d-ab5b-4ddc-b7c4-0ed664d9b432'), files: fix, ...contributor })).toEqual([]);
    expect(checkLive({ body: proof('```\n12:01:02 [bridge] receipt confirmed for the first send\n```'), files: fix, ...contributor })).toEqual([]);
    expect(checkLive({ body: `${good}\nNo behavior change: only renames a private helper.\n`, files: fix, ...contributor })).toEqual([]);
  });

  it('leaves maintainers, earlier PRs and changes outside the app alone', () => {
    expect(checkLive({ body: good, files: fix, maintainer: true, createdAt: contributor.createdAt })).toEqual([]);
    expect(checkLive({ body: good, files: fix, maintainer: false, createdAt: '2026-10-14T09:00:00Z' })).toEqual([]);
    expect(checkLive({ body: good, files: [{ path: 'scripts/pr-check.mjs', changes: 10 }, { path: 'test/pr-check.test.ts', changes: 10 }], ...contributor })).toEqual([]);
  });
});

// From 2026-10-21 (user): every PR that changes code says which rare and edge cases it handles.
// @ts-expect-error The checker is a plain Node script without type declarations.
import { EDGE_CASES_SINCE } from '../scripts/pr-check.mjs';

describe('edge and rare cases', () => {
  const opened = '2026-10-22T09:00:00Z';
  // Only this rule's own problems: the other rules of the same date have their own tests below.
  const checkAt = (pr: Parameters<typeof check>[0] & { maintainer?: boolean; createdAt?: string }) =>
    (check as (pr: Parameters<typeof check>[0] & { maintainer?: boolean; createdAt?: string }) => string[])(pr).filter(problem => /Edge cases/.test(problem));
  const fix = [{ path: 'src/main/bridge.ts', changes: 30 }, { path: 'test/bridge.test.ts', changes: 40 }];
  const edges = `${good}
## Edge cases

- A restart while the message waits: it is kept and sent once (test "keeps it across a restart").
- Two sends at once: the second waits for the first.
`;

  it('asks a code change for its edge cases, maintainers included', () => {
    expect(Date.parse(EDGE_CASES_SINCE)).toBeLessThan(Date.parse(opened));
    for (const maintainer of [false, true]) {
      const problems = checkAt({ body: good, files: fix, maintainer, createdAt: opened });
      expect(problems.join('\n')).toMatch(/## Edge cases/);
    }
  });

  it('passes with the edge cases listed, or with a reason there are none', () => {
    expect(checkAt({ body: edges, files: fix, maintainer: true, createdAt: opened })).toEqual([]);
    expect(checkAt({ body: `${good}\nNo edge cases: only a wording change in one log line.\n`, files: fix, maintainer: true, createdAt: opened })).toEqual([]);
    // The template's hint alone is not an answer.
    const hint = `${good}\n## Edge cases\n\n<!-- The rare and edge cases this handles -->\n`;
    expect(checkAt({ body: hint, files: fix, maintainer: true, createdAt: opened }).join('\n')).toMatch(/## Edge cases/);
  });

  it('asks nothing of docs or test-only changes, nor of PRs opened before the rule', () => {
    expect(checkAt({ body: good, files: [{ path: 'docs/setup.md', changes: 4 }], maintainer: true, createdAt: opened })).toEqual([]);
    expect(checkAt({ body: good, files: [{ path: 'test/bridge.test.ts', changes: 40 }], maintainer: true, createdAt: opened })).toEqual([]);
    expect(checkAt({ body: good, files: fix, maintainer: true, createdAt: '2026-10-20T09:00:00Z' })).toEqual([]);
  });
});

// From 2026-10-21 (user): new text in every language, and OS-level changes thought through on both platforms.
describe('languages and platforms', () => {
  const opened = '2026-10-22T09:00:00Z';
  const checkAt = check as (pr: Parameters<typeof check>[0] & { maintainer?: boolean; createdAt?: string }) => string[];
  const complete = `${good}
## Edge cases

No edge cases: a one-line wording change in a log message.

## Checklist

- [x] Every new text a person sees is in all 12 languages, or there is none.
- [x] Every decision the app makes (it waits, refuses, skips or retries) writes one log line saying which and why, or there is none.
- [x] It sends no more to ChatGPT or other providers per step, or the PR says how much more and why.
`;
  const fix = [{ path: 'src/main/bridge.ts', changes: 30 }, { path: 'test/bridge.test.ts', changes: 40 }];

  it('asks a code change to confirm its text is in all 12 languages', () => {
    const unticked = complete.replace('- [x] Every new text', '- [ ] Every new text');
    expect(checkAt({ body: unticked, files: fix, maintainer: true, createdAt: opened }).join('\n')).toMatch(/12 languages/);
    expect(checkAt({ body: complete, files: fix, maintainer: true, createdAt: opened })).toEqual([]);
  });

  it('asks an OS-level change how it behaves on Windows and macOS, without requiring a Mac', () => {
    const native = [{ path: 'src/main/tray-image.ts', changes: 20 }, { path: 'test/tray.test.ts', changes: 20 }];
    expect(checkAt({ body: complete, files: native, maintainer: true, createdAt: opened }).join('\n')).toMatch(/## Platforms/);
    const platforms = `${complete}\n## Platforms\n\nWindows: tried on Windows 11. macOS: not tested on a Mac; the tray API is the same there and the icon is a template image.\n`;
    expect(checkAt({ body: platforms, files: native, maintainer: true, createdAt: opened })).toEqual([]);
    expect(checkAt({ body: `${complete}\nNo platform difference: only a comment in the tray module changed.\n`, files: native, maintainer: true, createdAt: opened })).toEqual([]);
    // A shortcut in the renderer counts too.
    expect(checkAt({ body: complete, files: [{ path: 'src/renderer/app-shortcuts.ts', changes: 10 }, { path: 'test/app-shortcuts.test.ts', changes: 10 }], maintainer: true, createdAt: opened }).join('\n')).toMatch(/## Platforms/);
    // Not for other code.
    expect(checkAt({ body: complete, files: fix, maintainer: true, createdAt: opened })).toEqual([]);
  });
});

// From 2026-10-21 (user): old saved data, logged decisions, no fixed waits in tests, cost and size.
// @ts-expect-error The checker is a plain Node script without type declarations.
import { QUALITY_SINCE } from '../scripts/pr-check.mjs';

describe('saved data, logs, waits, cost and size', () => {
  const opened = '2026-10-22T09:00:00Z';
  type Extra = { maintainer?: boolean; createdAt?: string; addedCode?: string[]; addedTests?: string[]; largeFiles?: Array<{ path: string; bytes: number }> };
  const checkAt = check as (pr: Parameters<typeof check>[0] & Extra) => string[];
  const fix = [{ path: 'src/main/bridge.ts', changes: 30 }, { path: 'test/bridge.test.ts', changes: 40 }];
  const complete = `${good}
## Edge cases

No edge cases: a one-line wording change in a log message.

## Checklist

- [x] Every new text a person sees is in all 12 languages, or there is none.
- [x] Every decision the app makes (it waits, refuses, skips or retries) writes one log line saying which and why, or there is none.
- [x] It sends no more to ChatGPT or other providers per step, or the PR says how much more and why.
`;
  const at = (extra: Extra & { body?: string; files?: Array<{ path: string; changes: number }> } = {}) =>
    checkAt({ body: extra.body ?? complete, files: extra.files ?? fix, maintainer: true, createdAt: opened, ...extra });

  it('passes a complete code PR', () => {
    expect(Date.parse(QUALITY_SINCE)).toBeLessThan(Date.parse(opened));
    expect(at()).toEqual([]);
  });

  it('asks for the log and cost lines to be ticked', () => {
    expect(at({ body: complete.replace('- [x] Every decision', '- [ ] Every decision') }).join('\n')).toMatch(/log line/);
    expect(at({ body: complete.replace('- [x] It sends no more', '- [ ] It sends no more') }).join('\n')).toMatch(/per step/);
  });

  it('asks a change to what the app saves for a test with the previous version\'s data', () => {
    const saving = ['+    await writeDurableNow(\'worker-archive\', { version: 2, entries });'];
    expect(at({ addedCode: saving }).join('\n')).toMatch(/## Saved data/);
    expect(at({ addedCode: saving, body: `${complete}\n## Saved data\n\n"loads a version 1 file" reads a queue saved before this change, and a damaged one.\n` })).toEqual([]);
    expect(at({ addedCode: saving, body: `${complete}\nNo saved-data change: the write already existed, only its log line changed.\n` })).toEqual([]);
    expect(at({ addedCode: ['+  logInfo(`saved ${count}`);'] })).toEqual([]);
    // An IPC argument schema is not saved data.
    expect(at({ addedCode: ["+    const args = z.object({ id: z.string() }).parse(payload);"] })).toEqual([]);
  });

  it('flags fixed waits over a second in new tests, unless a reason is given', () => {
    const slow = ['+    await new Promise(resolve => setTimeout(resolve, 1500));'];
    expect(at({ addedTests: slow }).join('\n')).toMatch(/wait a fixed time/i);
    expect(at({ addedTests: ['+    await new Promise(resolve => setTimeout(resolve, 150));', '+    vi.advanceTimersByTime(60_000);'] })).toEqual([]);
    expect(at({ addedTests: slow, body: `${complete}\nLong wait: the real child process needs two seconds to exit on Windows.\n` })).toEqual([]);
  });

  it('asks large added files for their size reason', () => {
    const big = [{ path: 'src/renderer/assets/hero.png', bytes: 900_000 }];
    expect(at({ largeFiles: big }).join('\n')).toMatch(/Size:/);
    expect(at({ largeFiles: big, body: `${complete}\nSize: 900 KB, the full-resolution picture the Setup guide zooms into.\n` })).toEqual([]);
  });

  it('asks nothing of PRs opened before these rules', () => {
    expect(checkAt({ body: good, files: fix, maintainer: true, createdAt: '2026-10-20T09:00:00Z', addedTests: ['+ setTimeout(r, 5000)'] })).toEqual([]);
  });
});

// @ts-expect-error The checker is a plain Node script without type declarations.
import { LARGE_FILE_BYTES, largeFileFindings } from '../scripts/pr-check.mjs';

// The size rule is about what a PR adds: a 634 KB source file that was already that size is not
// news, and asking for "Size:" on every edit of it (#1741, src/main/bridge.ts) only teaches people
// to paste the line. A file that is new and large, crosses the limit, or grows by more than the
// limit at once still needs a reason.
describe('which files count as large', () => {
  const kb = (n: number) => n * 1024;
  it('asks for a new large file', () => {
    expect(largeFileFindings([{ path: 'docs/shot.png', bytes: kb(900), baseBytes: null }])).toEqual([{ path: 'docs/shot.png', bytes: kb(900) }]);
  });
  it('asks for a file that crosses the limit in this PR', () => {
    expect(largeFileFindings([{ path: 'a.webp', bytes: kb(600), baseBytes: kb(400) }])).toEqual([{ path: 'a.webp', bytes: kb(600) }]);
  });
  it('does not ask for an edit of a file that was already large', () => {
    expect(largeFileFindings([{ path: 'src/main/bridge.ts', bytes: kb(634), baseBytes: kb(633) }])).toEqual([]);
  });
  it('asks when an already large file grows by more than the limit at once', () => {
    expect(largeFileFindings([{ path: 'big.png', bytes: kb(600) + LARGE_FILE_BYTES + 1, baseBytes: kb(600) }]))
      .toEqual([{ path: 'big.png', bytes: kb(600) + LARGE_FILE_BYTES + 1 }]);
  });
  it('leaves small files and files that shrank alone', () => {
    expect(largeFileFindings([{ path: 'small.ts', bytes: kb(10), baseBytes: null }, { path: 'was-big.png', bytes: kb(300), baseBytes: kb(900) }])).toEqual([]);
  });
});

// @ts-expect-error The checker is a plain Node script without type declarations.
import { largeFilesOf } from '../scripts/pr-check.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// CodeRabbit on #1745: a file renamed and grown in the same PR has git status R, which an A/M-only
// filter skipped, and the size before is the old name's.
describe('the sizes the checker reads from git', () => {
  it('counts a renamed file that grew past the limit, against its old name at the merge base', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pr-check-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    try {
      git('init', '-q', '-b', 'main'); git('config', 'user.name', 'probe'); git('config', 'user.email', 'probe@example.invalid');
      // A 600 KB file, renamed and grown by just over the limit: still more than half the same, so
      // git reports a rename (R), not a new file.
      const lines = (count: number, tag: string) => Array.from({ length: count }, (_, n) => `${tag} ${n} `.padEnd(99, 'x') + '\n').join('');
      const old = lines(6000, 'old');
      writeFileSync(path.join(dir, 'old.txt'), old);
      git('add', '-A'); git('commit', '-qm', 'base'); git('branch', 'base');
      renameSync(path.join(dir, 'old.txt'), path.join(dir, 'new.txt'));
      writeFileSync(path.join(dir, 'new.txt'), old + lines(5300, 'new'));
      git('add', '-A'); git('commit', '-qm', 'rename and grow');
      expect(git('diff', '--name-status', 'base...HEAD')).toMatch(/^R\d*\told\.txt\tnew\.txt/m);
      expect(largeFilesOf('base', dir)).toEqual([{ path: 'new.txt', bytes: expect.any(Number) }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
