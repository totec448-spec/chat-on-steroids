import { describe, expect, it } from 'vitest';
import { parseLinuxScreenshot } from '../src/main/computer/linux-screenshot.js';
import type { LinuxDesktopEnvelope } from '../src/main/computer/linux-screenshot-backend.js';

const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const shot = (data: unknown): LinuxDesktopEnvelope => ({ ok: true, command: 'screenshot', data });
const canonical = (data: string) => ({ data, format: 'png', width: 1, height: 1, scale_factor: 1 });

describe('pinned agent-desktop v1.0.2 screenshot output contract', () => {
  it('reads the image exclusively from outerEnvelope.data.data and verifies its decoded pixels', async () => {
    const result = await parseLinuxScreenshot(shot(canonical(tinyPng)));
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    expect(result.png).toEqual(Buffer.from(tinyPng, 'base64'));
    expect(result.base64).toBe(tinyPng);
  });

  it.each([
    ['bare base64', tinyPng],
    ['wrong field', { base64: tinyPng, format: 'png', width: 1, height: 1 }],
    ['file path', { path: '/tmp/not-our-screenshot.png', format: 'png', width: 1, height: 1 }],
    ['wrong format', { ...canonical(tinyPng), format: 'jpeg' }]
  ])('rejects %s without treating it as image content', async (_name, payload) => {
    await expect(parseLinuxScreenshot(shot(payload))).rejects.toMatchObject({ code: 'INVALID_SHAPE' });
  });

  it('rejects inconsistent metadata without trusting the PNG header alone', async () => {
    await expect(parseLinuxScreenshot(shot({ ...canonical(tinyPng), width: 12 })))
      .rejects.toMatchObject({ code: 'INVALID_DIMENSIONS' });
    await expect(parseLinuxScreenshot(shot({ ...canonical(tinyPng), width: 5120, height: 5000 })))
      .rejects.toMatchObject({ code: 'INVALID_DIMENSIONS' });
  });

  it('rejects malformed base64, corrupt PNG, and payloads above the bounded capture limit', async () => {
    await expect(parseLinuxScreenshot(shot(canonical('not base64'))))
      .rejects.toMatchObject({ code: 'INVALID_BASE64' });
    const damaged = Buffer.from(tinyPng, 'base64');
    damaged[43] = damaged[43]! ^ 0x20;
    await expect(parseLinuxScreenshot(shot(canonical(damaged.toString('base64')))))
      .rejects.toMatchObject({ code: 'INVALID_PNG' });
    // Oversized strings must fail before Buffer.from and before pixel decoding.
    const tooLarge = 'A'.repeat(4 * Math.ceil(8 * 1024 * 1024 / 3) + 4);
    await expect(parseLinuxScreenshot(shot(canonical(tooLarge))))
      .rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' });
  });
});
