import { expect, it } from 'vitest';
import { signInAgent } from '../src/main/cos-browser/sign-in.js';

const chromium = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

it('presents Firefox only on the sign-in pages, where Google refuses an embedded Chromium', () => {
  // 2026-10-03, live: "This browser or app may not be secure" with the Chromium agent; the same
  // account signed in with this one. The flow passes through these hosts.
  for (const url of [
    'https://auth.openai.com/log-in',
    'https://accounts.google.com/v3/signin/identifier?flowName=GeneralOAuthFlow',
    'https://accounts.google.com.br/accounts/SetSID?ssdc=1',
    'https://accounts.google.co.uk/accounts/SetSID',
    'https://accounts.youtube.com/accounts/CheckConnection?pmpo=https%3A%2F%2Faccounts.google.com'
  ]) expect(signInAgent(url, chromium, 'win32'), url).toMatch(/^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64; rv:\d+\.0\) Gecko\/20100101 Firefox\/\d+\.0$/);
  expect(signInAgent('https://accounts.google.com/', chromium, 'darwin')).toContain('Macintosh');
  expect(signInAgent('https://accounts.google.com/', chromium, 'linux')).toContain('X11; Linux');
  // ChatGPT and every other site keep the Chromium agent.
  for (const url of [
    'https://chatgpt.com/', 'https://www.google.com/search?q=x',
    'https://mail.google.com/', 'https://accounts.google.evil.example/', 'https://notaccounts.google.com/', 'not a url'
  ]) expect(signInAgent(url, chromium, 'win32'), url).toBe(chromium);
});
