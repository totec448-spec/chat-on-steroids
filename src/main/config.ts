/**
 * Non-secret settings, stored as one small JSON file in the app's userData folder.
 * No database: there are at most a handful of roots and a dozen booleans.
 *
 * Everything read from disk is re-validated, because a hand-edited or corrupted file
 * must not be able to widen permissions or smuggle in a root that was never approved.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  CAPABILITIES,
  DEFAULT_CAPABILITIES,
  GOAL_REASONING_LEVELS,
  WRITE_CAPABILITIES,
  type Capabilities,
  type CompactionSettings,
  type Config,
  type GoalSettings,
  type MultiAgentSettings,
  type Root,
  type SessionSettings
} from '../shared/types.js';
import {
  DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT,
  DEFAULT_GOAL_SYSTEM_PROMPT,
  MAX_GOAL_SYSTEM_PROMPT_CHARS,
  SUPERSEDED_GOAL_SYSTEM_PROMPTS
} from '../shared/goal.js';
import { logError } from './logger.js';
import { RESERVED_ROOT_NAMES } from './sandbox.js';
import { capabilitiesForPlatform } from './platform.js';

/**
 * Defaults for the newer sections, in one place so the schema and defaultConfig()
 * cannot drift apart.
 *
 * Recording starts ON. Everything the app is actually for — the readable timeline, Compact
 * & resume, and agent attribution — reads the recorded history, so an install that starts
 * with it off is an install where the main features silently do nothing. It writes only to
 * this app's own data folder and uploads nothing. Note this changes the default for *new*
 * configs only: an existing config already carries an explicit `record`, and a user who
 * turned it off keeps it off.
 *
 * Existing configs still keep every explicit permission choice. Fresh installs are different:
 * the Home screen is meant to start fully usable, so every tool permission and the agents
 * surface begin enabled. The migration defaults below remain conservative so an upgrade never
 * widens an older config merely because a field did not exist when that config was written.
 */
/**
 * Where the pressure meter turns amber and red.
 *
 * These are measured in *this app's* units — `estimateTokens`, four characters to a token,
 * over the events it kept — and not in whatever ChatGPT counts. The two are not the same
 * number and never will be: the app cannot see the system prompt, the memory, the file
 * attachments or the model's own reasoning, and ChatGPT's counter is private.
 *
 * So the thresholds are calibrated against observed behaviour rather than a published
 * context window. The first pair (180k/200k) was set from the published figure, and a real
 * session then ran past 400k of these units before ChatGPT would take no more — meaning the
 * meter had been demanding a compaction since roughly the halfway mark, for hours, on a
 * chat that was fine. A warning that cries wolf at half the real capacity is a warning
 * people learn to click past, which costs more than having no warning at all.
 *
 * 300k/400k put the amber line where there was still comfortable room to compact and the
 * red line at the point that had actually been seen to fail. In use that was still early:
 * chats sat amber and compacted themselves well before anything was wrong with them, and a
 * threshold that fires on a conversation that is fine costs a fresh chat every time. The
 * window is 400k now, at the figure the ceiling has actually been observed near, and the
 * red line follows it a third further on.
 *
 * All of it remains a setting, because the real ceiling moves with the account, the model
 * and the size of what is attached.
 */
const DEFAULT_CONTEXT_WINDOW = 400_000;
const DEFAULT_SESSIONS: SessionSettings = {
  record: true,
  retainDays: 30,
  advisoryTokens: DEFAULT_CONTEXT_WINDOW,
  // Derived, never typed. The Chat panel writes `limit = threshold × 4/3` on every save,
  // so a default that did not already satisfy that relation would be a state the UI cannot
  // produce: the red line would move the first time anyone opened the panel and saved.
  limitTokens: Math.round((DEFAULT_CONTEXT_WINDOW * 4) / 3)
};

/**
 * The 1.7.1 recalibration, applied once to configs that never chose their own numbers.
 *
 * Raising a default only helps a fresh install: every existing config was written with the
 * old figures spelled out, so it would keep the too-early warning forever. A stored pair
 * that is *exactly* the old defaults was never a decision — it is what the app wrote for
 * itself — so it moves. Anything else the user typed, and it stays put.
 */
