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
    'When spawning workers, omit model and reasoning_effort unless the user explicitly requests an override for that setting. The app applies the user\'s saved worker defaults automatically; you do not need their concrete values and must not ask the user to choose or confirm them before spawning.',
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
  if (platform === 'win32') return windowsDesktopInstructions();
  const host = platform === 'darwin' ? 'Mac' : 'Windows PC';
  const paste = platform === 'darwin' ? 'command+v' : 'ctrl+v';
  const lines = [
    `Local desktop control: look at this ${host}’s screen and windows, and drive its mouse and keyboard.`,
    '',
    'observe first, then computer. Choose the task-specific window from observe what=windows, then inspect it with what=window.',
    'A bare observe() returns the foreground window, its screenshot and accessibility controls. Observation does not activate the window.',
    'Use click_ref/set_value for exposed controls; refs resolve the same control again when acted on.',
    'Physical input requires the target window in front. Use computer focus to activate it; when something steals focus, observe first.',
    'Coordinates are pixels of a screenshot frame. Coordinate actions require frameId so a click cannot land on a screen',
    'whose owner or geometry has since changed. Batch related actions and use captureAfter to inspect the result; input acceptance alone does not prove the task succeeded.',
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
    'or switch tabs or windows are refused. Address-bar focus chords are allowed for authorized navigation in the selected window.',

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

function windowsDesktopInstructions(): string {
  return [
    'Windows Computer Use uses the Window2 app/window interface. Use its named tools directly or call the same methods on sky inside this connector’s exec JavaScript. sky is supplied automatically; no package import or setup is needed. Mac uses a separate contract.',
    '',
    'Start with list_apps: each app has an id and its exact windows. list_windows lists currently open targetable windows; get_window rehydrates a returned id and optional app. Choose exactly one returned Window {app,id,title?}; never invent an app/window identity from a title or guessed process name.',
    'launch_app accepts an observed app id or a concrete .exe path/name. It requests launch without command arguments. Refresh list_apps/list_windows and choose the matching returned window to verify startup; launch acceptance is not a window receipt.',
    '',
    'get_window_state({window}) captures the selected window without activating it, including when covered. include_screenshot defaults true and include_text defaults false. include_text adds a formatted accessibility tree with numeric element indexes, supported secondary-action labels, focused/selected elements and bounded document/selected text. Use include_screenshot:false for text-only observation.',
    'The result has {window,focused,screenshots,accessibility}. focused reports the observed window focus, not a promise that it stays focused. Screenshot metadata has an id, image-pixel width/height, physical screen origin and relative zIndex. Pixels are separate native image blocks, not data URLs in the returned object. Images appear directly for named tool calls and automatically for sky.get_window_state; text(state) safely prints only metadata. Owned menus/popups are bounded additional screenshots; a window in the same process is not automatically related.',
    'Chromium accessibility comes from its current browser UI, including the address bar and displayed document. accessibility.truncated says when the bounded tree is incomplete (null means unreported); offscreen and disabled controls are marked. A missing control in a truncated tree is not proof it is absent: use the fresh screenshot instead of repeatedly requesting the same tree. accessibility_error explains a text-provider failure while useful screenshots remain available. Never use a tree that contradicts the visible page to choose an element.',
    '',
    'Use a two-step loop: observe and stop to inspect the result, then perform one state-derived action and refresh immediately. Input consumes the preceding observation; interleaving or failure requires a new observation. A failed refresh does not undo the input, so do not repeat an action just because its result image failed.',
    'click accepts element_index or x/y with optional screenshotId, mouse_button and click_count. set_value uses element_index and value; perform_secondary_action uses element_index and a case-insensitive advertised label such as Raise, Toggle, Expand or Scroll Down. Indexes belong only to the latest accessibility observation for this conversation and window.',
    'Coordinate x/y values are pixels within the selected returned screenshot, starting at its top-left. Use screenshotId from the inspected state, especially for popup images; omit it for the main image. Do not apply DPI, monitor-origin or window-size scaling: the native frame owner converts image pixels to the actual screen. scroll uses scrollX/scrollY wheel deltas (120 per detent, positive Y down); drag uses from_x/from_y/to_x/to_y. All physical input activates and checks the exact target, app identity, frame geometry and related owner before input.',
    'press_key accepts keysym names and + chords such as Control_L+a or Control_L+Shift_L+period. Punctuation follows the target keyboard layout. type_text sends literal text; multiline input uses clipboard paste and requires the existing clipboard-write permission. set_value is preferable for an editable accessibility control. Observe the focused control before typing.',
    'Input methods already activate their target. activate_window consumes the current observation too: if used explicitly, get_window_state again before clicking an index or coordinate. Browser tab/window switching and closing chords remain refused; address-bar focus (Control_L+l, Alt_L+d) is allowed for authorized navigation. Use a separate browser window for testing so navigation does not replace a running ChatGPT page. read_clipboard/write_clipboard remain available under their existing permissions.',
    '',
    'JavaScript example: const apps = await sky.list_apps(); nodeRepl.write(apps.map(app => ({id:app.id,name:app.displayName,windows:app.windows})));',
    'Use nodeRepl.write(value) or text(value) for concise text. sky methods return their native arrays/objects or undefined, and throw tool failures. tools.<name> returns the normal MCP envelope with structuredContent.value. Only sky.get_window_state automatically displays images.',
    'This app reuses its bounded exec runtime: variables do not persist across calls, so carry returned Window objects or rehydrate with get_window. No Node, imports, filesystem, network or extra Codex permission system is installed. Each method still uses this app’s live capability checks, exact caller and local recording. Keep independent reads parallel only when their observations do not conflict; await actions before refreshing.',
    '',
    `Files, patches and shell commands live in the separate "${surfaceDefinition('core').connectorName}" connector. Act only within the user’s requested task.`,
    ...userInstructions()
  ].join('\n');
}
