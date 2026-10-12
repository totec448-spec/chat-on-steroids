import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const keys = [
  "Choose Update all to retry.",
  "Choose Update all to retry. You can keep using the current app.",
  "Let active chats finish, then reload the companion extension in your browser.",
  "Open ChatGPT with the companion extension enabled, then choose Review setup.",
  "Choose Review setup to check the connection, then choose Update all to retry.",
  "Could not inspect the installed connector in ChatGPT.",
  "Open this connector's settings in ChatGPT, then choose Update all to recheck. If the check still fails, save a Diagnostics report from Activity.",
  "Wait for confirmation. If it does not arrive, open this connector in ChatGPT and choose Update all to recheck.",
  "Run a tool through this connector in ChatGPT to confirm this connection.",
  "The downloaded update could not be confirmed for installation.",
  "The saved connector update state could not be read.",
  "The release information has no valid version number.",
  "The downloaded update did not match the published checksum.",
  "Could not check for updates: HTTP {0}.",
  "Could not download {0}: HTTP {1}.",
  "Release {0} does not include {1}.",
  "The update download returned no data.",
  "Save a Diagnostics report from Activity for help with recovery. The saved state has been kept.",
  "Could not confirm the current connector tool definitions in ChatGPT.",
  "Choose Update all to check the installed connector tool definitions.",
  "In ChatGPT's connector settings, refresh or recreate this connector, then choose Update all to recheck.",
  "Finish active work and fully quit Chat On Steroids. Replace the app in /Applications, then open the updated app from there.",
  "Choose Review setup to check macOS permissions, then fully quit and reopen the app.",
  "Choose Update all to check for updates and update the app.",
  "Could not verify the saved connector against the current tool definitions.",
  "In ChatGPT, refresh this existing connector, then choose Update all to recheck. If Refresh is unavailable, save a Diagnostics report from Activity."
];
it.each(["de", "es", "fr", "ja", "ko", "pt-BR", "pt-PT", "ru", "tr", "vi", "zh-CN", "zh-TW"])('publishes the translated update recovery strings in %s', locale => {
  const catalog = JSON.parse(readFileSync(`src/renderer/locales/${locale}.json`, 'utf8'));
  for (const key of keys) {
    expect(typeof catalog[key], key).toBe('string');
    expect(catalog[key].trim(), key).not.toBe('');
    expect(catalog[key], key).not.toBe(key);
    expect([...catalog[key].matchAll(/\{(\d+)\}/g)].map(match => match[1]).sort(), key)
      .toEqual([...key.matchAll(/\{(\d+)\}/g)].map(match => match[1]).sort());
  }
});