const OLD_TOKEN_DEFAULTS = [
  { advisoryTokens: 180_000, limitTokens: 200_000 },
  { advisoryTokens: 300_000, limitTokens: 400_000 }
];
const DEFAULT_COMPACTION: CompactionSettings = {
  // On, at the advisory line.
  //
  // Automatic compaction is edge-triggered since 1.8: an old chat that merely opens above
  // this number does nothing. That is what makes the advisory line usable as the trigger —
  // the crossing turn still finishes and still writes its handoff, rather than the app
  // waiting for a chat that is already over the line and compacting it on sight.
  auto: true,
  autoTokens: DEFAULT_SESSIONS.advisoryTokens
};
/**
 * The goal loop's defaults.
 *
 * Off, because it types into somebody's chat on its own and because it cannot work at all
 * until an OpenRouter API key exists. The model is a starting point rather than a
 * recommendation: the Chat settings picker lists what OpenRouter actually publishes,
 * newest first, and whatever is chosen there is stored here verbatim.
 */
/**
 * The `~` prefix is OpenRouter's marker for a family alias: this one always resolves to the
 * newest DeepSeek V4 Flash, so the default does not quietly rot into a snapshot from months
 * ago the way a pinned id does. `deepseek/deepseek-v4-flash` was such a pin — it reads like
 * "the flash model" but OpenRouter publishes it as V4 Flash 0423, and by August there were
 * two newer revisions the default would never have reached. The alias is also the cheaper
 * of the two: $0.04/M prompt against the pin's $0.057/M.
 */
export const DEFAULT_GOAL_MODEL = '~deepseek/deepseek-v4-flash-latest';
const DEFAULT_GOAL: GoalSettings = {
  enabled: false,
  model: DEFAULT_GOAL_MODEL,
  reasoning: 'default',
  prompt: DEFAULT_GOAL_SYSTEM_PROMPT,
  objectivePrompt: DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT
};
// Two workers, not three: three concurrent workers reproducibly trips ChatGPT's rate limit
// ("too many requests"), which strands the run rather than making it faster.
const DEFAULT_MULTI_AGENT: MultiAgentSettings = { enabled: false, maxWorkers: 2 };
/** Fresh-install exposure. Kept separate from migration defaults on purpose. */
const ALL_FIRST_LAUNCH_CAPABILITIES: Capabilities = Object.fromEntries(
  CAPABILITIES.map((capability) => [capability, true])
) as Capabilities;
const FIRST_LAUNCH_MULTI_AGENT: MultiAgentSettings = { enabled: true, maxWorkers: DEFAULT_MULTI_AGENT.maxWorkers };

const rootSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Root names are lowercase letters, digits, dot, dash, underscore'),
  path: z.string().min(2).max(4096)
});

/**
 * Repairs root names from older/hand-edited configs without ever publishing an ambiguous
 * virtual namespace. Reserved names and duplicates are renamed deterministically in input
 * order, preserving the first usable spelling and suffixing later collisions.
 */
function uniqueStoredRoots(roots: Root[]): Root[] {
  const used = new Set<string>();
  const nextFree = (wanted: string): string => {
    const reserved = RESERVED_ROOT_NAMES.has(wanted);
    const base = reserved ? `${wanted}-folder` : wanted;
    let candidate = base.slice(0, 32);
    for (let suffix = 2; RESERVED_ROOT_NAMES.has(candidate) || used.has(candidate); suffix++) {
      const tail = `-${suffix}`;
      candidate = `${base.slice(0, Math.max(1, 32 - tail.length))}${tail}`;
    }
    return candidate;
  };
  return roots.map((root) => {
    const name = nextFree(root.name);
    used.add(name);
    return name === root.name ? root : { ...root, name };
  });
}

/**
 * Migrates configs written before the tools were consolidated.
 *
 * `powershell` and `command` used to be one tool each and are now the single
 * `exec_command`, so a user who had granted only PowerShell keeps the ability they
 * chose. `deleteFolder` is dropped rather than folded into `deleteFile`: they were never
 * the same permission, and quietly turning one into the other would widen what the user
 * approved. Both keys are removed afterwards so the file stops carrying dead permissions.
 */
function migrateCapabilities(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const caps = { ...(value as Record<string, unknown>) };
  if (caps['powershell'] === true) caps['command'] = true;
  delete caps['powershell'];
  delete caps['deleteFolder'];
  return caps;
}

// Missing capability keys are filled from safe defaults so adding a new optional
// permission in an update never resets an existing user's folders/tunnel settings.
const capabilitiesSchema = z
  .preprocess(
    migrateCapabilities,
    z.object(
      Object.fromEntries(CAPABILITIES.map((c) => [c, z.boolean().optional()])) as Record<
        (typeof CAPABILITIES)[number],
        z.ZodOptional<z.ZodBoolean>
      >
    )
  )
  .transform((caps) => ({ ...DEFAULT_CAPABILITIES, ...caps }) as Capabilities);

