import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const keys = [
  "App and extension versions differ",
  "Version not verified",
  "Core plugin",
  "Not enabled",
  "Not verified in ChatGPT",
  "Manual refresh required in ChatGPT",
  "Plugin refresh failed",
  "Plugin check failed",
  "Waiting for refresh confirmation",
  "Refresh needed in ChatGPT",
  "Waiting for a ChatGPT connection",
  "Verified in ChatGPT",
  "All checks passed",
  "Checks incomplete",
  "Update status",
  "App, browser extension and plugins in ChatGPT.",
  "Review setup",
  "Component details",
  "No tools published",
  "Tool call succeeded; full tool definitions not verified",
  "Ready to use; tool definitions not fully verified",
  "Your settings are kept. Manual steps appear in the status list."
];
it.each(["de", "es", "fr", "ja", "ko", "pt-BR", "pt-PT", "ru", "tr", "vi", "zh-CN", "zh-TW"])('publishes the translated update components strings in %s', locale => {
  const catalog = JSON.parse(readFileSync(`src/renderer/locales/${locale}.json`, 'utf8'));
  for (const key of keys) {
    expect(typeof catalog[key], key).toBe('string');
    expect(catalog[key].trim(), key).not.toBe('');
    expect(catalog[key], key).not.toBe(key);
    expect([...catalog[key].matchAll(/\{(\d+)\}/g)].map(match => match[1]).sort(), key)
      .toEqual([...key.matchAll(/\{(\d+)\}/g)].map(match => match[1]).sort());
  }
});
