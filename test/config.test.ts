import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_GOAL_MODEL,
  defaultConfig,
  initConfigPath,
  loadConfig,
  saveConfig,
  updateConfig
} from '../src/main/config.js';
import { DESKTOP_CAPABILITIES, type Capability } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;

beforeAll(async () => {
  dir = await makeTempDir('clf-config-');
  initConfigPath(dir);
});

afterAll(async () => {
  await removeTempDir(dir);
});

describe('settings migration', () => {
  it('never leaves Goal enabled while session recording is off', async () => {
    const impossible = {
      ...defaultConfig(),
      sessions: { ...defaultConfig().sessions, record: false },
      goal: { ...defaultConfig().goal, enabled: true }
    };

    // Every writer goes through saveConfig/updateConfig, including the renderer and extension.
    const saved = await saveConfig(impossible);
    expect(saved.sessions.record).toBe(false);
    expect(saved.goal.enabled).toBe(false);

    // Hand-edited or older persisted state gets the same privacy-preserving repair on load:
    // Goal turns off rather than silently turning recording back on.
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(impossible), 'utf8');
    const loaded = await loadConfig();
    expect(loaded.sessions.record).toBe(false);
    expect(loaded.goal.enabled).toBe(false);
  });

  it('preserves old settings when new safe-default capabilities and UI prefs are added', async () => {
    const oldConfig = {
      roots: [{ name: 'project', path: 'C:\\Users\\example\\project' }],
      capabilities: {
        browse: true,
        search: true,
        read: true,
        metadata: true,
        create: true,
        edit: true,
        move: false,
        deleteFile: false,
        powershell: true,
        command: true,
        screen: true,
        control: true
      },
      readOnly: false,
      tunnel: {
        kind: 'openai',
        tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
        binaryPath: ''
      },
      ui: { minimizeToTray: true, autoConnect: true }
    };
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(oldConfig), 'utf8');

    const loaded = await loadConfig();
    expect(loaded.roots).toEqual(oldConfig.roots);
    expect(loaded.capabilities.create).toBe(true);
    expect(loaded.capabilities.clipboardRead).toBe(false);
    expect(loaded.capabilities.clipboardWrite).toBe(false);
    expect(loaded.ui.autoConnect).toBe(true);
    expect(loaded.ui.privacyScreenshots).toBe(false);
    // The one tunnel id a pre-split config had is Core's, because Core is the connector
    // the app cannot work without. Desktop is a second, optional tunnel that starts empty
    // rather than inheriting Core's id — publishing Core twice would be worse than not
    // publishing Desktop at all.
    expect(loaded.tunnel.tunnelId).toBe(oldConfig.tunnel.tunnelId);
    expect(loaded.tunnel.desktopTunnelId).toBe('');
  });

  it('folds a PowerShell-only permission into the single command permission', async () => {
    // `powershell` and `command` were one tool each and are now the single exec_command.
    // A user who had granted only PowerShell keeps the ability they chose; the dead key
    // does not survive into the saved config.
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({
        ...defaultConfig(),
        capabilities: {
          ...defaultConfig().capabilities,
          command: false,
          deleteFile: false,
          powershell: true,
          deleteFolder: true
        }
      }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.capabilities.command).toBe(true);
    expect(Object.keys(loaded.capabilities)).not.toContain('powershell');
    // `deleteFolder` is dropped rather than folded into deleteFile: they were never the
    // same permission, and turning one into the other would widen what the user approved.
    expect(Object.keys(loaded.capabilities)).not.toContain('deleteFolder');
    expect(loaded.capabilities.deleteFile).toBe(false);
  });

  it('renames a saved root that claims a reserved virtual namespace', async () => {
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...defaultConfig(), roots: [{ name: 'skills', path: 'C:\\Users\\example\\skills' }] }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.roots[0]?.name).toBe('skills-folder');
    expect(loaded.roots[0]?.path).toBe('C:\\Users\\example\\skills');
  });

  it('keeps reserved-name migration from creating duplicate virtual roots', async () => {
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({
        ...defaultConfig(),
        roots: [
          { name: 'skills-folder', path: 'C:\\Users\\example\\already-there' },
          { name: 'skills', path: 'C:\\Users\\example\\legacy-skills' },
          { name: 'skills-folder', path: 'C:\\Users\\example\\duplicate' }
        ]
      }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.roots.map((root) => root.name)).toEqual(['skills-folder', 'skills-folder-2', 'skills-folder-3']);
    expect(new Set(loaded.roots.map((root) => root.name)).size).toBe(loaded.roots.length);
  });

  it('round-trips a second tunnel id for the Desktop connector', async () => {
    const config = defaultConfig();
    await saveConfig({
      ...config,
      tunnel: {
        ...config.tunnel,
        tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
        desktopTunnelId: 'tunnel_fedcba9876543210fedcba9876543210'
      }
    });
    const loaded = await loadConfig();
    expect(loaded.tunnel.tunnelId).toBe('tunnel_0123456789abcdef0123456789abcdef');
    expect(loaded.tunnel.desktopTunnelId).toBe('tunnel_fedcba9876543210fedcba9876543210');
  });

  /**
   * Automatic compaction ends the chat the user is working in and opens a fresh one, and it
   * used to start off on the grounds that this is not something to do to somebody who never
   * asked for it. In use that reasoning turned out to be backwards: the alternative to
   * compacting is hitting the ceiling mid-thought and losing the thread entirely, which is
   * the worse thing to have happen to somebody who never asked for it. Since 1.8 the trigger
   * is edge-based rather than "currently above the line", so the advisory line is safe as
   * the default and still leaves room to finish the crossing turn and write the handoff.
   */
  it('starts with automatic compaction on at the advisory line', async () => {
    await saveConfig(defaultConfig());
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(true);
    expect(loaded.compaction.autoTokens).toBe(loaded.sessions.advisoryTokens);
    expect(loaded.compaction.autoTokens).toBe(400_000);
  });

  /**
   * The Chat panel offers one number and derives the red line from it, `limit = threshold ×
   * 4/3`. A shipped default that does not already satisfy that relation is a state the UI
   * cannot produce, and it would not survive contact with it: the first save of anything at
   * all in that panel would silently move the red line. So the defaults have to agree with
   * the arithmetic the panel does, which is what this pins.
   */
  it('ships a red line the settings panel would have derived itself', async () => {
    const config = defaultConfig();
    expect(config.sessions.advisoryTokens).toBe(config.compaction.autoTokens);
    expect(config.sessions.limitTokens).toBe(Math.round((config.compaction.autoTokens * 4) / 3));
  });

  /**
   * The migration, and the line it must not cross. A config still carrying both old
   * defaults never had a decision made about it, so it moves to the new one. A config
   * carrying anything else is somebody's own setting and is left exactly as it is.
   */
  it('moves an untouched old default onto the new one', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: false, autoTokens: 300_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(true);
    expect(loaded.compaction.autoTokens).toBe(400_000);
  });

  /**
   * The window moved to 400k, and the number that has to follow it is the one the app wrote
   * for itself. Since 1.8 that is `auto: true` at 300k — the shipped default, in every config
   * written by every install that never opened the panel. Raising the default alone would
   * reach a fresh install and nothing else, which is the whole reason this file has
   * migrations at all.
   */
  it('moves the untouched 1.8 automatic default up to the wider window', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: true, autoTokens: 300_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction).toMatchObject({ auto: true, autoTokens: 400_000 });
  });

  /** And nothing moves back down: 400k is the default now, however a config came to hold it. */
  it('leaves a config already at the wider window alone', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: true, autoTokens: 400_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction).toMatchObject({ auto: true, autoTokens: 400_000 });
  });

  /**
   * The meter's own pair, migrated on the same rule. 300k/400k is what 1.8 wrote for itself,
   * so it follows the window; anything else in either slot was typed and stays.
   */
  it('recalibrates an untouched meter pair and leaves a chosen one', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, sessions: { ...config.sessions, advisoryTokens: 300_000, limitTokens: 400_000 } });
    const moved = await loadConfig();
    expect(moved.sessions.advisoryTokens).toBe(400_000);
    expect(moved.sessions.limitTokens).toBe(Math.round((400_000 * 4) / 3));

    await saveConfig({ ...config, sessions: { ...config.sessions, advisoryTokens: 300_000, limitTokens: 350_000 } });
    const kept = await loadConfig();
    expect(kept.sessions).toMatchObject({ advisoryTokens: 300_000, limitTokens: 350_000 });
  });

  it('leaves a user who turned automatic compaction off turned off', async () => {
    const config = defaultConfig();
    // Off, but at a threshold they chose: that is a decision, not an untouched default.
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: false, autoTokens: 250_000 } });
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(false);
    expect(loaded.compaction.autoTokens).toBe(250_000);
  });

  it('keeps an automatic compaction the user configured', async () => {
    const config = defaultConfig();
    await saveConfig({
      ...config,
      compaction: { ...config.compaction, auto: true, autoTokens: 150_000 }
    });
    const loaded = await loadConfig();
    expect(loaded.compaction).toMatchObject({ auto: true, autoTokens: 150_000 });
  });

  it('keeps the meter threshold aligned with a high automatic-compaction threshold', async () => {
    const config = defaultConfig();
    await saveConfig({
      ...config,
      sessions: { ...config.sessions, advisoryTokens: 3_000_000, limitTokens: 4_000_000 },
      compaction: { ...config.compaction, auto: true, autoTokens: 3_000_000 }
    });
    const loaded = await loadConfig();
    expect(loaded.compaction.autoTokens).toBe(3_000_000);
    expect(loaded.sessions.advisoryTokens).toBe(3_000_000);
    expect(loaded.sessions.limitTokens).toBe(4_000_000);
  });

  /**
   * A config written before these fields existed gets the current defaults, like any other
   * absent field: absent is not a decision, so it reads as whatever the app decides now.
   */
  it('reads a config from before the setting existed as the current default', async () => {
    const config = defaultConfig();
    const older = { ...config, compaction: { ...config.compaction } } as Record<string, any>;
    delete older.compaction.auto;
    delete older.compaction.autoTokens;
    await saveConfig(older as ReturnType<typeof defaultConfig>);
    const loaded = await loadConfig();
    expect(loaded.compaction.auto).toBe(true);
    expect(loaded.compaction.autoTokens).toBe(400_000);
  });

  it('serializes concurrent read-modify-write changes instead of losing one', async () => {
    await saveConfig(defaultConfig());
    const first = updateConfig(async (config) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ...config, roots: [{ name: 'project', path: 'C:\\Users\\example\\project' }] };
    });
    const second = updateConfig((config) => ({
      ...config,
      ui: { ...config.ui, theme: 'dark' as const }
    }));
    await Promise.all([first, second]);

    const loaded = await loadConfig();
    expect(loaded.roots).toEqual([{ name: 'project', path: 'C:\\Users\\example\\project' }]);
    expect(loaded.ui.theme).toBe('dark');
  });
});

