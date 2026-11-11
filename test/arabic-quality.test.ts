import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import arabic from '../src/renderer/locales/ar.json';

const extension = JSON.parse(readFileSync('extension/_locales/ar/messages.json', 'utf8')) as Record<string, { message: string }>;
const renderer = arabic as Record<string, string>;
const preserved = (text: string) => (text.match(/\{\d+\}|\$[1-9]/g) ?? []).sort();

describe('Arabic localization safety regression', () => {
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
});
