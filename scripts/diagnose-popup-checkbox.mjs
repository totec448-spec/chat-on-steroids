#!/usr/bin/env node
/**
 * Diagnostic for the open "5e Finding 1" question in docs/qa/claude-mac.md: does
 * AXUIElementPerformAction(kAXPressAction) actually click a real Chromium checkbox on an
 * ordinary page, or does it fail there too — the same way it measurably fails against the
 * extension's own popup checkbox (0 pixels differ, no error, a coordinate click works
 * immediately)? This never touches the extension or the popup; it opens a brand-new, plain
 * Chrome window with nothing but a checkbox in it, so the two cases can be told apart.
 *
 * Usage (from the repo root):
 *   node scripts/prepare-macos-desktop-helper.mjs --platform darwin --arch <arm64|x64>
 *   node scripts/diagnose-popup-checkbox.mjs [arm64|x64]
 */
import { spawn, execFile } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const arch = process.argv[2] === 'x64' ? 'x64' : 'arm64';
const helper = path.join(process.cwd(), 'resources', 'packaging', 'desktop', 'darwin', arch, 'macos-desktop-helper');

if (!existsSync(helper)) {
  console.error(
    `No helper at ${helper}.\n` +
      `Run first: node scripts/prepare-macos-desktop-helper.mjs --platform darwin --arch ${arch}`
  );
  process.exit(1);
}

const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
let pending = null;
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let newline;
  while ((newline = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, newline);
    buf = buf.slice(newline + 1);
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve(JSON.parse(line));
    }
  }
});

function ask(op) {
  return new Promise((resolve) => {
    pending = resolve;
    child.stdin.write(JSON.stringify(op) + '\n');
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const fixture = '/tmp/cos-checkbox-fixture.html';
  writeFileSync(
    fixture,
    '<!doctype html><html><body>' +
      '<label style="font:24px sans-serif;display:flex;gap:8px;align-items:center;padding:40px;">' +
      '<input id="chk" type="checkbox"> Test checkbox</label></body></html>'
  );

  console.log('warm:', JSON.stringify(await ask({ op: 'warm' })));

  const before = await ask({ op: 'windows' });
  await run('open', ['-na', 'Google Chrome', '--args', '--new-window', 'file://' + fixture]);
  await sleep(2000);
  const after = await ask({ op: 'windows' });

  const beforeIds = new Set(before.windows.map((w) => w.id));
  const fresh = after.windows.filter((w) => !beforeIds.has(w.id) && /chrome/i.test(w.process));
  if (fresh.length === 0) {
    console.error('No new Chrome window found. Is Chrome already showing this exact fixture?');
    process.exitCode = 1;
    child.kill();
    return;
  }
  const id = fresh[fresh.length - 1].id;
  console.log('window id:', id);

  const found = await ask({ op: 'find_ui', id, role: 'checkbox' });
  console.log('find_ui:', JSON.stringify(found));
  const box = found.elements.find((e) => /checkbox/i.test(e.role));
  if (!box) {
    console.error('No checkbox found in find_ui reply.');
    process.exitCode = 1;
    child.kill();
    return;
  }
  console.log('snapshotId:', found.snapshotId, 'runtimeKey:', box.runtimeKey);

  console.log('capture before:', JSON.stringify(await ask({ op: 'capture', id, maxWidth: 640, file: '/tmp/before.png' })));
  console.log(
    'act_ui:',
    JSON.stringify(
      await ask({ op: 'act_ui', id, snapshotId: found.snapshotId, runtimeKey: box.runtimeKey, action: 'click' })
    )
  );
  console.log('capture after:', JSON.stringify(await ask({ op: 'capture', id, maxWidth: 640, file: '/tmp/after.png' })));

  await run('open', ['/tmp/before.png', '/tmp/after.png']);
  console.log('Done. Compare the two PNGs — is the box ticked in after.png but not before.png?');
  child.kill();
}

main().catch((err) => {
  console.error(err);
  child.kill();
  process.exitCode = 1;
});