/** Fresh-install defaults, while migrations above prove existing choices stay narrow. */
describe('shipped defaults', () => {
  // Windows alone starts the Desktop group on. macOS has the backend but starts it off; the
  // user switches it on and grants Screen Recording / Accessibility. Linux has no backend.
  const expectedFreshCapability = (capability: Capability, platform: NodeJS.Platform): boolean =>
    platform === 'win32' || !DESKTOP_CAPABILITIES.includes(capability);

  it('records sessions from first launch', () => {
    expect(defaultConfig().sessions.record).toBe(true);
  });

  it('loads a genuinely missing config with every portable Core capability enabled', async () => {
    await fs.rm(path.join(dir, 'config.json'), { force: true });
    const loaded = await loadConfig();
    expect(loaded.readOnly).toBe(false);
    for (const [capability, enabled] of Object.entries(loaded.capabilities) as Array<[Capability, boolean]>) {
      expect(enabled, capability).toBe(expectedFreshCapability(capability, process.platform));
    }
    expect(loaded.multiAgent.enabled).toBe(true);
    expect(loaded.multiAgent.allowUnattributedCalls).toBe(true);
    expect(loaded.multiAgent.recoverAgentTabs).toBe(false);
  });

  it.each(['win32', 'darwin', 'linux'] as const)(
    'starts portable permissions on and Desktop automation on Windows only on %s',
    (platform) => {
      const config = defaultConfig(platform);
      expect(config.readOnly).toBe(false);
      for (const [capability, enabled] of Object.entries(config.capabilities) as Array<[Capability, boolean]>) {
        expect(enabled, `${platform}:${capability}`).toBe(expectedFreshCapability(capability, platform));
      }
      expect(config.multiAgent.enabled).toBe(true);
      expect(config.multiAgent.maxWorkers).toBe(2);
      expect(config.multiAgent.allowUnattributedCalls).toBe(true);
      expect(config.multiAgent.recoverAgentTabs).toBe(false);
    }
  );

  it('does not widen omitted permissions or agents exposure in an existing legacy config', async () => {
    const legacy = {
      roots: [],
      capabilities: { browse: true, search: true, read: true, metadata: true },
      readOnly: true,
      tunnel: { kind: 'openai', tunnelId: '', binaryPath: '' },
      ui: { minimizeToTray: true, autoConnect: false }
    };
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy), 'utf8');
    const loaded = await loadConfig();
    expect(loaded.capabilities.command).toBe(false);
    expect(loaded.capabilities.control).toBe(false);
    expect(loaded.multiAgent.enabled).toBe(false);
    expect(loaded.multiAgent.allowUnattributedCalls).toBe(false);
    expect(loaded.multiAgent.recoverAgentTabs).toBe(false);
    expect(loaded.readOnly).toBe(true);
  });

  it('does not turn config corruption into permission consent', async () => {
    await fs.writeFile(path.join(dir, 'config.json'), '{ definitely-not-json', 'utf8');
    const loaded = await loadConfig();
    expect(loaded.readOnly).toBe(true);
    expect(loaded.capabilities.command).toBe(false);
    expect(loaded.capabilities.control).toBe(false);
    expect(loaded.multiAgent.enabled).toBe(false);
  });

  /**
   * The default moved after this app had already shipped with recording off. Turning it on
   * underneath somebody who switched it off would be changing a privacy setting on their
   * behalf, so the new default is for configs that do not have the key at all.
   */
  it('leaves an existing choice to record alone', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, sessions: { ...config.sessions, record: false } });
    expect((await loadConfig()).sessions.record).toBe(false);
  });

  it('applies the new default to a config written before the setting existed', async () => {
    const before = defaultConfig() as unknown as Record<string, unknown>;
    const { sessions: _dropped, ...withoutSessions } = before;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(withoutSessions), 'utf8');
    expect((await loadConfig()).sessions.record).toBe(true);
  });

  /**
   * Save, close, reopen. The unattributed switch is on out of the box, so the only way to
   * see it off is to have turned it off — and that choice has to survive the next launch
   * rather than being handed back the fresh-install default on load.
   */
  it('keeps either unattributed choice across a save and reload', async () => {
    const config = defaultConfig();
    expect(config.multiAgent.allowUnattributedCalls).toBe(true);

    await saveConfig({
      ...config,
      multiAgent: { ...config.multiAgent, allowUnattributedCalls: false }
    });
    expect((await loadConfig()).multiAgent.allowUnattributedCalls).toBe(false);

    await saveConfig({
      ...config,
      multiAgent: { ...config.multiAgent, allowUnattributedCalls: true }
    });
    expect((await loadConfig()).multiAgent.allowUnattributedCalls).toBe(true);
  });
});

