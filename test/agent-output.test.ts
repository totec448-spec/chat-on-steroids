import { expect, it } from 'vitest';
import { AgentOutputStream, exitSummary } from '../src/main/agent-output.js';

// The read-only view of an agent's command (#1920): what the person sees, shielded like tool results.
const key = 'sk-proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';

function collect(shield: boolean) {
  const shown: string[] = [];
  return { shown, stream: new AgentOutputStream(shield, text => shown.push(text)) };
}

it('shows the output so far at once, then whole lines, masking a key split across two chunks', () => {
  const { shown, stream } = collect(true);
  stream.start(Buffer.from('build started\n'));
  expect(shown).toEqual(['build started\n']);
  stream.push(Buffer.from(`token=${key.slice(0, 12)}`));
  stream.flush(1_000);
  // The line has no end yet: held back, so the key is not shown in two halves that both pass.
  expect(shown).toHaveLength(1);
  stream.push(Buffer.from(`${key.slice(12)}\nnext line\n`));
  stream.flush(1_100);
  expect(shown[1]).toBe('token=[redacted]\nnext line\n');
});

it('keeps a character split across chunks whole', () => {
  const { shown, stream } = collect(false);
  const text = Buffer.from('Größe ✓ done\n');
  const cut = text.indexOf(Buffer.from('✓')) + 1;
  stream.push(text.subarray(0, cut)); stream.flush(0);
  stream.push(text.subarray(cut)); stream.flush(10);
  expect(shown.join('')).toBe('Größe ✓ done\n');
});

it('shows a line without its end after a second, or once it is long, so a progress bar still moves', () => {
  const { shown, stream } = collect(false);
  stream.push(Buffer.from('Downloading 10%'));
  stream.flush(0);
  expect(shown).toEqual([]);
  stream.flush(999);
  expect(shown).toEqual([]);
  stream.flush(1_000);
  expect(shown).toEqual(['Downloading 10%']);
  stream.push(Buffer.from('x'.repeat(5_000)));
  stream.flush(1_001);
  expect(shown[1]).toHaveLength(5_000);
});

it('shows everything left when the command ends, and the key is still masked', () => {
  const { shown, stream } = collect(true);
  stream.push(Buffer.from(`last ${key}`));
  stream.flush(0, true);
  expect(shown).toEqual(['last [redacted]']);
  expect(exitSummary(1, 252_400)).toEqual({ exitCode: 1, seconds: 252 });
  expect(exitSummary(null, -5)).toEqual({ exitCode: null, seconds: 0 });
});

it('shows the key as it is when the shield is off', () => {
  const { shown, stream } = collect(false);
  stream.start(Buffer.from(`${key}\n`));
  expect(shown).toEqual([`${key}\n`]);
});

// Haz on #2052: a line shown before its end must never split a secret into pieces that each pass.
const github = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';
const shownText = (shown: string[]) => shown.join('');

it('never shows a key split across a timed flush of a line without its end', () => {
  const { shown, stream } = collect(true);
  stream.push(Buffer.from(`step 1 of 9 uploading with ${github.slice(0, 10)}`));
  stream.flush(0); stream.flush(1_000);
  stream.push(Buffer.from(`${github.slice(10)} and more words after it\n`));
  stream.flush(1_100);
  expect(shownText(shown)).not.toContain(github.slice(0, 10));
  expect(shownText(shown)).toContain('[redacted]');
  expect(shownText(shown)).toContain('step 1 of 9');
});

it('keeps a header and its token together across a timed flush', () => {
  const { shown, stream } = collect(true);
  const token = 'abcDEF123ghiJKL456mnoPQR789';
  stream.push(Buffer.from('curl -s -H Authorization: Bearer'));
  stream.flush(0); stream.flush(1_000);
  stream.push(Buffer.from(` ${token} https://example.test/api and then it waited\n`));
  stream.flush(1_100);
  expect(shownText(shown)).not.toContain(token);
});

it('still moves a long line with spaces, holding back only its newest words', () => {
  const { shown, stream } = collect(true);
  const words = Array.from({ length: 900 }, (_, index) => `w${index}`).join(' ');
  stream.push(Buffer.from(`${words} `));
  stream.flush(0); stream.flush(1_000);
  expect(shownText(shown).length).toBeGreaterThan(3_000);
  expect(shownText(shown)).not.toContain('w899');
  stream.push(Buffer.from(`${key} end\n`));
  stream.flush(1_100);
  expect(shownText(shown)).toContain('w899 [redacted] end\n');
  expect(shownText(shown)).not.toContain(key.slice(0, 12));
});

it('never shows a private key whose lines arrive over several flushes', () => {
  const { shown, stream } = collect(true);
  stream.push(Buffer.from('before\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n'));
  stream.flush(0);
  stream.push(Buffer.from('AAAAAAABAAAAMwAAAAtzc2gtZWQyNTUxOQAAACBSECRETBODY\n'));
  stream.flush(300);
  stream.push(Buffer.from('-----END OPENSSH PRIVATE KEY-----\nafter\n'));
  stream.flush(600);
  const all = shownText(shown);
  expect(all).toContain('before\n');
  expect(all).toContain('after\n');
  expect(all).not.toContain('b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ');
  expect(all).not.toContain('SECRETBODY');
  expect(all).not.toContain('END OPENSSH PRIVATE KEY');
});

