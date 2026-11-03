// Refreshes the measured seconds that balance the CI shards (test/test-weights.json for the unit
// tests, scripts/ui-check-weights.json for the UI checks) from one CI run's job logs, by default the
// latest successful run on main. Each item keeps its slowest time across the OS jobs.
//
//   node scripts/update-ci-weights.mjs [run id]
//
// Needs the GitHub CLI signed in. Run it when the suite's shape changed a lot (many new or split
// files); stale weights only make the shards less even, never skip a test.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = process.env.COS_REPO ?? 'totec448-spec/chat-on-steroids';
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const runId = process.argv[2] ?? gh('run', 'list', '-R', repo, '--workflow', 'ci.yml', '--branch', 'main', '--status', 'success',
  '--limit', '1', '--json', 'databaseId', '-q', '.[0].databaseId').trim();
if (!/^\d+$/.test(runId)) throw new Error(`No CI run to read (got "${runId}")`);
const jobs = JSON.parse(gh('api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`)).jobs;

const tests = new Map(), checks = new Map();
const keep = (map, name, seconds) => map.set(name, Math.max(map.get(name) ?? 0, seconds));
const plain = text => text.replace(/\x1b\[[0-9;]*m/g, '');
for (const job of jobs) {
  if (job.conclusion !== 'success' || !/^(Verify|UI checks)/.test(job.name)) continue;
  const log = plain(gh('api', '--allow-escape-sequences', `repos/${repo}/actions/jobs/${job.id}/logs`));
  for (const match of log.matchAll(/ [✓❯] (test\/[^ ]+\.test\.ts) \([^)]*\) (\d+)ms/g)) keep(tests, match[1], Math.round(Number(match[2]) / 100) / 10);
  for (const match of log.matchAll(/PASS {2}(verify-[^ ]+\.cjs) {2}\((\d+)s\)/g)) keep(checks, match[1], Number(match[2]));
}
if (!tests.size) throw new Error(`Run ${runId} has no successful unit test job to read`);
const write = (file, map) => writeFileSync(path.join(root, file), `${JSON.stringify(Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : 1))), null, 1)}\n`);
write('test/test-weights.json', tests);
if (checks.size) write('scripts/ui-check-weights.json', checks);
console.log(`Run ${runId}: ${tests.size} test files, ${checks.size} UI checks${checks.size ? '' : ' (no UI job ran; their weights are unchanged)'}.`);