/**
 * The goal loop's settings.
 *
 * This is the one feature in this app that types into somebody's chat without being asked
 * each time, so what it defaults to — and what a damaged config falls back to — is a
 * consent question rather than a convenience one.
 */
describe('the goal loop settings', () => {
  it('is off out of the box', () => {
    const config = defaultConfig();
    expect(config.goal.enabled).toBe(false);
    expect(config.goal.model).toBe('z-ai/glm-5.3');
    expect(config.goal.reasoning).toBe('default');
    expect(config.goal.prompt).toContain('Your job is to prompt ChatGPT');
    expect(config.goal.prompt).toContain('Nobody handed you a separate goal');
    // The driver ships beside the gate rather than staying hardcoded, so a fresh install has
    // both editable instructions on disk and the settings screen has something to paint.
    expect(config.goal.objectivePrompt).toContain('Your job is to prompt ChatGPT');
    expect(config.goal.objectivePrompt).toContain('they have handed you the wheel');
  });

  it('keeps the model, reasoning level and system prompt that were chosen', async () => {
    const prompt = 'Custom continuation gate. Reply NO_REPLY when finished.';
    const objectivePrompt = 'Custom goal driver. Reply NO_REPLY once the goal is reached.';
    const loopPrompt = 'Custom loop. Always write the next message.';
    await saveConfig({
      ...defaultConfig(),
      goal: {
        ...defaultConfig().goal,
        enabled: true,
        mode: 'loop',
        model: 'openai/gpt-5.2-mini:nitro',
        reasoning: 'high',
        prompt,
        objectivePrompt,
        loopPrompt
      }
    });
    expect((await loadConfig()).goal).toEqual({
      enabled: true,
      mode: 'loop',
      model: 'openai/gpt-5.2-mini:nitro',
      reasoning: 'high',
      prompt,
      objectivePrompt,
      loopPrompt
    });
  });

  it('upgrades only the exact previous shipped prompt and preserves customized prompts', async () => {
    const { PREVIOUS_DEFAULT_GOAL_SYSTEM_PROMPT } = await import('../src/shared/goal.js');
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, prompt: PREVIOUS_DEFAULT_GOAL_SYSTEM_PROMPT } }),
      'utf8'
    );
    expect((await loadConfig()).goal.prompt).toBe(defaultConfig().goal.prompt);

    const customized = `${PREVIOUS_DEFAULT_GOAL_SYSTEM_PROMPT}\ncustom sentence`;
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, prompt: customized } }),
      'utf8'
    );
    expect((await loadConfig()).goal.prompt).toBe(customized);
  });

  /**
   * Migration compares against every default ever shipped, not just the one before this.
   *
   * The single-predecessor check this replaced stranded anyone who had skipped a release:
   * their untouched prompt matched neither the current default nor its immediate predecessor,
   * so it was mistaken for a customization and kept forever.
   */
  it('upgrades an untouched default from any earlier version, not just the last one', async () => {
    const { SUPERSEDED_GOAL_SYSTEM_PROMPTS } = await import('../src/shared/goal.js');
    const config = defaultConfig();
    for (const superseded of SUPERSEDED_GOAL_SYSTEM_PROMPTS) {
      await fs.writeFile(
        path.join(dir, 'config.json'),
        JSON.stringify({ ...config, goal: { ...config.goal, prompt: superseded } }),
        'utf8'
      );
      expect((await loadConfig()).goal.prompt).toBe(defaultConfig().goal.prompt);
    }
  });

  /**
   * The driver and the loop are persisted and editable exactly as the gate is.
   *
   * They were migrated by nothing at all until the requirements rewrite, so an install holding
   * either one verbatim would have kept a superseded instruction forever while the shipped
   * constant moved on — the same stranding the gate's list exists to prevent.
   */
  it('upgrades an untouched driver and loop prompt too, not only the gate', async () => {
    const { SUPERSEDED_GOAL_OBJECTIVE_SYSTEM_PROMPTS, SUPERSEDED_GOAL_LOOP_SYSTEM_PROMPTS } =
      await import('../src/shared/goal.js');
    const config = defaultConfig();

    for (const superseded of SUPERSEDED_GOAL_OBJECTIVE_SYSTEM_PROMPTS) {
      await fs.writeFile(
        path.join(dir, 'config.json'),
        JSON.stringify({ ...config, goal: { ...config.goal, objectivePrompt: superseded } }),
        'utf8'
      );
      expect((await loadConfig()).goal.objectivePrompt).toBe(defaultConfig().goal.objectivePrompt);
    }

    for (const superseded of SUPERSEDED_GOAL_LOOP_SYSTEM_PROMPTS) {
      await fs.writeFile(
        path.join(dir, 'config.json'),
        JSON.stringify({ ...config, goal: { ...config.goal, loopPrompt: superseded } }),
        'utf8'
      );
      expect((await loadConfig()).goal.loopPrompt).toBe(defaultConfig().goal.loopPrompt);
    }
  });

  it('keeps a customized driver or loop prompt that merely starts like a shipped one', async () => {
    const { SUPERSEDED_GOAL_OBJECTIVE_SYSTEM_PROMPTS, SUPERSEDED_GOAL_LOOP_SYSTEM_PROMPTS } =
      await import('../src/shared/goal.js');
    const config = defaultConfig();
    const objectivePrompt = `${SUPERSEDED_GOAL_OBJECTIVE_SYSTEM_PROMPTS[0]}\ncustom sentence`;
    const loopPrompt = `${SUPERSEDED_GOAL_LOOP_SYSTEM_PROMPTS[0]}\ncustom sentence`;
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, objectivePrompt, loopPrompt } }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.goal.objectivePrompt).toBe(objectivePrompt);
    expect(loaded.goal.loopPrompt).toBe(loopPrompt);
  });

  it('repairs a blank goal driver prompt to its shipped default', async () => {
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, objectivePrompt: '   ' } }),
      'utf8'
    );
    expect((await loadConfig()).goal.objectivePrompt).toBe(defaultConfig().goal.objectivePrompt);
  });

  /**
   * The id is free text from a provider listing that changes weekly. A config that lost it
   * still has every root and permission in it, and losing those to a blank string would be
   * a far worse failure than starting the picker back at its default.
   */
  it('repairs a blank model id rather than refusing the whole config', async () => {
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { enabled: true, model: '   ', reasoning: 'low' } }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.goal.model).toBe(DEFAULT_GOAL_MODEL);
    expect(loaded.goal.prompt).toBe(defaultConfig().goal.prompt);
    expect(loaded.goal.enabled).toBe(true);
    expect(loaded.roots).toEqual(config.roots);
  });

  it('adds the section to a config written before the loop existed', async () => {
    const before = defaultConfig() as unknown as Record<string, unknown>;
    const { goal: _dropped, ...withoutGoal } = before;
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(withoutGoal), 'utf8');
    expect((await loadConfig()).goal).toEqual({
      enabled: false,
      mode: 'goal',
      model: DEFAULT_GOAL_MODEL,
      reasoning: 'default',
      prompt: defaultConfig().goal.prompt,
      objectivePrompt: defaultConfig().goal.objectivePrompt,
      loopPrompt: defaultConfig().goal.loopPrompt
    });
  });

  /**
   * Loop is the mode that cannot stop on its own, so a blank instruction here would be an
   * unconstrained model typing into somebody's chat for ever. Repaired like the other two.
   */
  it('repairs a blank loop prompt rather than running the loop with no instruction', async () => {
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, enabled: true, mode: 'loop', loopPrompt: '   ' } }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.goal.loopPrompt).toBe(defaultConfig().goal.loopPrompt);
    expect(loaded.goal.mode).toBe('loop');
  });

  /**
   * The mode is one word out of a file holding every root and permission this app has. A
   * version that knows a third mode must not cost the rest of it a trip through recovery.
   */
  it('repairs an unknown mode without discarding the config around it', async () => {
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({
        ...config,
        roots: [{ name: 'project', path: 'C:\\Users\\example\\project' }],
        goal: { ...config.goal, enabled: true, mode: 'swarm' }
      }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.goal.mode).toBe('goal');
    expect(loaded.goal.enabled).toBe(true);
    expect(loaded.roots).toEqual([{ name: 'project', path: 'C:\\Users\\example\\project' }]);
  });

  it('repairs a blank prompt to the safe continuation-gate default', async () => {
    const config = defaultConfig();
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ ...config, goal: { ...config.goal, prompt: '   ' } }), 'utf8');
    expect((await loadConfig()).goal.prompt).toBe(defaultConfig().goal.prompt);
  });

  it('repairs an invalid prompt without discarding unrelated settings', async () => {
    const config = {
      ...defaultConfig(),
      roots: [{ name: 'project', path: 'C:\\Users\\example\\project' }]
    };
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { ...config.goal, prompt: 'x'.repeat(20_001) } }),
      'utf8'
    );
    const loaded = await loadConfig();
    expect(loaded.goal.prompt).toBe(defaultConfig().goal.prompt);
    expect(loaded.roots).toEqual(config.roots);
  });

  /** Corruption is not consent here either: a broken file must not switch the loop on. */
  it('leaves the loop off when the config cannot be read', async () => {
    await fs.writeFile(path.join(dir, 'config.json'), '{ definitely-not-json', 'utf8');
    expect((await loadConfig()).goal.enabled).toBe(false);
  });

  /** An unknown reasoning level is somebody else's vocabulary, not a level to guess at. */
  it('falls back rather than passing an unknown reasoning level to OpenRouter', async () => {
    const config = defaultConfig();
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...config, goal: { enabled: true, model: 'x/y', reasoning: 'extreme' } }),
      'utf8'
    );
    expect((await loadConfig()).goal.reasoning).toBe('default');
  });
});
