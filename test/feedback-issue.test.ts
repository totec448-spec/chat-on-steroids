import { describe, expect, it } from 'vitest';
import { feedbackIssueUrl, operatingSystemName, MAX_ISSUE_URL } from '../src/main/feedback.js';

const env = { version: '2.1.46', os: 'macOS 15.6', arch: 'arm64', extension: { present: true, version: '2.1.46' } };
const fields = (url: string) => Object.fromEntries(new URL(url).searchParams);

describe('the prefilled GitHub issue', () => {
  it('opens the bug form with everything the app knows and what the person wrote', () => {
    const { url, trimmed } = feedbackIssueUrl({ kind: 'bug', what: 'The Stop button stays grey.\nIt happens after a reload.', steps: '1. Reload\n2. Send', frequency: 'Sometimes' }, env);
    expect(url.startsWith('https://github.com/totec448-spec/chat-on-steroids/issues/new?')).toBe(true);
    expect(fields(url)).toEqual({
      template: 'bug_report.yml', title: 'The Stop button stays grey.', version: '2.1.46', operating_system: 'macOS 15.6',
      architecture: 'ARM64', extension: 'Yes, and its version matches the app', what: 'The Stop button stays grey.\nIt happens after a reload.',
      repro: '1. Reload\n2. Send', frequency: 'Sometimes'
    });
    expect(trimmed).toBe(false);
  });

  it('says what it knows about the extension, and nothing it does not', () => {
    const extension = (value: typeof env.extension | null) =>
      fields(feedbackIssueUrl({ kind: 'bug', what: 'x' }, { ...env, extension: value }).url).extension;
    expect(extension({ present: true, version: '2.1.40' })).toBe('Yes, but I am not sure the versions match');
    expect(extension({ present: false, version: '2.1.46' })).toBe('No');
    expect(extension(null)).toBeUndefined();
    expect(fields(feedbackIssueUrl({ kind: 'bug', what: 'x' }, { ...env, arch: 'x64' }).url).architecture).toBe('x64 (Intel/AMD)');
    expect(fields(feedbackIssueUrl({ kind: 'bug', what: 'x' }, { ...env, arch: 'ia32' }).url).architecture).toBe('Not sure');
  });

  it('opens the idea form with the problem and the proposal', () => {
    const { url } = feedbackIssueUrl({ kind: 'idea', problem: 'I lose track of long Goal runs', proposal: 'A summary when a run ends' }, env);
    expect(fields(url)).toEqual({ template: 'feature_request.yml', title: 'I lose track of long Goal runs',
      problem: 'I lose track of long Goal runs', proposal: 'A summary when a run ends' });
  });

  it('keeps the title to one short line', () => {
    const long = 'word '.repeat(60).trim();
    const title = fields(feedbackIssueUrl({ kind: 'bug', what: `  ${long}` }, env).url).title!;
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith('…')).toBe(true);
    expect(fields(feedbackIssueUrl({ kind: 'bug', what: 'First line\nsecond' }, env).url).title).toBe('First line');
    expect(fields(feedbackIssueUrl({ kind: 'bug', what: 'Ends early! Then more' }, env).url).title).toBe('Ends early!');
  });

  it('shortens what does not fit in a link, longest field first, and says so', () => {
    const what = 'Ü'.repeat(4000);
    const { url, trimmed } = feedbackIssueUrl({ kind: 'bug', what, steps: 'short steps' }, env);
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
    expect(trimmed).toBe(true);
    const shown = fields(url);
    expect(shown.repro).toBe('short steps');
    expect(shown.what!.endsWith('…')).toBe(true);
    // A cut never leaves half a character.
    expect(shown.what).not.toMatch(/�/);
  });

  it('keeps the link short even when the title is a few very long characters', () => {
    // One "character" can be thousands of code points (combining marks), or a long emoji sequence.
    const marks = `a${'\u0301'.repeat(3990)}`;
    const family = '👨\u200d👩\u200d👧\u200d👦'.repeat(80);
    for (const what of [marks, family]) {
      const { url } = feedbackIssueUrl({ kind: 'bug', what }, env);
      expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
      expect(encodeURIComponent(fields(url).title!).length).toBeLessThanOrEqual(900);
    }
  });

  it('builds the link even when the text holds a broken character', () => {
    // A lone half of a surrogate pair cannot be percent-encoded as it is; the link replaces it.
    for (const what of ['\uD800 crashed', `${'x'.repeat(100)}\uDC00`]) {
      const { url } = feedbackIssueUrl({ kind: 'bug', what }, env);
      expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
      expect(fields(url).title).toBeTruthy();
    }
  });

  it('cuts at whole characters even for emoji', () => {
    const { url } = feedbackIssueUrl({ kind: 'idea', problem: '🙂'.repeat(3000), proposal: 'p' }, env);
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
    expect(fields(url).problem).toMatch(/^(?:🙂)+…$/u);
  });

  it('keeps a family or flag emoji whole when the title or the text is shortened', () => {
    const family = '👨\u200D👩\u200D👧';
    // Title: the 79-character cut lands just after the first joiner of the family.
    const title = new URL(feedbackIssueUrl({ kind: 'bug', what: 'x'.repeat(77) + family + ' trip broke' }, env).url).searchParams.get('title')!;
    expect(title.includes('\u200D') ? title.includes(family) : true).toBe(true);
    // Text: shortened many times over, never ending in a broken family.
    const { url, trimmed } = feedbackIssueUrl({ kind: 'bug', what: (family + ' ').repeat(2000) }, env);
    expect(trimmed).toBe(true);
    const what = new URL(url).searchParams.get('what')!;
    const before = what.replace(/…$/u, '').trimEnd();
    expect(before.endsWith(family)).toBe(true);
    // Shortened only as far as needed: the link stays close to its limit, the text is not emptied.
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
    expect(url.length).toBeGreaterThan(MAX_ISSUE_URL - 120);
  });
});

