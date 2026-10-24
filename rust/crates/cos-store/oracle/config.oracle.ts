/**
 * config.json through the app's own loader: each case writes a file (or none), runs loadConfig,
 * then saves what it loaded the way the next Settings save would. The Rust loader must return
 * the same config, the same recovery flag and write the same bytes.
 */
import { afterAll, beforeAll, it, vi } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contents, record, SHIPPED_PATH } from './record.js';

const { defaultConfig } = await import('../../../../src/main/config.js');
/** A fresh module per case: the recovery flag is process state, set once per real launch. */
const freshConfigModule = async () => { vi.resetModules(); return await import('../../../../src/main/config.js'); };
const goal = await import('../../../../src/shared/goal.js');
const { SUPERSEDED_HELPER_CHAT_MODELS } = await import('../../../../src/shared/chat-models.js');
const { APP_VERSION } = await import('../../../../src/main/version.js');
const { makeTempDir, removeTempDir } = await import('../../../../test/helpers.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const typesFixtures = path.resolve(here, '../../cos-types/tests/fixtures');

let dir: string;
beforeAll(async () => { dir = await makeTempDir('cos-store-config-'); });
afterAll(async () => { await removeTempDir(dir); });

const win = defaultConfig('win32');
const minimalLegacy = {
  roots: [{ name: 'work', path: 'C:\\work' }],
  capabilities: { browse: true, search: true, read: true, metadata: true, powershell: true, deleteFolder: true },
  readOnly: false,
  tunnel: { kind: 'openai', tunnelId: '', binaryPath: '' },
  ui: { minimizeToTray: true, autoConnect: false }
};
const json = (value: unknown): string => JSON.stringify(value, null, 2);
const withPatch = (patch: (config: any) => void): string => {
  const config = structuredClone(win) as any;
  patch(config);
  return json(config);
};

const around = json({ ...minimalLegacy, mcp: { instructions: 'A@@B' } }).split('@@');

/** name -> file contents; `null` means no file, `{ directory: true }` a folder in its place. */
const cases: Record<string, string | Buffer | null | { directory: true }> = {
  'missing': null,
  'directory-in-place': { directory: true },
  'empty-file': '',
  'truncated': json(win).slice(0, 120),
  'not-json': 'roots = []',
  'json-null': 'null',
  'json-array': '[]',
  'bom-prefixed': `\uFEFF${json(minimalLegacy)}`,
  'invalid-utf8-in-string': Buffer.concat([Buffer.from(around[0]!, 'utf8'), Buffer.from([0xff, 0xfe]), Buffer.from(around[1]!, 'utf8')]),
  'legacy-minimal': json(minimalLegacy),
  'legacy-old-token-defaults': json({ ...minimalLegacy, sessions: { record: false, retainDays: 30, advisoryTokens: 180000, limitTokens: 200000 }, compaction: { auto: false, autoTokens: 300000 } }),
  'legacy-second-token-defaults': json({ ...minimalLegacy, sessions: { advisoryTokens: 300000, limitTokens: 400000 }, compaction: { auto: true, autoTokens: 300000 } }),
  'user-chosen-tokens-kept': json({ ...minimalLegacy, sessions: { advisoryTokens: 250000, limitTokens: 333333 }, compaction: { auto: true, autoTokens: 250000 } }),
  'superseded-goal-prompts': withPatch((c) => {
    c.goal.prompt = goal.SUPERSEDED_GOAL_SYSTEM_PROMPTS[0];
    c.goal.objectivePrompt = goal.SUPERSEDED_GOAL_OBJECTIVE_SYSTEM_PROMPTS.at(-1);
    c.goal.loopPrompt = goal.SUPERSEDED_GOAL_LOOP_SYSTEM_PROMPTS[0];
    c.goal.helperModel = SUPERSEDED_HELPER_CHAT_MODELS[0];
  }),
  'customized-goal-prompts-kept': withPatch((c) => {
    c.goal.prompt = `${goal.SUPERSEDED_GOAL_SYSTEM_PROMPTS[0]}!`;
    c.goal.helperModel = 'gpt-5.6-sol-custom';
  }),
  'roots-reserved-and-duplicate': withPatch((c) => {
    c.roots = [
      { name: 'skills', path: 'C:\\a' }, { name: 'skills-folder', path: 'C:\\b' }, { name: 'docs', path: 'C:\\c' },
      { name: 'docs', path: 'C:\\d' }, { name: 'docs-2', path: 'C:\\e' }, { name: 'a'.repeat(32), path: 'C:\\f' },
      { name: 'a'.repeat(32), path: 'C:\\g' }, { name: 'skills', path: 'C:\\h', extra: 1 }
    ];
  }),
  'repairable-fields': withPatch((c) => {
    c.connectorSuffix = 'bad/suffix';
    c.ui.appearance = { light: 1 };
    c.ui.defaultChatModel = '   ';
    c.ui.defaultChatReasoning = 'galaxy';
    c.ui.lastSeenVersion = 'x'.repeat(41);
    c.ui.backgroundPlacement = 'tab';
    c.compaction.handoffPrompt = '   ';
    c.compaction.handoffLength = 'huge';
    c.goal.impulseMinutes = 99;
    c.goal.helperModel = 5;
    c.goal.helperReasoning = 'turbo';
    c.goal.mode = 'sprint';
    c.goal.reasoning = 'ultra';
    c.goal.provider = { kind: 'azure', baseUrl: 'https://example.invalid' };
    c.goal.model = '   ';
    c.goal.prompt = '  ';
    c.goal.objectivePrompt = 7;
    c.goal.loopPrompt = 'x'.repeat(20001);
    c.mcp = 'nope';
    c.controlApi = { enabled: false, allowActions: true };
  }),
  'trimmed-and-sliced-text': withPatch((c) => {
    c.connectorSuffix = '  Büro PC 2  ';
    c.tunnel.profileName = '  Home  ';
    c.ui.defaultChatModel = '  gpt-6  ';
    c.goal.model = '  vendor/model  ';
    c.goal.prompt = '  keep going  ';
    c.compaction.handoffPrompt = '\n summarize \n';
    c.mcp.instructions = `  ${'é'.repeat(3990)}${' '.repeat(20)}tail`;
  }),
  'control-api-bad-allow-actions': withPatch((c) => { c.controlApi = { enabled: true, allowActions: 'yes' }; }),
  'control-api-not-object': withPatch((c) => { c.controlApi = null; }),
  'unknown-keys-dropped': withPatch((c) => {
    c.futureSection = { on: true };
    c.ui.futureSwitch = true;
    c.goal.provider.futureField = 1;
    c.roots = [{ name: 'proj', path: 'C:\\proj', label: 'x' }];
  }),
  'integral-floats': withPatch((c) => { c.sessions.advisoryTokens = 300000.0; c.multiAgent.maxWorkers = 3.0; }),
  'capabilities-array': withPatch((c) => { c.capabilities = []; }),
  'capabilities-partial': withPatch((c) => { c.capabilities = { browse: false, command: false, powershell: true }; }),
  'sections-missing': json({ roots: [], capabilities: {}, readOnly: true, tunnel: { kind: 'manual', tunnelId: 'x', binaryPath: '' }, ui: { minimizeToTray: false, autoConnect: true } }),
  'bridge-port-fixed': withPatch((c) => { c.ui.browserBridgePort = 8767; }),
  'setup-profiles-valid': withPatch((c) => {
    c.setupProfiles = [{ id: 'work', name: ' Work ', tunnelId: '', desktopTunnelId: '', pluginsTunnelId: '', note: 'x' }];
  }),
  'reject-roots-not-array': withPatch((c) => { c.roots = 7; }),
  'reject-root-name': withPatch((c) => { c.roots = [{ name: 'Docs', path: 'C:\\docs' }]; }),
  'reject-root-path-short': withPatch((c) => { c.roots = [{ name: 'docs', path: 'C' }]; }),
  'reject-read-only-missing': withPatch((c) => { delete c.readOnly; }),
  'reject-capabilities-null': withPatch((c) => { c.capabilities = null; }),
  'reject-capability-not-boolean': withPatch((c) => { c.capabilities.read = 'yes'; }),
  'reject-tunnel-kind': withPatch((c) => { c.tunnel.kind = 'ngrok'; }),
  'reject-language': withPatch((c) => { c.ui.language = 'tlh'; }),
  'reject-optional-null': withPatch((c) => { c.ui.developerMode = null; }),
  'reject-ui-missing-switch': withPatch((c) => { delete c.ui.autoConnect; }),
  'reject-duplicate-setup-profiles': withPatch((c) => {
    c.setupProfiles = [1, 2].map(() => ({ id: 'same', name: 'Same', tunnelId: '', desktopTunnelId: '', pluginsTunnelId: '' }));
  }),
  'reject-goal-model-number': withPatch((c) => { c.goal.model = 5; }),
  'reject-goal-provider-null': withPatch((c) => { c.goal.provider = null; }),
  'reject-tokens-out-of-range': withPatch((c) => { c.sessions.limitTokens = 5; }),
  'reject-fractional-int': withPatch((c) => { c.multiAgent.maxWorkers = 2.5; }),
  'reject-command-rule': withPatch((c) => { c.commandAllowlist = { enabled: true, mode: 'allow', rules: ['git status | grep x'] }; }),
  'command-rules-valid': withPatch((c) => { c.commandAllowlist = { enabled: true, rules: ['git status', "npm 'run test' *", '  cargo   test  '] }; }),
  'reject-appearance-not-repairable-chat-browser': withPatch((c) => { c.ui.chatBrowser = 'firefox'; })
};

for (const name of readdirSync(typesFixtures).filter((file) => /^config\.\d+\.json$/.test(file)).sort()) {
  cases[`cos-types-${name.replace(/\.json$/, '')}`] = readFileSync(path.join(typesFixtures, name));
}

it('records the shipped defaults', async () => {
  const folder = path.join(dir, 'recovery-probe');
  await fs.mkdir(folder, { recursive: true });
  writeFileSync(path.join(folder, 'config.json'), '{', 'utf8');
  const { initConfigPath, loadConfig } = await freshConfigModule();
  initConfigPath(folder);
  const shipped = {
    firstLaunch: { windows: defaultConfig('win32'), macos: defaultConfig('darwin'), linux: defaultConfig('linux') },
    recovery: await loadConfig(),
    superseded: {
      goalPrompt: goal.SUPERSEDED_GOAL_SYSTEM_PROMPTS,
      objectivePrompt: goal.SUPERSEDED_GOAL_OBJECTIVE_SYSTEM_PROMPTS,
      loopPrompt: goal.SUPERSEDED_GOAL_LOOP_SYSTEM_PROMPTS,
      helperModel: SUPERSEDED_HELPER_CHAT_MODELS
    }
  };
  mkdirSync(path.dirname(SHIPPED_PATH), { recursive: true });
  writeFileSync(SHIPPED_PATH, `${JSON.stringify(shipped, null, 2)}\n`, 'utf8');
});

it('records config loads', async () => {
  const results: Record<string, unknown> = {};
  for (const [name, input] of Object.entries(cases)) {
    const folder = path.join(dir, name);
    await fs.mkdir(folder, { recursive: true });
    const file = path.join(folder, 'config.json');
    const directory = input !== null && typeof input === 'object' && 'directory' in input;
    if (directory) await fs.mkdir(file);
    else if (input !== null) writeFileSync(file, input);
    const { getConfig, initConfigPath, loadConfig, saveConfig, settingsRecovered } = await freshConfigModule();
    initConfigPath(folder);
    const loaded = structuredClone(await loadConfig());
    const recovered = settingsRecovered();
    const kept = readdirSync(folder).filter((entry) => entry.startsWith('config.json.unreadable-'));
    let saved: unknown = null;
    if (!directory) {
      await saveConfig(getConfig());
      saved = contents(readFileSync(file));
    }
    results[name] = {
      input: input === null ? null : directory ? { directory: true } : contents(Buffer.isBuffer(input) ? input : Buffer.from(input as string, 'utf8')),
      loaded,
      recovered,
      keptUnreadableCopy: kept.length === 1 ? contents(readFileSync(path.join(folder, kept[0]!))) : null,
      saved
    };
  }
  record('config-load', { appVersion: APP_VERSION, platform: process.platform, cases: results });
});
