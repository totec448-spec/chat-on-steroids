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
