/**
 * Server instructions advertised during MCP initialization. The client decides which
 * instructions reach the model; successful transport does not prove full prompt receipt.
 *
 * Core carries adapted upstream Codex collaboration instructions followed by only the
 * available local tools. Declarations own per-tool details; live guards enforce permissions.
 *
 * Written per surface. Two connectors mean two of these, and each says only what its own
 * tools can do: telling the Core conversation about `computer` would be describing a tool
 * that server does not have, which is exactly the confusion the split exists to end.
 */

import { LAUNCHES_WINDOWS_POWERSHELL_5 } from '../codex/tool-specs.js';
import { CODING_INSTRUCTIONS } from './coding-instructions.js';
import { canAddCodeMode, CODE_MODE_INSTRUCTIONS } from './code-mode-tool.js';
import { pluginManager } from '../plugins/manager.js';
import { effectiveCapabilities, getConfig, MAX_MCP_INSTRUCTIONS_CHARS } from '../config.js';
import { isGitRepository } from '../toolchain.js';
import type { ToolContext } from './kernel.js';
import { surfaceDefinition, type SurfaceId } from './surfaces.js';

export function serverInstructions(
  ctx: ToolContext,
  surface: SurfaceId = 'core',
  platform: NodeJS.Platform = process.platform
): string {
  if (surface === 'plugins') return 'External MCP tools enabled by the user in Chat On Steroids. Each tool retains its upstream schema and annotations. External servers run with their own operating-system or service permissions; CoS approved folders do not sandbox them. Use only for the user\'s requested task. A failed or disconnected call may already have taken effect: never automatically retry a mutation after an ambiguous failure. Disabled tools require the user to re-enable them in Settings. Core and Desktop are separate connectors.' + (canAddCodeMode(pluginManager.tools()) ? '\n\n' + CODE_MODE_INSTRUCTIONS : '');
  return surface === 'desktop' ? desktopInstructions(ctx, platform) : coreInstructions(ctx, platform);
}

/** Same complete source as MCP initialization, evaluated when a user send is prepared. */
export async function currentCoreInstructions(): Promise<string> {
  const config = getConfig();
  return serverInstructions({ roots: config.roots, caps: effectiveCapabilities(config),
    readOnly: config.readOnly, privacyScreenshots: config.ui.privacyScreenshots }, 'core', process.platform);
}

/**
 * The user's own additions, appended to whichever connector is being described.
 *
 * Last, and fenced under a heading that says whose words these are. Both matter. Last, because
 * everything above is what the app can actually promise about its own tools, and a preference
 * must not quietly redefine one of them. Attributed, because the model should be able to tell a
 * standing instruction from this user apart from the connector's description of itself -- they
 * carry different authority, and running them together hides that.
 *
 * Empty is the normal case and adds nothing at all, not even the heading.
 */
function userInstructions(): string[] {
  const text = getConfig().mcp.instructions.trim();
  if (!text) return [];
  return ['', "The user's own standing instructions for this connector:", text.slice(0, MAX_MCP_INSTRUCTIONS_CHARS)];
}

