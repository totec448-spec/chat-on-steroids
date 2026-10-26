import { expect, it } from 'vitest';
import { redactPersonalText } from '../src/main/redaction.js';

it('hides email addresses and the user name in home-folder paths', () => {
  expect(redactPersonalText('Mail ana@example.com, in /Users/ana/x, /home/bo/app and C:\\Users\\Ana Lee\\y or c:/users/ana/z'))
    .toBe('Mail [redacted], in /Users/[redacted]/x, /home/[redacted]/app and C:\\Users\\[redacted]\\y or c:/users/[redacted]/z');
});

it('keeps shared system folders, which name no person', () => {
  const text = '/Users/Shared/a C:\\Users\\Public\\b C:\\Users\\All Users\\c c:/users/default/d /home/ x';
  expect(redactPersonalText(text)).toBe(text);
});

it('leaves ordinary text alone', () => {
  const text = 'Version 1.2.3 at 10:30, commit 3f9a2b1, ana@example and @handle, ~/projects/app';
  expect(redactPersonalText(text)).toBe(text);
});

it('hides an address and a path already partly hidden only once', () => {
  expect(redactPersonalText('/Users/[redacted]/x a@b.io a@b.io')).toBe('/Users/[redacted]/x [redacted] [redacted]');
});
