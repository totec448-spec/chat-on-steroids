/**
 * Server instructions shown to the model once, alongside the tool list.
 *
 * Kept short on purpose: this text is prepended to context on every conversation that uses
 * the connector, and the tool descriptions already carry the per-tool detail. It states
 * what exists and how to be efficient — it is not where security is enforced.
 *
 * Written per surface. Two connectors mean two of these, and each says only what its own
 * tools can do: telling the Core conversation about `computer` would be describing a tool
 * that server does not have, which is exactly the confusion the split exists to end.
 */

import { LAUNCHES_WINDOWS_POWERSHELL_5 } from '../codex/tool-specs.js';
import { getConfig } from '../config.js';
import { isGitRepository } from '../toolchain.js';
import type { ToolContext } from './kernel.js';
import { surfaceDefinition, type SurfaceId } from './surfaces.js';

export function serverInstructions(
  ctx: ToolContext,
  surface: SurfaceId = 'core',
  platform: NodeJS.Platform = process.platform
): string {
  return surface === 'desktop' ? desktopInstructions(ctx, platform) : coreInstructions(ctx, platform);
}

function coreInstructions(ctx: ToolContext, platform: NodeJS.Platform): string {
  const config = getConfig();
  const sessionTools = ctx.sessionTools ?? config.sessions.record;
  const agentTools = ctx.agentTools ?? config.multiAgent.enabled;
  const windows = platform === 'win32';
  const desktop = windows || platform === 'darwin';
  const hostName = platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : windows ? 'Windows' : 'local';
  // Marked here rather than discovered by the model: `git status` in a folder that is not a
  // repository was one of the most repeated recoverable failures in the recorded sessions,
  // and the answer is one stat the model has no way to perform. Only repositories are
  // labelled, so the line stays short on the common case where every root is one.
  const roots =
    ctx.roots.length === 0
      ? 'None yet — the user must approve a folder in the Chat On Steroids app.'
      : ctx.roots.map((r) => `/${r.name}${isGitRepository(r.path) ? ' (git)' : ''}`).join('  ');
  const firstRoot = ctx.roots[0] ? `/${ctx.roots[0].name}` : null;

  const mode = ctx.readOnly
    ? 'Read only. Nothing here can modify anything.'
    : 'Read/write for the tools that are listed. Anything not listed is switched off.';

  const lines = [
    `Local ${hostName} coding bridge: read and change files in folders the user approved, and run commands on this computer.`,
    '',
    `Roots: ${roots}`,
    `Mode: ${mode}`,
    '',
    // Roots used to be a tool of their own. They are one line of context, they change only
    // when the user changes them, and a tool call to learn them was a round trip every
    // conversation paid before it could do anything.
    firstRoot
      ? windows
        ? `Paths are virtual under the live roots above, for example ${firstRoot}/src/main.ts. Native Windows paths inside an approved folder are also accepted and normalized to the equivalent virtual path.`
        : `Paths are virtual under the live roots above, for example ${firstRoot}/src/main.ts. Absolute native paths inside an approved folder are also accepted and normalized to the equivalent virtual path.`
      : 'Paths are virtual under an approved root as /<root>/..., but no root is currently approved.',
    // Taught once here rather than in every tool description: it is one rule that holds
    // across read, find, exec_command and apply_patch alike, and repeating it per tool would
    // cost more context than the shorthand saves.
    'Once you use a full path this chat remembers that project, so later paths may be relative to it; use a full path again to move to another project. If a relative path is refused, this chat has no folder yet — use a full one.',
    // Reading is three milliseconds of work behind a multi-second round trip, so the expensive
    // mistake is splitting one file across calls, not asking for too much in one. The default
    // per-file budget already covers an ordinary source file whole.
    'read batches paths, lists folders, expands globs and returns images — use one call, and read a file whole rather than in windows. A start_line/end_line range applies to every file the call reads; use it only for a known region.',
    ...(windows
      ? [
          // The gap that produced the most repeated shell failures: a POSIX shell expands globs
          // before the program runs and PowerShell does not, so the program receives the asterisk.
          'PowerShell does not expand * or ? for native programs. Pass ripgrep filename patterns as -g \'*.go\', and expand other globs with Get-ChildItem before use.',
          'Bare rg/ripgrep in PowerShell is bound to this app’s bundled ripgrep; name an explicit path for a different one.',
          // A bash habit Windows PowerShell answers with a failure the output does not explain.
          // Nothing repairs it for the model: stripping the redirect changes what the command
          // returns, so it is said once, up front.
          'In Windows PowerShell do not append 2>&1 to a native program: stderr is already captured, and redirecting it leaves $? false even after exit 0.',
          // Only true of 5.1, and `defaultUserShell()` prefers pwsh 7 — where the operators work
          // and this would be a lie. Same resolution the exec schema uses, so the two cannot
          // disagree about the shell the model is actually talking to.
          ...(LAUNCHES_WINDOWS_POWERSHELL_5
            ? ['This shell is Windows PowerShell 5.1, which has no && or ||: use cmds, or A; if ($?) { B }.']
            : [])
        ]
      : [
          'exec_command uses the host’s normal POSIX shell (zsh/bash/sh unless you request another one), so ordinary shell quoting, pipes and glob expansion work normally.',
          'The bundled ripgrep directory is placed first on PATH; name an explicit executable path when you intentionally want another rg.'
        ]),
    'Never send read’s line-number prefixes to apply_patch; they are display metadata, not file content.',
    'apply_patch is the only way to change files: it adds, updates, moves and deletes, and it is atomic across files.',
    'exec_command runs git, npm, builds, tests and anything else; a long-running one gives you a session_id to continue with write_stdin.',
    // The recorded sessions show this done by hand — several checks glued together with
    // Write-Output banners inside one cmd — whenever the model happened to think of it, and
    // split across separate calls whenever it did not. `cmds` is that habit made explicit, and
    // it earns its space here because the saving is a round trip per command, not shell time.
    'Batch related checks with exec_command cmds: [...]: they share one shell session, keep per-command labels/exit codes, and continue after non-zero results.',
    // The one exception to the virtual-path rule above, and the model has to be told: cmd
    // is a program, not a path, so it reaches the shell exactly as written.
    'exec_command’s workdir is virtual, but its cmd is not translated — set workdir and write paths inside the command relative to it.',
    'Output is capped. When a result says it was truncated, narrow the request instead of repeating it.'
  ];

  if (desktop && (ctx.caps.screen || ctx.caps.control || ctx.caps.clipboardRead || ctx.caps.clipboardWrite)) {
    lines.push(
      '',
      // Named rather than hinted at: the model can see this connector but not the other, and
      // "I cannot do that" is the wrong answer when the user only has to connect it.
      `Seeing and controlling the native desktop lives in a separate connector, "${surfaceDefinition('desktop').connectorName}".`,
      'If a task needs screenshots, windows, mouse/keyboard control or the clipboard and that connector is not available here, say so and ask the user to connect it.'
    );
  }

  lines.push(
    '',
    // This connector often runs long local tasks where silence looks like a stalled MCP.
    // Keep progress unusually visible, but do it in compact phase-level updates rather than
    // narrating every cheap read and wasting the context the connector is meant to save.
    'Keep the user visibly informed more than usual while you work. Before a meaningful tool run,',
    'say in one short line what you are doing. On longer work, send another short progress update',
    'after a few meaningful calls or when the phase changes; do not stay silent until the end.',
    'Report findings, changes, failures and plan changes immediately, and name the paths you modified.',
    'Do not narrate every trivial call.'
  );

  if (sessionTools) {
    lines.push(
      '',
      // A chat continuing compacted work is *opened* with the brief already in it, so there
      // is nothing to fetch and nothing to call first. What it may not know is that the
      // detail behind the brief is still on disk and can be asked for.
      'This app records chats locally. When the user refers to previous or concurrent work, call session action=search',
      'to find its recording, then session action=read with the explicit session_id instead of reconstructing it from files.',
      'Keep the returned update_cursor when following concurrent work and pass it on the next read so already-read context',
      'is not inserted twice. Use the short session-local T… reference to expand one exact tool call.'
    );
  }

  if (agentTools) {
    lines.push(
      '',
      'Multi-agent mode is on. As the prime agent you may use agents action=spawn, then keep working; worker',
      'messages are appended to your tool results as they arrive. A worker sees only what you send it, never this',
      'conversation, so spawn carries both halves: put the standing instructions every worker needs — repository',
      'and folder, conventions file, what not to touch, how to validate, what to report — in "context" once, and',
      'give each worker the objective, files and constraints that are its own in its "task". Do not repeat the',
      'context inside the tasks, and do not preface a task with boilerplate like “you have zero prior context”.',
      'Workers write code as readily as they investigate, so say which files each one may change. Steer an active',
      'worker with action=message, and send several at once with "messages" rather than one call per worker. Reuse',
      'a sleeping worker for related follow-up work before spawning a replacement; message wakes its exact chat.',
      'Only terminal workers whose context is full need replacing. As a worker, message the prime with',
      'findings/decisions/blockers, keep working while replies are pending, and call action=finish only when done,',
      'under RESULT / CHANGES / VALIDATION / BLOCKERS. Workers talk only to the prime agent, never to each other.'
    );
  }

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
    'that has since changed. For physical pointer or application keyboard input, pass the observed window id as targetWindow; system-owned shortcuts remain global. targetWindow is a fail-closed assertion, not permission to guess a different focus.',
    'Keep a computer call on one target window and one UI-changing decision. focus/move/wait/clipboard setup may accompany it; inspect the returned capture before deciding the next action.',
    'Mutating computer calls return a fresh result screenshot by default when screen access is available. Set captureAfter=false only when the result genuinely does not need visual verification.',
    'When a small Retina control is visually ambiguous, observe it again with a larger max_width instead of guessing a pixel.',
    'Prefer focus(window) over command+tab/alt+tab when the destination window id is known. Never use a fixed sleep as proof that an app switch finished.',
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

  return lines.join('\n');
}