function coreInstructions(ctx: ToolContext, platform: NodeJS.Platform): string {
  const config = getConfig();
  const sessionTools = ctx.sessionTools ?? config.sessions.record;
  const agentTools = ctx.agentTools ?? config.multiAgent.enabled;
  const caps = ctx.caps;
  const windows = platform === 'win32';
  const desktop = windows || platform === 'darwin';
  const host = platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : windows ? 'Windows' : 'local';
  const roots = ctx.roots.length
    ? ctx.roots.map(root => `/${root.name}${isGitRepository(root.path) ? ' (git)' : ''}`).join('  ')
    : 'None yet.';
  const lines = [
    CODING_INSTRUCTIONS,
    '',
    '# Local tools',
    `Use the connected tools as needed: ${surfaceDefinition('core').connectorName} for files, terminal, plans, sessions and workers` +
    (desktop ? `; ${surfaceDefinition('desktop').connectorName} for screen, input and clipboard` : '') +
    `; ${surfaceDefinition('plugins').connectorName} for enabled external apps and services.`,
    `Host: ${host}. Roots: ${roots}`,
    ctx.readOnly ? 'The local tools are read-only.' : 'Use the tools listed in this conversation.',
    'An approved root may be the parent of the project. Use the exact project path and keep every intermediate folder; do not guess a missing project level.',
    'Paths may be virtual under the roots above or absolute native paths inside them. Once this chat has a project, later paths may be relative to it. Use a full path to select another project.',
  ];

  if (caps.read || caps.browse || caps.metadata) lines.push(
    'read batches paths, lists folders, expands globs and returns numbered text. Read related files together. Read whole files for orientation; use a known region when that is enough. A start_line/end_line range applies to every file the call reads.',
  );
  if (caps.read) lines.push('view_image inspects a local image. Use it when visual evidence matters.');
  if (caps.command) {
    lines.push(
      'Use rg or rg --files for repository searches; if unavailable, use the next best tool.',
      'exec_command runs git, builds, tests and shell commands. Batch related checks with exec_command cmds: [...]; they run sequentially in one shell with per-command output and exit codes.',
      'Set workdir to the project. workdir accepts virtual paths; paths inside cmd are not translated, so use paths relative to workdir or native filesystem paths.',
      'A running command returns a session_id. Continue that same process with write_stdin; inspect its terminal result before reporting completion. After a transient wait failure, keep the same session instead of starting replacement work.',
      'Output is capped. When truncated, narrow the command or read the relevant region rather than repeating the same request.'
    );
    if (windows) lines.push(
      'PowerShell does not expand * or ? for native programs: pass ripgrep filename patterns as -g \'*.go\', and expand other globs with Get-ChildItem.',
      'Bare rg/ripgrep is bound to the app’s bundled ripgrep. In Windows PowerShell, omit 2>&1 on native programs: stderr is already captured and that redirect can leave $? false after exit 0.',
      ...(LAUNCHES_WINDOWS_POWERSHELL_5 ? ['This is Windows PowerShell 5.1, without && or ||. Use cmds or A; if ($?) { B }.'] : [])
    );
    else lines.push('exec_command uses the host’s normal POSIX shell (zsh/bash/sh unless requested otherwise). The bundled ripgrep directory is first on PATH.');
  } else if (ctx.exposedFind ?? caps.search) {
    lines.push('find searches filenames or file contents without a shell. Narrow path and include patterns to the relevant area.');
  }
  if (caps.create || caps.edit || caps.move || caps.deleteFile) lines.push(
    'Use apply_patch for manual file changes. It adds, updates, moves and deletes files atomically. Never copy read’s line-number prefixes into a patch.'
  );
  if (caps.saveArtifact) lines.push(
    'download_artifact saves a user-supplied or ChatGPT-generated file using its native file value and an approved destination path. It refuses to overwrite. Do not recreate the file or put signed URLs, file objects or base64 into shell commands.'
  );
  if (sessionTools) lines.push(
    '',
    '# Task plan and recorded history',
    'Use update_plan for tasks with several meaningful steps; skip it for simple tasks. Give each step a short user-facing headline and concrete details about the approach, constraints or checks. Send the complete plan on every update, preserving useful details. Keep at most one step in_progress.',
    'Update the plan when a step is completed or the approach changes. Mark steps completed only when their work is done. Do not repeat the full plan in chat: the app shows the headlines with expandable details above queued messages.',
    'The plan does not execute steps or mark queued instructions done. New user instructions extend the work; update the plan accordingly.',
    'When the user refers to previous or concurrent work, use session action=search to find its recording, then action=read with the explicit session_id. Keep update_cursor for subsequent reads and use a short T… reference to expand an exact tool call.'
  );
  if (agentTools) lines.push(
    '',
    '# Workers',
    'Use agents for independent subtasks while continuing useful work yourself. Reuse a sleeping worker for related follow-up work before spawning a replacement. Only terminal workers whose context is full need replacing.',
    'A worker sees only what you send it. In spawn, put shared repository/folder instructions, constraints and validation requirements in context once; put the objective and assigned files in each task. Explicitly say what each worker may change. Do not repeat the shared context in every task.',
    'Use action=message to steer a worker; batch messages when sending several. Worker reports arrive with tool results. Check their findings and changes before relying on them.',
    'Workers communicate with the prime, keep working while replies are pending, and use action=finish when done with RESULT / CHANGES / VALIDATION / BLOCKERS. A finished reusable worker sleeps and can be messaged again.'
  );
  if (ctx.exposedFinishTool ?? config.ui.finishTool) lines.push(
    '',
    'session_finish is for Astra only when the user prompt explicitly requests it. Follow that prompt’s finish timing after implementation; complete newly delivered work. It is not a plan/progress update or a way to collect queued tasks. Workers use agents action=finish instead.'
  );
  if (desktop && (caps.screen || caps.control || caps.clipboardRead || caps.clipboardWrite)) lines.push(
    '',
    `Native screen, window, mouse, keyboard and clipboard tools live in the separate "${surfaceDefinition('desktop').connectorName}" connector. If the task needs them and they are unavailable, tell the user which connector is needed.`
  );
  lines.push('', CODE_MODE_INSTRUCTIONS, ...userInstructions());
  return lines.join('\n');
}