const configSchema = z.object({
  // A config written by hand — or by a build before `/skills` was reserved — must not be
  // able to claim a reserved virtual root. Renamed rather than rejected: a single bad root
  // name is not a reason to throw away the whole config and every other approved folder.
  roots: z
    .array(rootSchema)
    .max(32)
    .transform(uniqueStoredRoots),
  capabilities: capabilitiesSchema,
  readOnly: z.boolean(),
  tunnel: z.object({
    kind: z.enum(['openai', 'cloudflared', 'manual']),
    tunnelId: z.string().max(128),
    // Optional with an empty default, so a config written before the connector split
    // loads unchanged and simply has no Desktop tunnel yet — which is also the correct
    // state for it, since the user has not created that connector in ChatGPT either.
    desktopTunnelId: z.string().max(128).optional().default(''),
    binaryPath: z.string().max(4096)
  }),
  ui: z.object({
    minimizeToTray: z.boolean(),
    autoConnect: z.boolean(),
    privacyScreenshots: z.boolean().optional().default(false),
    // Dark is the design the app is drawn for, and a config written before the theme
    // existed has no stored answer to override — so it is the default rather than the
    // fallback. An explicit `light` is somebody's own choice and is never touched.
    theme: z.enum(['light', 'dark']).optional().default('dark')
  }),
  // Whole sections are optional, so a config written by an older build keeps working
  // and simply gains the new features switched off. The default object is spelled out
  // rather than left as {} because zod 4 returns a default as-is instead of parsing it.
  sessions: z
    .object({
      record: z.boolean().optional().default(DEFAULT_SESSIONS.record),
      retainDays: z.number().int().min(0).max(3650).optional().default(DEFAULT_SESSIONS.retainDays),
      advisoryTokens: z
        .number()
        .int()
        .min(10_000)
        .max(4_000_000)
        .optional()
        .default(DEFAULT_SESSIONS.advisoryTokens),
      limitTokens: z.number().int().min(10_000).max(4_000_000).optional().default(DEFAULT_SESSIONS.limitTokens)
    })
    .optional()
    .default({ ...DEFAULT_SESSIONS }),
  compaction: z
    .object({
      auto: z.boolean().optional().default(DEFAULT_COMPACTION.auto),
      // The floor is high enough that the threshold cannot be set somewhere a fresh chat
      // is already past, which would compact every conversation the moment it started.
      autoTokens: z
        .number()
        .int()
        .min(10_000)
        .max(4_000_000)
        .optional()
        .default(DEFAULT_COMPACTION.autoTokens)
    })
    .optional()
    .default({ ...DEFAULT_COMPACTION }),
  multiAgent: z
    .object({
      enabled: z.boolean().optional().default(DEFAULT_MULTI_AGENT.enabled),
      maxWorkers: z.number().int().min(1).max(8).optional().default(DEFAULT_MULTI_AGENT.maxWorkers)
    })
    .optional()
    .default({ ...DEFAULT_MULTI_AGENT }),
  // An empty model id is repaired rather than rejected: the id is free text from a
  // provider listing that changes weekly, and a config that lost it must still load with
  // every root and permission in it intact.
  goal: z
    .object({
      enabled: z.boolean().optional().default(DEFAULT_GOAL.enabled),
      model: z
        .string()
        .max(160)
        .optional()
        .default(DEFAULT_GOAL.model)
        .transform((model) => (model.trim() === '' ? DEFAULT_GOAL.model : model.trim())),
      // Repaired for the same reason, and one this section is specifically exposed to: the
      // set of levels is a provider's vocabulary, so a config written by a version that
      // knows one more of them than this one does is a config this app will meet. Rejecting
      // it would send the whole file — every root, every permission — through conservative
      // recovery over a word in one field nobody would miss.
      reasoning: z
        .enum(GOAL_REASONING_LEVELS)
        .optional()
        .default(DEFAULT_GOAL.reasoning)
        .catch(DEFAULT_GOAL.reasoning),
      // Existing configs predate the editor, and a hand-edited blank prompt must not turn
      // Goal Mode into an unconstrained continuation model. Both adopt the strong default.
      prompt: z
        .string()
        .max(MAX_GOAL_SYSTEM_PROMPT_CHARS)
        .optional()
        .default(DEFAULT_GOAL.prompt)
        .transform((prompt) => (prompt.trim() === '' ? DEFAULT_GOAL.prompt : prompt.trim()))
        .catch(DEFAULT_GOAL.prompt),
      // Repaired exactly like `prompt` above, and for the same reason: a config predating the
      // second editor, or hand-edited to blank, must not leave the goal driver running with no
      // instruction at all. Both fall back to the shipped default rather than to emptiness.
      objectivePrompt: z
        .string()
        .max(MAX_GOAL_SYSTEM_PROMPT_CHARS)
        .optional()
        .default(DEFAULT_GOAL.objectivePrompt)
        .transform((prompt) =>
          prompt.trim() === '' ? DEFAULT_GOAL.objectivePrompt : prompt.trim()
        )
        .catch(DEFAULT_GOAL.objectivePrompt)
    })
    .optional()
    .default({ ...DEFAULT_GOAL })
});

