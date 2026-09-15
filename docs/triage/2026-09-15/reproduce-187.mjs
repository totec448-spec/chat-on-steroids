import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { openArtifactFile, ArtifactFetchError } from './artifact-fetch.ts';

// Execute the unchanged published module. Verify its Git blob identity first.
const bytes = await readFile(new URL('./artifact-fetch.ts', import.meta.url));
const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
assert.equal(blob, 'edfad203750c8fe096e0d9a63d38f8be514d6257');
const result = {
  issue: 187,
  sourceCommit: '2f9be7eb9d6d1f13ccac9019e20965af15d4e4be',
  sourceBlob: blob,
  runtime: process.version,
  scope: 'Unchanged published module; synthetic references and fetch stub; no real network/download or Windows worktree validation',
  reproduced: [],
  controls: [],
  guards: []
};
function reference(url) { return { file_id: 'fixture-187', download_url: url }; }
async function readText(stream) {
  const parts = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts).toString('utf8');
}
for (const host of [
  'oaisdmntprpolandcentral.blob.core.windows.net',
  'oaisdmntprwestus.blob.core.windows.net',
  'oaisdmntprcentralus.blob.core.windows.net'
]) {
  let calls = 0;
  let observed;
  try {
    await openArtifactFile(reference(`https://${host}/fixture.txt`), {
      fetch: async () => { calls++; return new Response('fixture'); }
    });
  } catch (error) { observed = error; }
  assert.ok(observed instanceof ArtifactFetchError, `${host}: original rejection must reproduce`);
  assert.match(observed.message, /outside the trusted file host/);
  assert.equal(calls, 0, 'Reported failure happens before the network request');
  result.reproduced.push({ host, accepted: false, fetchCalls: calls, error: observed.message });
}
for (const host of [
  'files.oaiusercontent.com',
  'example-region.oaiusercontent.com',
  'oaidalleapiprodscus.blob.core.windows.net'
]) {
  let calls = 0;
  const source = await openArtifactFile(reference(`https://${host}/fixture.txt`), {
    fetch: async () => { calls++; return new Response('fixture'); }
  });
  assert.equal(await readText(source.stream), 'fixture');
  assert.equal(calls, 1);
  result.controls.push({ host, accepted: true, fetchCalls: calls });
}
for (const url of [
  'http://files.oaiusercontent.com/fixture',
  'https://files.oaiusercontent.com:8443/fixture',
  'https://name:password@files.oaiusercontent.com/fixture',
  'https://files.oaiusercontent.com/fixture#fragment',
  'https://files.oaiusercontent.com.invalid/fixture',
  'https://fakeoaiusercontent.com/fixture',
  'https://oaidalleapiprodscus.blob.core.windows.net.invalid/fixture',
  'https://arbitrary-account.blob.core.windows.net/fixture'
]) {
  let calls = 0;
  await assert.rejects(openArtifactFile(reference(url), {
    fetch: async () => { calls++; return new Response('fixture'); }
  }), ArtifactFetchError);
  assert.equal(calls, 0);
  result.guards.push({ case: url, rejectedBeforeFetch: true });
}
let redirectCalls = 0;
await assert.rejects(openArtifactFile(reference('https://files.oaiusercontent.com/fixture'), {
  fetch: async () => {
    redirectCalls++;
    return new Response(null, { status: 302, headers: { location: 'https://untrusted.example/fixture' } });
  }
}), ArtifactFetchError);
assert.equal(redirectCalls, 1);
result.guards.push({ case: 'Redirect from trusted URL to untrusted host', rejectedBeforeSecondFetch: true });
result.summary = { originalFailuresReproduced: result.reproduced.length, positiveControls: result.controls.length, rejectionGuards: result.guards.length, fixVerified: false };
await writeFile(new URL('./reproduction-187.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result.summary, null, 2));