function desktopInstructions(ctx: ToolContext, platform: NodeJS.Platform): string {
  const host = platform === 'darwin' ? 'Mac' : 'Windows PC';
  const paste = platform === 'darwin' ? 'command+v' : 'ctrl+v';
  const lines = [
    `Local desktop control: look at this ${host}’s screen and windows, and drive its mouse and keyboard.`,
    '',
    'observe first, then computer. A bare observe() returns the foreground window, a screenshot and its',
    'controls with refs; refs beat pixel coordinates because they resolve the real control again when acted on.',
    'observe never needs a window to be in front and never fails for lack of focus. Only computer does, and',
    'only for its focus action — so when something steals focus, look first and act on what you see.',
    'Coordinates are pixels of a screenshot frame. Coordinate actions require frameId so a click cannot land on a screen',
    'that has since changed. Batch the actions that belong together and use captureAfter to verify the result.',
    // Waiting was the single most repeated desktop pattern in the recorded sessions: a batch of
    // nothing but a fixed sleep plus a screenshot, over and over, because the model had no way to
    // say what it was waiting *for*. verify is that way, and it waits inside the one call.
    'Do not poll with a batch that only waits. When an action needs time to take effect, say what you are',
    'waiting for with verify — until foreground, window_exists, window_closed, ui_appears or ui_disappears —',
    'and it waits for that condition and captures the result inside the same call.',
    // Said here as well as in the schema: the clipboard is reached through computer rather
    // than through a tool of its own, and a model looking for a "clipboard" tool finds none.
    'The clipboard lives in computer too — read_clipboard and write_clipboard run in sequence with',
    `the other actions, so copying text in and pasting it with keypress ${paste} is one call.`,
    // The prime that closed its own chat with ctrl+w on 2026-09-02 was testing its game in a tab
    // beside its ChatGPT chats. A chord cannot see which tab it lands on, so the rule is a window
    // of its own, and the tool refuses the chords that would move between tabs or windows.
    'A browser window here may be holding the ChatGPT chats this app runs. Open the page you are testing in a',
    'browser window of its own, keep that window in front and act only there. Keyboard chords that close, open',
    'or switch tabs or windows, or take the address bar, are refused in every browser window.',

    'Act only on what the user asked for and leave the rest of their desktop alone.'
  ];

  if (ctx.privacyScreenshots) {
    lines.push(
      '',
      'Privacy screenshots are on: captures default to the active window rather than the whole screen.'
    );
  }

  lines.push(
    '',
    `Files, patches and commands live in a separate connector, "${surfaceDefinition('core').connectorName}".`,
    'This one cannot read or change files. If a task needs that and it is not available here, say so.'
  );

  lines.push('', CODE_MODE_INSTRUCTIONS, ...userInstructions());

  return lines.join('\n');
}