export function defaultConfig(platform: NodeJS.Platform = process.platform): Config {
  return {
    roots: [],
    // Desktop permissions start usable on hosts with a native backend. Unsupported hosts mask
    // them at the platform boundary while preserving stored choices for a moved config.
    capabilities: capabilitiesForPlatform({ ...ALL_FIRST_LAUNCH_CAPABILITIES }, platform),
    readOnly: false,
    tunnel: { kind: 'openai', tunnelId: '', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'dark' },
    sessions: { ...DEFAULT_SESSIONS },
    compaction: { ...DEFAULT_COMPACTION },
    multiAgent: { ...FIRST_LAUNCH_MULTI_AGENT },
    goal: { ...DEFAULT_GOAL }
  };
}

/**
 * Recovery for a config file that exists but cannot be trusted.
 *
 * A missing file is a real first launch and intentionally gets the fully-enabled defaults
 * above. A malformed/corrupt existing file is different: treating damage as consent would
 * widen filesystem/desktop/process access merely because parsing failed. Keep that path on
 * the historical narrow capability set and read-only mode until the user saves settings again.
 */
function conservativeRecoveryConfig(): Config {
  return {
    ...defaultConfig(),
    capabilities: { ...DEFAULT_CAPABILITIES },
    readOnly: true,
    multiAgent: { ...DEFAULT_MULTI_AGENT },
    // A config file that could not be trusted is not consent to have a second model typing
    // into the user's chat, whatever the unreadable file said.
    goal: { ...DEFAULT_GOAL }
  };
}

/**
 * Repairs feature combinations that cannot work, without silently widening privacy settings.
 *
 * Goal Mode reads the local session transcript to decide whether another user turn is needed;
 * `/goal/draft` explicitly refuses a chat with no recorded session. Enabling recording behind
 * the user's back would be a privacy surprise, so the only safe repair is to keep recording off
 * and turn Goal off with it. Keeping this at the config boundary covers renderer, extension and
 * hand-edited/older config writers alike.
 */
function enforceFeatureDependencies(config: Config): Config {
  if (config.sessions.record || !config.goal.enabled) return config;
  return { ...config, goal: { ...config.goal, enabled: false } };
}

/**
 * Moves any exactly-as-shipped Goal prompt, from any past version, onto the current default.
 *
 * The prompt is editable and persisted, so changing the source constant alone would leave an
 * existing untouched install on the old behaviour forever. Exact equality is the fence: any
 * user customization, even a one-character change, is preserved verbatim. The list is walked
 * rather than compared against one predecessor, so an install that skipped a release still
 * migrates instead of being stranded on a default two generations old.
 */
function adoptCurrentGoalPrompt(config: Config): Config {
  if (!SUPERSEDED_GOAL_SYSTEM_PROMPTS.includes(config.goal.prompt)) return config;
  return { ...config, goal: { ...config.goal, prompt: DEFAULT_GOAL_SYSTEM_PROMPT } };
}

let configPath = '';
let current: Config = defaultConfig();
// Every UI mutation ultimately lands in the same tiny JSON file. Keep those
// read-modify-write transactions strictly ordered so two fast checkbox/root changes
// cannot race on config.json.tmp or overwrite each other's newer state.
let mutationQueue: Promise<void> = Promise.resolve();

export function initConfigPath(userDataDir: string): void {
  configPath = path.join(userDataDir, 'config.json');
}

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = configSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logError('Settings file was invalid and has been reset to defaults');
      current = conservativeRecoveryConfig();
    } else {
      current = enforceFeatureDependencies(
        adoptCurrentGoalPrompt(adoptWiderWindow(adoptAutoCompaction(recalibrateTokens(parsed.data))))
      );
      // Duplicate root names would make a virtual path ambiguous.
      const seen = new Set<string>();
      current.roots = current.roots.filter((r) => {
        const key = r.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logError(`Could not read settings: ${(err as Error).message}`);
      current = conservativeRecoveryConfig();
    } else {
      current = defaultConfig();
    }
  }
  return current;
}

