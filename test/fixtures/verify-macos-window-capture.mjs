import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = readFileSync(path.join(root, 'native/macos-desktop-helper/main.swift'), 'utf8');
const functions = ['approximatelyEqual', 'scaledDimensions', 'captureWindow'].map(name => {
  const start = source.indexOf(`private func ${name}(`);
  const end = source.indexOf('\n}', start);
  if (start < 0 || end < 0) throw new Error(`Missing production Swift function: ${name}`);
  return source.slice(start, end + 2);
}).join('\n\n');
const pixelLimit = source.match(/^private let maxDecodedScreenshotPixels = .+$/m)?.[0];
if (!pixelLimit) throw new Error('Missing production capture pixel limit');
const fixture = readFileSync(path.join(root, 'test/fixtures/macos-window-capture.swift'), 'utf8');
const program = fixture.replace('// PRODUCTION_FUNCTIONS', () => `${pixelLimit}\n${functions}`);
if (process.argv.includes('--print')) process.stdout.write(program);
else {
  const directory = mkdtempSync(path.join(tmpdir(), 'cos-window-capture-'));
  try {
    const file = path.join(directory, 'probe.swift');
    writeFileSync(file, program);
    const result = spawnSync('swift', [file], { cwd: directory, encoding: 'utf8', timeout: 20_000, windowsHide: true });
    if (result.error) throw result.error;
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.status !== 0) throw new Error(`Swift window capture probe failed: ${result.status ?? result.signal}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
