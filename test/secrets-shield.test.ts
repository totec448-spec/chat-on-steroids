import { describe, expect, it } from 'vitest';
import { maskSecrets, shieldToolResult } from '../src/main/secrets-shield.js';

// Every value below is made up for this test; none is a real credential.
const openai = 'sk-proj-' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z' + 'A7bC0dE3fG6hI9jK2lM5';
const anthropic = 'sk-ant-api03-' + 'q'.repeat(20) + 'R7t'.repeat(10);
const github = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const githubFine = 'github_pat_' + '11ABCDEFG0' + 'x'.repeat(12) + '_' + 'Y9'.repeat(30);
const aws = 'AKIA' + 'IOSFODNN7EXAMPLE'.replace('EXAMPLE', 'Q2W3E4R');
const stripe = 'sk_live_' + '4eC39HqLyjWDarjtT1zdp7dc';
const slack = 'xoxb-' + '1234567890-1234567890123-' + 'AbCdEfGhIjKlMnOpQrStUvWx';
const google = 'AIza' + 'SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY';
const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.' + 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACD0aQ==\n-----END OPENSSH PRIVATE KEY-----';

describe('secrets shield (masking only unmistakable credentials)', () => {
  it.each([
    ['OpenAI key', openai],
    ['Anthropic key', anthropic],
    ['GitHub token', github],
    ['GitHub token', githubFine],
    ['AWS access key', aws],
    ['Stripe key', stripe],
    ['Slack token', slack],
    ['Google API key', google],
    ['JSON Web Token', jwt]
  ])('masks a %s and says what it was', (kind, secret) => {
    const { text, masked } = maskSecrets(`before ${secret} after`);
    expect(text).not.toContain(secret);
    expect(text).toContain(`[${kind} hidden by Chat On Steroids]`);
    expect(text.startsWith('before ')).toBe(true);
    expect(text.endsWith(' after')).toBe(true);
    expect(masked).toEqual([kind]);
  });

  it('masks a whole private key block, keeping its header so the model knows what it was', () => {
    const { text, masked } = maskSecrets(`id_ed25519:\n${pem}\ndone`);
    expect(text).toBe('id_ed25519:\n-----BEGIN OPENSSH PRIVATE KEY-----\n[private key hidden by Chat On Steroids]\n-----END OPENSSH PRIVATE KEY-----\ndone');
    expect(masked).toEqual(['private key']);
  });

  it.each([
    ['OPENAI_API_KEY=abc123def456ghi789', 'OPENAI_API_KEY=[value hidden by Chat On Steroids]'],
    ['export DB_PASSWORD="s3cr3t-pass"', 'export DB_PASSWORD="[value hidden by Chat On Steroids]"'],
    ["SESSION_SECRET='Zx9!long-value'", "SESSION_SECRET='[value hidden by Chat On Steroids]'"],
    ['GITHUB_TOKEN: abcdefghijklmnop', 'GITHUB_TOKEN: [value hidden by Chat On Steroids]']
  ])('masks the value of a secret-named setting: %s', (line, expected) => {
    expect(maskSecrets(line).text).toBe(expected);
  });

  it('masks secret settings in a file with Windows line endings', () => {
    expect(maskSecrets('A=1\r\nAPI_TOKEN=abcdefgh12345678\r\nB=2\r\n').text).toBe('A=1\r\nAPI_TOKEN=[value hidden by Chat On Steroids]\r\nB=2\r\n');
  });

  it('masks secret settings written as JSON, keeping the quotes and the comma', () => {
    expect(maskSecrets('{\n  "DB_PASSWORD": "hunter2hunter2",\n  "PORT": 5432\n}').text)
      .toBe('{\n  "DB_PASSWORD": "[value hidden by Chat On Steroids]",\n  "PORT": 5432\n}');
  });

  it.each([
    'OPENAI_API_KEY=',
    'OPENAI_API_KEY=""',
    'API_KEY=<your key here>',
    'API_KEY=${OPENAI_API_KEY}',
    'API_KEY=$OPENAI_API_KEY',
    'API_KEY=changeme',
    'API_KEY=xxxxxxxx',
    'API_KEY=your-api-key',
    'TOKEN_COUNT=4096',
    'MAX_TOKENS=8000',
    'KEYBOARD_LAYOUT=de',
    'PASSWORD_MIN_LENGTH=12',
    'SECRET_ROTATION_DAYS=30',
    'const apiKey = process.env.OPENAI_API_KEY;',
    'if (password === confirm) return true;',
    'sha256: 3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b',
    'commit 8ea2c3b16c23267945dd74ea72e6c60c00876cfb',
    'uuid 6ad9e4de-3d2c-83ed-8987-ba952528c99d',
    'task-key: sk-learn-more',
    'the word skeleton and sk-8 are fine',
    'AKIA is a prefix, AKIA123 is too short'
  ])('leaves ordinary text alone: %s', (line) => {
    expect(maskSecrets(line)).toEqual({ text: line, masked: [] });
  });

  it('masks every occurrence and lists each one in the order it appears', () => {
    const { text, masked } = maskSecrets(`${github}\n${openai}\n${github}`);
    expect(text).not.toContain(github);
    expect(text).not.toContain(openai);
    expect(masked).toEqual(['GitHub token', 'OpenAI key', 'GitHub token']);
  });

  it('returns the very same string when nothing could be a secret (the cheap path)', () => {
    const plain = 'x'.repeat(200_000);
    expect(maskSecrets(plain).text).toBe(plain);
  });

  it('stays fast on one very long line that looks like a setting (a minified bundle)', () => {
    const line = 'A=x' + ' '.repeat(200_000) + 'y\nAPI_TOKEN=' + 'q9'.repeat(10);
    const started = performance.now();
    expect(maskSecrets(line).masked).toEqual(['secret setting']);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('masks a secret setting on a very long line', () => {
    const value = 'Zq9' + 'x'.repeat(5000);
    const { text, masked } = maskSecrets(`API_TOKEN=${value}`);
    expect(masked).toEqual(['secret setting']);
    expect(text).toBe('API_TOKEN=[value hidden by Chat On Steroids]');
  });

  it('masks a quoted password that holds the other quote, and leaves code that reads one alone', () => {
    expect(maskSecrets(`DB_PASSWORD="hunter2'plus"`).text).toBe('DB_PASSWORD="[value hidden by Chat On Steroids]"');
    expect(maskSecrets(`DB_PASSWORD='hunter2"plus'`).text).toBe("DB_PASSWORD='[value hidden by Chat On Steroids]'");
    for (const line of ['API_TOKEN = getenv("API_TOKEN")', "SECRET_KEY: os.environ['SECRET_KEY']"]) {
      expect(maskSecrets(line)).toEqual({ text: line, masked: [] });
    }
  });

  it('masks a PGP private key block', () => {
    const pgp = '-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBGVhZXQBCAC3\n=ab12\n-----END PGP PRIVATE KEY BLOCK-----';
    const { text, masked } = maskSecrets(`gpg --export-secret-keys\n${pgp}`);
    expect(text).toBe('gpg --export-secret-keys\n-----BEGIN PGP PRIVATE KEY BLOCK-----\n[private key hidden by Chat On Steroids]\n-----END PGP PRIVATE KEY BLOCK-----');
    expect(masked).toEqual(['private key']);
  });

  it.each(['DB_PASSWORD=hunter2', 'PASS=abc', 'API_TOKEN="k9"', "SECRET: 'x'", 'export DB_PASS=1234'])
  ('masks a short secret value too: %s', line => {
    const { text, masked } = maskSecrets(line);
    expect(masked).toEqual(['secret setting']);
    expect(text).toContain('[value hidden by Chat On Steroids]');
    expect(text).not.toMatch(/hunter2|abc|k9|'x'|1234/);
  });

  it.each(['DB_PASSWORD=', "DB_PASSWORD=''", 'API_TOKEN=null', 'PASS=true', 'SECRET=...', 'API_KEY=***'])
  ('leaves an empty or stand-in value alone: %s', line => {
    expect(maskSecrets(line)).toEqual({ text: line, masked: [] });
  });

  it.each(['PASS: hunter2', 'PASS: "hunter2"', "PASS: 's3cretvalue'", 'PASS: test_math.py'])
  ('masks a lone PASS setting: %s', line => {
    expect(maskSecrets(line).masked).toEqual(['secret setting']);
  });

  it.each([
    'PASS: test_math.py\nFAIL: test_io.py',
    'PASS: tests/parser 3\nPASS: tests/lexer 1\nSKIP: tests/net',
    'make check\nPASS: t1\n# TOTAL: 1\n# PASS:  1'
  ])('leaves a test runner\'s PASS lines alone: %j', line => {
    expect(maskSecrets(line)).toEqual({ text: line, masked: [] });
  });

  it.each(['DB_PASSWORD=$uper-secret99', 'API_TOKEN=%x8!kQ2zLm0p', 'SESSION_SECRET=<x8kQ2zLm0p', 'CLIENT_SECRET={x8kQ2zLm0p'])
  ('masks a real value that only starts like a reference: %s', line => {
    expect(maskSecrets(line).masked).toEqual(['secret setting']);
  });

  it.each(['API_KEY=${OPENAI_API_KEY}', 'API_KEY=$OPENAI_API_KEY', 'API_KEY=<your key here>', 'API_KEY={{ secrets.API_KEY }}', 'API_KEY=%OPENAI_API_KEY%'])
  ('leaves a reference alone: %s', line => {
    expect(maskSecrets(line)).toEqual({ text: line, masked: [] });
  });

  it('stays fast on a large output', () => {
    const big = ('npm test output line with nothing secret in it\n').repeat(40_000) + `TOKEN=${'a1'.repeat(20)}\n`;
    const started = performance.now();
    const { masked } = maskSecrets(big);
    expect(masked).toEqual(['secret setting']);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('shieldToolResult', () => {
  it('masks text content and string values in structured content, leaving images untouched', () => {
    const image = { type: 'image' as const, data: 'iVBORw0KGgo=', mimeType: 'image/png' };
    const result = { content: [{ type: 'text' as const, text: `key ${openai}` }, image],
      structuredContent: { output: `token ${github}`, nested: { list: [stripe, 7, null] }, exitCode: 0 }, isError: false };
    const { result: shielded, masked } = shieldToolResult(result);
    expect(JSON.stringify(shielded)).not.toContain(openai);
    expect(JSON.stringify(shielded)).not.toContain(github);
    expect(JSON.stringify(shielded)).not.toContain(stripe);
    expect(shielded.content[1]).toBe(image);
    expect(shielded.structuredContent).toMatchObject({ exitCode: 0, nested: { list: [expect.stringContaining('hidden'), 7, null] } });
    expect(shielded.isError).toBe(false);
    expect(masked).toEqual(['OpenAI key', 'GitHub token', 'Stripe key']);
  });

  it('counts a value once when the text and the structured copy both carry it', () => {
    const output = `OPENAI_KEY ${openai}`;
    const { result, masked } = shieldToolResult({ content: [{ type: 'text' as const, text: output }], structuredContent: { output, exit_code: 0 } });
    expect(JSON.stringify(result)).not.toContain(openai);
    expect(masked).toEqual(['OpenAI key']);
  });

  it('returns the same result object when nothing was masked', () => {
    const result = { content: [{ type: 'text' as const, text: 'all clear' }], structuredContent: { output: 'fine' } };
    expect(shieldToolResult(result).result).toBe(result);
  });
});