it('shows the output so far with the same care: a key cut by the start is completed by what follows', () => {
  const { shown, stream } = collect(true);
  stream.start(Buffer.from(`ready\nusing ${github.slice(0, 12)}`));
  stream.push(Buffer.from(`${github.slice(12)} now\n`));
  stream.flush(2_000);
  expect(shownText(shown)).toContain('ready\n');
  expect(shownText(shown)).not.toContain(github.slice(0, 12));
});

it('drops the cut lines beside the gap of a long command\'s kept output', () => {
  const { shown, stream } = collect(true);
  // The kept head ends inside a key and the kept tail starts inside another: neither piece can be recognised.
  stream.start(Buffer.from(`first line\nhead ends ${github.slice(0, 15)}\n... 5000 bytes omitted ...\n${github.slice(15)} tail line\nlast line\n`));
  const all = shownText(shown);
  expect(all).toContain('first line\n');
  expect(all).toContain('... 5000 bytes omitted ...\n');
  expect(all).toContain('last line\n');
  expect(all).not.toContain(github.slice(0, 15));
  expect(all).not.toContain(github.slice(15));
});

it('bounds a huge line without spaces: it shows, minus a held end, and memory stays bounded', () => {
  const { shown, stream } = collect(true);
  stream.push(Buffer.from('y'.repeat(200_000)));
  stream.flush(0); stream.flush(1_000);
  expect(shownText(shown).length).toBeGreaterThan(150_000);
  expect((stream as unknown as { pending: string }).pending.length).toBeLessThanOrEqual(70_000);
});

// CodeRabbit on #2052: a key whose BEGIN line fell into the omitted part of a long command's output.
it('hides key lines kept after the gap when their BEGIN line was omitted, through END or until it comes', () => {
  const body = ['MIIEpAIBAAKCAQEA1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4', 'y5z6A7B8C9D0E1F2G3H4I5J6K7L8M9N0O1P2Q3R4S5T6U7V8W9X0Y1Z2a3b4c5d6'];
  {
    const { shown, stream } = collect(true);
    stream.start(Buffer.from(`first line\nhead piece\n... 9000 bytes omitted ...\ncut ${body[0]!.slice(5)}\n${body[0]}\n${body[1]}\n-----END RSA PRIVATE KEY-----\nafter the key\n`));
    const all = shownText(shown);
    expect(all).toContain('first line\n');
    expect(all).toContain('[redacted private key]');
    expect(all).toContain('after the key\n');
    for (const line of body) expect(all).not.toContain(line);
    expect(all).not.toContain('END RSA PRIVATE KEY');
  }
  {
    // Still printing the key when the view opened: its lines stay hidden until END arrives.
    const { shown, stream } = collect(true);
    stream.start(Buffer.from(`first line\nhead piece\n... 9000 bytes omitted ...\ncut piece\n${body[0]}\n`));
    stream.push(Buffer.from(`${body[1]}\n-----END RSA PRIVATE KEY-----\nafter the key\n`));
    stream.flush(1_000);
    const all = shownText(shown);
    expect(all).toContain('[redacted private key]');
    expect(all).toContain('after the key\n');
    for (const line of body) expect(all).not.toContain(line);
  }
});

it('keeps a credential header whose value is on the next line until the value arrives', () => {
  const token = 'q9W8e7R6t5Y4u3I2o1P0a9S8d7F6g5H4';
  for (const [header, value] of [['Authorization: Bearer', token], ['Authorization:', `Bearer ${token}`], ['Bearer', token]] as const) {
    const { shown, stream } = collect(true);
    stream.push(Buffer.from(`request headers\n${header}\n`));
    stream.flush(0);
    stream.flush(5_000);
    expect(shownText(shown)).toBe('request headers\n');
    stream.push(Buffer.from(`${value}\ndone\n`));
    stream.flush(5_100);
    const all = shownText(shown);
    expect(all).not.toContain(token);
    expect(all).toContain('done\n');
  }
  // A header left without a value is shown when the command ends.
  const { shown, stream } = collect(true);
  stream.push(Buffer.from('Authorization: Bearer\n'));
  stream.flush(0);
  stream.flush(0, true);
  expect(shownText(shown)).toBe('Authorization: Bearer\n');
});

// CodeRabbit on #2052: hiding output on purpose is said in the log, once per stretch, without the text.
it('notes each deliberate hiding once, without the hidden text', () => {
  const notes: string[] = [];
  const shown: string[] = [];
  const stream = new AgentOutputStream(true, text => shown.push(text), reason => notes.push(reason));
  stream.start(Buffer.from('first line\nhead piece\n... 9000 bytes omitted ...\ncut piece\nMIIEpAIBAAKCAQEA1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4\n'));
  stream.push(Buffer.from('y5z6A7B8C9D0E1F2G3H4I5J6K7L8M9N0O1P2Q3R4S5T6U7V8W9X0Y1Z2a3b4c5d6\n'));
  stream.flush(1_000);
  stream.push(Buffer.from('-----END RSA PRIVATE KEY-----\nafter\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n'));
  stream.flush(2_000);
  stream.push(Buffer.from('more key body line that is long enough to look like base64 AAAA\n'));
  stream.flush(3_000);
  expect(notes).toEqual(['a private key\'s lines were kept after the omitted part; hidden until its END line',
    'a private key is being printed; hidden until its END line']);
  expect(notes.join('\n')).not.toMatch(/MIIE|b3Bl/);
});