/** Applies any superseded pair in OLD_TOKEN_DEFAULTS → DEFAULT_SESSIONS, untouched pairs only. */
function recalibrateTokens(config: Config): Config {
  const { advisoryTokens, limitTokens } = config.sessions;
  const untouched = OLD_TOKEN_DEFAULTS.some(
    (old) => advisoryTokens === old.advisoryTokens && limitTokens === old.limitTokens
  );
  if (!untouched) {
    return config;
  }
  return {
    ...config,
    sessions: {
      ...config.sessions,
      advisoryTokens: DEFAULT_SESSIONS.advisoryTokens,
      limitTokens: DEFAULT_SESSIONS.limitTokens
    }
  };
}

/**
 * What automatic compaction used to default to, for the same one-time move as above.
 *
 * A config written before 1.7.5 spells the old answer out, so raising the default alone
 * would only ever reach a fresh install. A stored pair that is *exactly* the old default
 * was never a decision — it is what the app wrote for itself — so it moves. Anything the
 * user actually chose is left alone, including switching it off on purpose, which is why
 * `auto: true` with the old threshold is not touched: that is somebody's own setting.
 */
const OLD_AUTO_DEFAULTS = { auto: false, autoTokens: 300_000 };

function adoptAutoCompaction(config: Config): Config {
  const { auto, autoTokens } = config.compaction;
  if (auto !== OLD_AUTO_DEFAULTS.auto || autoTokens !== OLD_AUTO_DEFAULTS.autoTokens) return config;
  return {
    ...config,
    compaction: { ...config.compaction, auto: DEFAULT_COMPACTION.auto, autoTokens: DEFAULT_COMPACTION.autoTokens }
  };
}

/**
 * The 1.8 automatic default, moved up with the window.
 *
 * This is the third time a stored number that was never chosen has had to follow a default,
 * and it is the one case where the file's own rule is uncomfortable. `adoptAutoCompaction`
 * above deliberately leaves `auto: true` at the old threshold alone, on the grounds that
 * switching it on was a decision — but that was written when `auto: false` was the shipped
 * default. Since 1.8 the app writes `auto: true` at 300k for itself, so the two populations
 * are no longer distinguishable in the file, and the larger of them never decided anything.
 *
 * They move. A threshold that is any other number was typed by somebody and stays.
 *
 * There is no matching migration downward: 400k is what this now defaults to, so a config
 * that already holds it, whether from 1.7 or from a person, simply keeps it.
 */
const SUPERSEDED_AUTO_DEFAULTS = { auto: true, autoTokens: 300_000 };

function adoptWiderWindow(config: Config): Config {
  const { auto, autoTokens } = config.compaction;
  if (auto !== SUPERSEDED_AUTO_DEFAULTS.auto || autoTokens !== SUPERSEDED_AUTO_DEFAULTS.autoTokens) return config;
  return {
    ...config,
    compaction: { ...config.compaction, autoTokens: DEFAULT_COMPACTION.autoTokens }
  };
}

export function getConfig(): Config {
  return current;
}

/**
 * Read-only mode is enforced here as well as at the tool layer, so the effective
 * capability set can never disagree with what the UI shows.
 */
export function effectiveCapabilities(config: Config, platform: NodeJS.Platform = process.platform): Capabilities {
  const live = capabilitiesForPlatform(config.capabilities, platform);
  if (!config.readOnly) return live;
  // Derived from WRITE_CAPABILITIES rather than listed again here, so adding a new
  // writing capability cannot accidentally leave it enabled in read-only mode.
  const capped = { ...live };
  for (const capability of WRITE_CAPABILITIES) capped[capability] = false;
  return capped;
}

async function persistConfig(next: Config): Promise<Config> {
  const parsed = enforceFeatureDependencies(configSchema.parse(next));
  const tmp = `${configPath}.tmp`;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), 'utf8');
  await fs.rename(tmp, configPath);
  // Only publish the new in-memory state after the durable write succeeded. A disk
  // error must not leave the UI believing settings were saved when they were not.
  current = parsed;
  return current;
}

/**
 * Atomically updates settings from the latest committed state.
 *
 * The callback itself runs inside the queue. This matters more than merely queuing the
 * final file write: a root change and a permission change that start at the same time
 * must each see the result of the one ahead of it instead of composing two stale full
 * Config objects and letting the later write silently erase the earlier change.
 */
export function updateConfig(
  update: (latest: Config) => Config | Promise<Config>
): Promise<Config> {
  const operation = mutationQueue.then(async () => persistConfig(await update(current)));
  mutationQueue = operation.then(
    () => undefined,
    () => undefined
  );
  return operation;
}

/** Replaces the complete config. Prefer updateConfig for read-modify-write changes. */
export function saveConfig(next: Config): Promise<Config> {
  return updateConfig(() => next);
}
