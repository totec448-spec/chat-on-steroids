import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import arabic from '../src/renderer/locales/ar.json';

const extension = JSON.parse(readFileSync('extension/_locales/ar/messages.json', 'utf8')) as Record<string, { message: string }>;
const renderer = arabic as Record<string, string>;
const preserved = (text: string) => (text.match(/\{\d+\}|\$[1-9]/g) ?? []).sort();

describe('Arabic localization safety regression', () => {
  it('names the actual localized trust/release actions when tool access is refused', () => {
    const trust = renderer['Trust chat'];
    const release = renderer['Release chat'];
    const errors = [
      "Only chats you trust can use this computer's tools. Existing chats start untrusted: open a chat's ⋯ menu in the sidebar and choose Trust chat. Workers and resumed chats follow the chat they came from. Calls the app can't link to a chat are refused.",
      "A tool call from an untrusted chat was refused. To allow it, open this chat's ⋯ menu in the sidebar (or right-click its row) and choose Trust chat.",
      "A tool call from a worker whose main chat is not currently allowed was refused. Open that main chat's ⋯ menu in the sidebar and choose Trust chat if it is untrusted, or Release chat if it is blocked.",
      "A tool call from an app-created worker was refused because the main chat that started it is not proven yet. Return to that main chat in the sidebar; once its row is there, open its ⋯ menu and choose Trust chat, or Release chat if it is blocked, then retry after the worker is attached or recovered there."
    ];
    for (const key of errors) {
      expect(renderer[key], key).toContain(trust);
      expect(renderer[key], key).not.toContain('«Trust chat»');
    }
    for (const key of errors.slice(2)) expect(renderer[key], key).toContain(release);
    expect(renderer['A project is a folder you approve, and its chats start there.']).not.toContain('مشاركت');
  });
  it('preserves distinct Arabic counted-minute/hour wording and technical accessibility labels', () => {
    expect(renderer['After {0} minutes of work|few']).toContain('دقائق');
    expect(renderer['every {0} hours|few']).toContain('ساعات');
    expect(renderer['After {0} minutes of work|two']).not.toBe(renderer['After {0} minutes of work|few']);
    expect(renderer['every {0} hours|two']).not.toBe(renderer['every {0} hours|few']);
    expect(extension.content_compact_cancel_aria?.message).toContain('عملية');
    expect(extension.popup_overwrite_chatgpt?.message).toContain('أدوات');
    expect(extension.content_goal_delivery_only_finish?.message).toContain('Session Finish');
  });
  it('does not silently change substitutions or leave HTML entities in UI strings', () => {
    for (const [key, value] of Object.entries(renderer)) {
      expect(preserved(value), key).toEqual(preserved(key.replace(/\|(zero|one|two|few|many)$/, '')));
      expect(value, key).not.toMatch(/&quot;|&apos;|&amp;|&#34;|&#39;/);
    }
    for (const [key, entry] of Object.entries(extension)) {
      expect(entry.message, key).not.toMatch(/&quot;|&apos;|&amp;/);
    }
  });
  it('keeps critical deletion and permission language precise', () => {
    const critical: Record<string, string> = {
      'Share a folder': 'مشاركة مجلد',
      'Folder shared': 'تمت مشاركة المجلد',
      'Delete files': 'حذف الملفات',
      'Deny': 'رفض',
      'Allow once': 'السماح مرة واحدة',
      'Remove {0}': 'إزالة {0}',
      'Read-only': 'للقراءة فقط',
      'Anyone with this URL can use your enabled tools. Do not share it.':
        'يمكن لأي شخص يمتلك هذا الرابط استخدام أدواتك المفعّلة. لا تشارك الرابط مع الآخرين.'
    };
    for (const [key, value] of Object.entries(critical)) expect(renderer[key], key).toBe(value);
  });
  it('keeps Arabic catalogs and complex plural forms complete', () => {
    expect(Object.keys(renderer).length).toBeGreaterThan(4300);
    expect(Object.keys(extension).length).toBeGreaterThan(490);
    expect(new Intl.PluralRules('ar').resolvedOptions().pluralCategories.sort())
      .toEqual(['few','many','one','other','two','zero']);
    for (const key of Object.keys(renderer).filter(k => k.endsWith('|one'))) {
      const base = key.slice(0, -4);
      expect(renderer[base], base).toMatch(/[\u0621-\u064A]/u);
      for (const form of ['zero','one','two','few','many']) {
        expect(renderer[base + '|' + form], base + '|' + form).toBeDefined();
        expect(preserved(renderer[base + '|' + form]!), base + '|' + form)
          .toEqual(preserved(base));
      }
    }
  });
  it('preserves the 2.1.53 release highlights across locale catalogs without duplicate keys', () => {
    const releaseKeys = [
      'Compact & Resume in Projects, Goal chats that recover, and safer saves over SSH.',
      'It works in a Project that already holds chats started through the app.',
      'Goal chats keep going',
      'A Goal chat no longer stops for good after a Continue that failed.',
      'Safer saves over SSH',
      'If a save fails, your original file stays as it was.',
      'Write mid-answer in any language',
      'A message sent while ChatGPT is answering now goes out on pages in every language.'
    ];
    const locales = ['ar', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'];
    for (const locale of locales) {
      const raw = readFileSync('src/renderer/locales/' + locale + '.json', 'utf8');
      const messages = JSON.parse(raw) as Record<string, string>;
      const serializedKeys = [...raw.matchAll(/^  ("(?:\\.|[^"\\])*")\s*:/gm)].map(match => JSON.parse(match[1]!) as string);
      expect(new Set(serializedKeys).size, locale + ': duplicate JSON key').toBe(serializedKeys.length);
      expect(serializedKeys.length, locale + ': unparseable/duplicate JSON key').toBe(Object.keys(messages).length);
      for (const key of releaseKeys) {
        expect(messages[key], locale + ': missing 2.1.53 release text: ' + key).toBeTruthy();
        if (locale === 'ar') expect(messages[key], key).toMatch(/[\u0621-\u064A]/u);
      }
    }
    const featureName = renderer['Compact & Resume:']!.replace(/[:：]\s*$/, '').trim();
    expect(renderer[releaseKeys[0]!]).toContain(featureName);
  });
});
