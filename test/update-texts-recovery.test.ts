import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const keys = [
  "Choose Update all to retry.",
  "Choose Update all to retry. You can keep using the current app.",
  "Let active chats finish, then reload the browser extension in your browser.",
  "Open ChatGPT with the browser extension enabled, then choose Review setup.",
  "Choose Review setup to check the connection, then choose Update all to retry.",
  "Could not inspect the installed plugin in ChatGPT.",
  "Open this plugin's settings in ChatGPT, then choose Update all to recheck. If the check still fails, save a Diagnostics report from Activity.",
  "Wait for confirmation. If it does not arrive, open this plugin in ChatGPT and choose Update all to recheck.",
  "Run a tool through this plugin in ChatGPT to confirm this connection.",
  "The downloaded update could not be confirmed for installation.",
  "The saved plugin update state could not be read.",
  "The release information has no valid version number.",
  "The downloaded update did not match the published checksum.",
  "GitHub could not be reached. Check your connection",
  "Could not check for updates: HTTP {0}.",
  "Could not download {0}: HTTP {1}.",
  "Release {0} does not include {1}.",
  "The update download returned no data.",
  "Save a Diagnostics report from Activity for help with recovery. The saved state has been kept.",
  "Could not confirm the plugin's current tool definitions in ChatGPT.",
  "Choose Update all to check the installed plugin's tool definitions.",
  "In ChatGPT's plugin settings, refresh or recreate this plugin, then choose Update all to recheck.",
  "Finish active work and fully quit Chat On Steroids. Replace the app in /Applications, then open the updated app from there.",
  "Choose Review setup to check macOS permissions, then fully quit and reopen the app.",
  "Choose Update all to check for updates and update the app.",
  "Could not verify the saved plugin against the current tool definitions.",
  "In ChatGPT, refresh this existing plugin, then choose Update all to recheck. If Refresh is unavailable, save a Diagnostics report from Activity."
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
