import { describe, expect, it } from 'vitest';
import { scrubText } from '../src/main/report-scrub.js';

const mac = { home: '/Users/jane', known: [] };
const win = { home: 'C:\\Users\\Jane', known: [] };

describe('scrubbing a diagnostics report', () => {
  it('keeps what explains a failure', () => {
    const line = '2026-10-04T06:49:53.818Z  warn   bridge: gave up on worker:6c578026-18d5-4efe-8c88-c63da86e6b3c:worker-11 — ' +
      'the chat this app opened did not report back in time (last step: choosing the model and reasoning, reported 85 s before the app gave up)';
    expect(scrubText(line, mac)).toBe(line);
    const request = 'request POST mcp/core → 200 in 510ms calls=1 ingress_ms=2 identity_ms=64';
    expect(scrubText(request, mac)).toBe(request);
    expect(scrubText('opened https://chatgpt.com/c/6ac1e55c-cef4-83e9-8ba4-32136df98e55?model=gpt-5-5', mac))
      .toBe('opened https://chatgpt.com/c/6ac1e55c-cef4-83e9-8ba4-32136df98e55?model=gpt-5-5');
  });

  it('replaces the home folder and every personal folder and file name, keeping the shape', () => {
    const out = scrubText("ENOENT: no such file or directory, open '/Users/jane/Documents/Thesis/chapter 3.docx'", mac);
    expect(out).not.toMatch(/jane|Documents|Thesis|chapter/);
    expect(out).toMatch(/open '~\/<p:[0-9a-f]{4}>\/<p:[0-9a-f]{4}>\/<p:[0-9a-f]{4}>\.docx'$/);
    // The same path becomes the same tags, so it can be followed through the log.
    expect(scrubText("open '/Users/jane/Documents/Thesis/chapter 3.docx'", mac)).toBe(out.slice(out.indexOf('open')));
  });

  it('handles unquoted paths with spaces under the home folder and Windows paths', () => {
    const out = scrubText('read /Users/jane/Library/Application Support/Chat On Steroids/sessions/Client Plan.json failed', mac);
    expect(out).toMatch(/^read ~\/Library\/Application Support\/Chat On Steroids\/sessions\/<p:[0-9a-f]{4}>\.json failed$/);
    expect(out).not.toMatch(/Client|Plan/);
    // Ids and route names stay readable; they are what a bug report is followed by.
    expect(scrubText('wrote /Users/jane/.cos/sessions/6ac1e55c-cef4-83e9-8ba4-32136df98e55.json after POST /commands/ack', mac))
      .toBe('wrote ~/.cos/sessions/6ac1e55c-cef4-83e9-8ba4-32136df98e55.json after POST /commands/ack');
    const windows = scrubText('Import-Csv -LiteralPath C:\\Users\\Jane\\Desktop\\预算\\V1-DRIVER-01_决策级.csv done', win);
    expect(windows).not.toMatch(/Jane|Desktop|预算|决策级|DRIVER/);
    expect(windows).toMatch(/^Import-Csv -LiteralPath ~\\<p:[0-9a-f]{4}>\\<p:[0-9a-f]{4}>\\<p:[0-9a-f]{4}>\.csv done$/);
  });

  it('replaces known personal values wherever they appear, even without a path', () => {
    const out = scrubText('approved folder /Thesis; chat "Rebuild Budget Model" opened', { home: '/Users/jane', known: ['Thesis', 'Rebuild Budget Model'] });
    expect(out).not.toMatch(/Thesis|Rebuild Budget Model/i);
    expect(out).toMatch(/approved folder \/<x:[0-9a-f]{4}>; chat "<x:[0-9a-f]{4}>" opened/);
  });

  // #1922: a project named "Work" turned every "worker" and "worktree" in the log into "<x:…>er", 9,524 times.
  it('replaces a known value only as a whole word, never inside another word', () => {
    const out = scrubText('worker-2 started in Work; worktree for work ready; Homework and work-items stay', { home: '/Users/jane', known: ['Work'] });
    expect(out).toMatch(/^worker-2 started in <x:[0-9a-f]{4}>; worktree for <x:[0-9a-f]{4}> ready; Homework and <x:[0-9a-f]{4}>-items stay$/);
    // Names of other scripts and with punctuation inside still match whole.
    expect(scrubText('chat "Q3 – Plan" and Q3 – Plans', { home: '/Users/jane', known: ['Q3 – Plan'] })).toMatch(/^chat "<x:[0-9a-f]{4}>" and Q3 – Plans$/);
    expect(scrubText('Проект готов, Проекты нет', { home: '/Users/jane', known: ['Проект'] })).toMatch(/^<x:[0-9a-f]{4}> готов, Проекты нет$/);
    // A vowel sign (a Unicode mark) belongs to the word: "कामों" is not "काम" (CodeRabbit on #1923).
    expect(scrubText('काम पूरा, कामों बाकी', { home: '/Users/jane', known: ['काम'] })).toMatch(/^<x:[0-9a-f]{4}> पूरा, कामों बाकी$/);
  });

  // CodeRabbit on #1923: a value that starts or ends with punctuation needs no word edge on that side.
  it('replaces a known value that starts or ends with punctuation, also next to letters', () => {
    expect(scrubText('built C++17 and v2(draft)final', { home: '/Users/jane', known: ['C++', '(draft)'] }))
      .toMatch(/^built <x:[0-9a-f]{4}>17 and v2<x:[0-9a-f]{4}>final$/);
    // A letter edge still protects other words: "Cats" is not "Cat".
    expect(scrubText('Cats and Cat', { home: '/Users/jane', known: ['Cat'] })).toMatch(/^Cats and <x:[0-9a-f]{4}>$/);
  });

  // CodeRabbit on #1923: the longest known value wins wherever it fits, whatever characters it starts or ends with.
  it('replaces the longest overlapping known value whole', () => {
    const out = scrubText('owner Alice!Smith, Alice! and Alice Smithy', { home: '/Users/jane', known: ['Very Long Private Name!', 'Alice!Smith', 'Alice!', 'Alice Smith', 'Alice'] });
    expect(out).toMatch(/^owner (<x:[0-9a-f]{4}>), (<x:[0-9a-f]{4}>) and (<x:[0-9a-f]{4}>) Smithy$/);
    const [, first, second, third] = /^owner (\S+), (\S+) and (\S+)/.exec(out)!;
    expect(new Set([first, second, third]).size).toBe(3);
  });

  // CodeRabbit on #1923: a letter outside the Basic Multilingual Plane is one character, not two halves.
  it('checks word edges by whole characters outside the Basic Multilingual Plane', () => {
    expect(scrubText('Pre𐐀Test and 𐐀Test, Test𐐀 and Test𐐀Post', { home: '/Users/jane', known: ['𐐀Test', 'Test𐐀'] }))
      .toMatch(/^Pre𐐀Test and <x:[0-9a-f]{4}>, <x:[0-9a-f]{4}> and Test𐐀Post$/);
  });

  // A lookbehind on each of hundreds of known values made a 3 MB log take over 30 s (the report looked
  // stuck); grouped, it takes well under a second. Generous bound for slow runners.
  it('scrubs a large log with hundreds of known values quickly', () => {
    const known = Array.from({ length: 300 }, (_, i) => `Chat title number ${i} about a project`).concat(['Work', 'C++', '(draft)']);
    const line = 'info  [worker-3] tool exec_command ok in 12 ms; read src/app.ts lines 1–40; Work went on\n';
    const log = line.repeat(Math.ceil(1_000_000 / line.length));
    const start = performance.now();
    const out = scrubText(log, { home: '/Users/jane', known });
    expect(performance.now() - start).toBeLessThan(5_000);
    expect(out).toContain('[worker-3]');
    expect(out).not.toMatch(/\bWork went/);
  });

  // CodeRabbit on #1923: digits are not part of a name, so a name run together with a number is still replaced.
  it('replaces a known value run together with digits on either side', () => {
    expect(scrubText('saved Alice2026, 2026Alice and v2Alice3; Alices stays', { home: '/Users/jane', known: ['Alice'] }))
      .toMatch(/^saved <x:[0-9a-f]{4}>2026, 2026<x:[0-9a-f]{4}> and v2<x:[0-9a-f]{4}>3; Alices stays$/);
    // A number never matches inside a longer number: "Plan2" is not in "Plan25", "500" not in "15000ms".
    expect(scrubText('Plan2 and Plan25', { home: '/Users/jane', known: ['Plan2'] })).toMatch(/^<x:[0-9a-f]{4}> and Plan25$/);
    expect(scrubText('took 15000ms, room 500 and 500ms', { home: '/Users/jane', known: ['500'] }))
      .toMatch(/^took 15000ms, room <x:[0-9a-f]{4}> and <x:[0-9a-f]{4}>ms$/);
  });

  // CodeRabbit on #1923: an underscore joins names in identifiers; the known value inside goes either way.
  it('replaces a known value joined to an identifier by an underscore', () => {
    expect(scrubText('profile Acme Budget_2026 and laptop_username', { home: '/Users/jane', known: ['Acme Budget', 'username'] }))
      .toMatch(/^profile <x:[0-9a-f]{4}>_2026 and laptop_<x:[0-9a-f]{4}>$/);
  });

  it('removes emails, secrets, private hosts and addresses', () => {
    const out = scrubText('user jane.doe@example.com sent Bearer abc.def.ghi with OPENROUTER_API_KEY=sk-or-123456789 to https://homelab.lan:8080/api from 192.168.1.20', mac);
    expect(out).not.toMatch(/jane|example\.com|abc\.def|sk-or|homelab|192\.168/);
    expect(out).toContain('<email>');
    expect(out).toContain('Bearer <redacted>');
    expect(out).toContain('OPENROUTER_API_KEY=<redacted>');
    expect(out).toContain('https://<host>');
    expect(out).toContain('<ip>');
    expect(scrubText('bridge on 127.0.0.1:8765', mac)).toBe('bridge on 127.0.0.1:8765');
  });
});