describe('the operating system name', () => {
  it('names the system as people know it', () => {
    expect(operatingSystemName('darwin', '15.6.1')).toBe('macOS 15.6.1');
    expect(operatingSystemName('win32', '10.0.26100')).toBe('Windows 11 (build 26100)');
    expect(operatingSystemName('win32', '10.0.19045')).toBe('Windows 10 (build 19045)');
    expect(operatingSystemName('linux', '6.8.0-45-generic')).toBe('Linux 6.8.0-45-generic');
  });
});

describe('the issue forms it fills in', () => {
  // GitHub fills a field only when the address names its id, and picks a dropdown answer only by its
  // exact text: a renamed field or option in .github/ISSUE_TEMPLATE would silently stay empty.
  it('names only fields and answers the repository forms really have', async () => {
    const { readFileSync } = await import('node:fs');
    const forms = { 'bug_report.yml': readFileSync('.github/ISSUE_TEMPLATE/bug_report.yml', 'utf8'),
      'feature_request.yml': readFileSync('.github/ISSUE_TEMPLATE/feature_request.yml', 'utf8') };
    const reports = [
      feedbackIssueUrl({ kind: 'bug', what: 'x', steps: 's', frequency: 'Every time' }, env),
      feedbackIssueUrl({ kind: 'bug', what: 'x', frequency: 'Sometimes' }, { ...env, arch: 'x64', extension: { present: true, version: '1' } }),
      feedbackIssueUrl({ kind: 'bug', what: 'x', frequency: 'It happened once' }, { ...env, arch: 'ia32', extension: { present: false, version: null } }),
      feedbackIssueUrl({ kind: 'idea', problem: 'p', proposal: 'q' }, env)
    ];
    for (const { url } of reports) {
      const fields = new URL(url).searchParams;
      const form = forms[fields.get('template') as keyof typeof forms];
      expect(form, fields.get('template')!).toBeTruthy();
      for (const [name, value] of fields) {
        if (name === 'template' || name === 'title') continue;
        expect(form, name).toMatch(new RegExp(`\\n\\s+id: ${name}\\n`));
        const block = form.slice(form.search(new RegExp(`\\n\\s+id: ${name}\\n`)));
        // A dropdown's answer must be one of its options, word for word.
        const field = block.split(/\n {2}- type:/)[0]!;
        if (/^\s*options:/m.test(field)) expect(field, name).toContain(`- "${value}"`);
      }
    }
  });
});
