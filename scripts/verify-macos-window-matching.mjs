import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = readFileSync(path.join(root, 'native/macos-desktop-helper/main.swift'), 'utf8');
const names = ['convincinglyMatchesWindow', 'windowGeometryDistance', 'titlesAgree', 'matchingAXWindow'];
const functions = names.map(name => {
  const start = source.indexOf(`private func ${name}(`);
  const end = source.indexOf('\n}', start);
  if (start < 0 || end < 0) throw new Error(`Missing production Swift function: ${name}`);
  return source.slice(start, end + 2);
}).join('\n\n');
const fixture = readFileSync(path.join(root, 'test/fixtures/macos-window-matching.swift'), 'utf8');
const program = fixture.replace('// PRODUCTION_FUNCTIONS', () => functions);
if (process.argv.includes('--print')) {
  process.stdout.write(program);
} else {
  const directory = mkdtempSync(path.join(tmpdir(), 'cos-window-matching-'));
  try {
    const file = path.join(directory, 'probe.swift');
    writeFileSync(file, program);
    const result = spawnSync('swift', [file], { cwd: directory, encoding: 'utf8', timeout: 20_000, windowsHide: true });
    if (result.error) throw result.error;
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.status !== 0) throw new Error(`Swift window matching probe failed: ${result.status ?? result.signal}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
