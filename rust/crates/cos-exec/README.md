# cos-exec

The `exec_command` and `write_stdin` tools and the process custody behind them (unit C1.6). It
ports the TypeScript app's port of codex-rs unified exec (`src/main/codex/*`), with `exec.ts`,
`exec-hints.ts`, `env.ts`, `toolchain.ts` and `src/shared/command-allowlist.ts`.

## Use

```rust
cos_exec::restore_ctrl_c(); // once, before the first session
let exec = ExecManager::with_policy(
    ExecDeps { launcher: Arc::new(PrestartedPowerShell::new()) },
    Box::new(move || policy_from(&config.borrow())), // the live commandAllowlist
);
for tool in exec.tools() {
    tools.add(SurfaceId::Core, tool);
}
exec.prestart(); // at start and when commands are switched on; returns at once
exec.release_prestarted(); // when commands are switched off
// shutdown phase `Processes`:
exec.terminate_all().await;
```

`ExecManager` is the only owner of exec processes. It allocates session ids, keeps each live
session's draining output buffer, waits out yield deadlines (default 10 s, clamped to 250 ms to
30 s; an empty `write_stdin` poll waits 5 s to 300 s and returns on the first output), keeps the
last 64 completed sessions for an explicit reread, and records which caller owns each id. A
session id is never authority by itself: `write_stdin` from another caller is refused with the
recorded `EXEC_SESSION_*` texts.

Every session runs in its own Job Object. Terminating a session ends its whole process tree. A
live session dies with the app even if the app crashes; a background program that a finished
command started keeps running, as in the TypeScript app. `terminate_all` ends every live session
and the pre-started shells, then waits at most 2 s for their exits.

`wall_time_seconds` (and `Wall time:`) runs from the moment the command runs to the end of the
call's wait, so it includes the 150 ms early-exit grace. The TypeScript app, like codex, starts
the clock after the grace, so a command that ends inside it reports 0 there. Its yield deadline
still starts after the grace, as in the TypeScript app.

Note: this wall time reads up to 150 ms higher than the TypeScript app's for the same command,
an accepted difference because it is the more honest number.

Pipe sessions start with stdin on the null device, so `write_stdin` answers
`stdin is closed for this session`, except for Ctrl-C (`\u0003`), which ends the tree. `tty: true`
runs the command in an 80x24 ConPTY.

## Launchers

A `Launcher` turns a `LaunchRequest` (shell, script, folder, environment, tty) into a `Launched`
process: an output stream, an exit code and a `Control` handle.

- `FreshProcess` starts the shell when the call arrives, as the TypeScript app does. It is the
  parity baseline.
- `PrestartedPowerShell` keeps Windows PowerShells started and pre-warmed for pipe-mode
  PowerShell calls, then sends one of them the folder and script over a named pipe whose server
  process id it verifies. Each command still gets its own process, environment, folder and job,
  so nothing leaks between commands. TTY, `login`, `cmd.exe` and POSIX shells use a fresh
  process.

The pool adapts to use:

| State | Spares waiting | Enters it when |
| --- | --- | --- |
| Off | 0 | the launcher is new, or `release_prestarted` (commands switched off) |
| Idle | 1 | `prestart` (Core start, commands switched on), or 2 min (`DEFAULT_QUIET`) after the last call |
| Busy | 3 (`DEFAULT_SPARES`) | any call |
| Closed | 0, for good | `terminate_all` or dropping the launcher |

Each spare taken is replaced at once on a blocking thread, so no call waits for process
creation. Shrinking ends the oldest spares and keeps the youngest. A call takes the youngest
spare already waiting on its pipe, else the oldest one still starting. A spare whose shell or
environment no longer matches the call is ended and the pool refills for the new shape.

Measured on the baseline machine (Ryzen 7 7800X3D, 16 threads, Windows PowerShell 5.1, no pwsh),
through the real tool in process, every answer checked for its output and exit code 0 (0
failures in every row). The Electron app over MCP measured 581 ms (echo) and 436 ms (rg) back to
back and 582 and 434 ms 1.5 s apart (`after/RESULTS.md` of the rewrite). See
`examples/exec_bench.rs`.

| Command | FreshProcess | PrestartedPowerShell |
| --- | --- | --- |
| `echo bench-ok`, 1.5 s between calls, n=30 | 667 ms (588 to 1,442) | 76 ms (61 to 256) |
| `rg -n quartz-lantern .`, 1.5 s between calls, n=30 | 500 ms (454 to 575) | 81 ms (71 to 101) |
| `echo bench-ok`, 50 back to back | 624 ms (572 to 1,242) | 79 ms (62 to 562), mean 187 ms |
| `rg -n quartz-lantern .`, 50 back to back | 433 ms (424 to 515) | 99 ms (75 to 520), mean 196 ms |
| first `echo` 1 s after `prestart`, n=10 | | 75 ms (72 to 96) |
| first `echo` at once after `prestart`, n=10 | | 777 ms (745 to 934) |

Medians, ranges in brackets. The fresh process rows were noisier than in earlier runs (the echo
maximum of 1.4 s), so treat every number as indicative; no compiler ran at the start or end of the
run. Back to back, the first three calls take ready spares and later calls wait for
replacements, so the mean, not the median, is the sustained cost: 5.1 to 5.4 calls a second.

The limit back to back is CPU. Starting one PowerShell 5.1 takes about 600 ms and 1.2 s of CPU
(measured with its own `TotalProcessorTime`); six at once take 765 ms and 1.55 s of CPU each.
Busy sizes of 1 to 6 gave 2.8, 4.1, 5.3, 6.1, 7.1 and 7.5 calls a second (n=50 each, means of
349, 241, 190, 164, 138 and 138 ms for echo, oldest spare first), so each spare past three buys
less and costs 30.5 MiB while it waits. Three serve a burst of three calls (parallel tool calls)
at full speed and keep sustained calls about 3x faster than Electron by the mean. A fresh launch
while the pool refills would compete for the same CPU, so a call waits for a spare instead.

The quiet period trades memory against the next burst. Busy, the pool holds 61 MiB more than
idle. Shrunk, it costs the next burst one wait: three calls back to back on a one-spare pool
took 78, 717 and 67 ms (medians of 10, `exec_bench regrow`), against 72, 70 and 79 ms on a grown
pool. Only a second call within about 0.7 s of the first pays it. The penalty is small and paid
once, so the quiet period sits at the low end of 2 to 5 minutes: 2 minutes keeps the pool grown
across the pauses inside one agent turn, which is a guess about cadence, not a measurement.

The youngest ready spare is chosen because age costs time: with the oldest first, three spares
1.5 s apart answered in 80 ms (echo) and 99 ms (rg), against 67 and 80 ms youngest first (n=20,
two interleaved rounds, ranges not overlapping for echo). One spare left idle 5 s between calls
also answered echo in 81 ms. The cause is not profiled; a guess is that an idle spare's memory
leaves the CPU cache.

The first call made at once after `prestart` waits for the one spare still starting; one second
later it is ready. Pre-warming the formatting system in the spare is worth about 100 ms for
`echo` (168 ms without it in the throwaway prototype). What remains is inferred, not profiled:
PowerShell running the script, then exiting.

A third design, one persistent PowerShell host per caller, was faster still (6 to 16 ms) and
was rejected: commands leaked global functions into later calls, a command reading stdin
consumed the host's protocol, `exit` killed the host, stderr lost its ordering and output
encoding changed.

### Idle cost of the pool

Idle (one spare, from start until the first call and again after the quiet period), after 30 s
the spare holds a private working set of 30.4 MiB (28.6 MiB PowerShell, 2.3 MiB its console
host), 56.0 MiB of private bytes and 685 handles: medians of 5 runs, ranges 30.3 to 30.6 MiB,
55.9 to 56.1 MiB and 685 to 695. That is two processes in the tree. Busy (three spares, after a
call), they hold 91.5 MiB (90.9 to 91.6), 168.3 MiB of private bytes and 2,039 handles, six
processes. Earlier, one spare measured 30.8 MiB after 5 s idle, so the cost is the started
engine, not growth while it waits. A fresh process per call costs nothing between calls. See
`examples/spare_idle.rs`.

### Known difference of the pre-started shell

A `Write-Error` issued at the top level of a script (not inside a function) is labelled with the
script text plus the line that captures `$?`, and gets a position line. The message and the exit
code match. Everything else measured matched a fresh process byte for byte: exit codes (`exit N`,
failing last statement, native non-zero exits, thrown and parse errors), stdout and stderr order,
working folder, environment, unicode, 40,000-line output, closed stdin, `rg` without a path,
formatted tables, and isolation of variables, folders, environment and global functions.

## Proof

- `tests/golden.rs` replays `rust/golden/base/mcp/core/calls/52` to `78` through the real kernel
  (C1.2) with these tools, in recorded order, for both launchers. The PTY cases compare the
  output with the console title and its token count masked, because the corpus was recorded
  elevated and the title says so.
- `tests/behavior.rs` covers exit-code rules, folder, environment and UTF-8, isolation between
  calls, Ctrl-C on pipe and terminal sessions, tree kill, bounded shutdown, custody, the
  command policy, and a wall time that covers a command ending inside the early-exit grace.
- `tests/pool.rs` watches the pool through the operating system. One spare waits after
  `prestart` and serves the first call (by `$PID`). The call grows the pool to three new
  processes, three calls back to back run in exactly those, and the pool refills. After the
  quiet period it shrinks to one of them, and the other two die. Switching commands off ends it,
  on starts one. Shutdown and dropping the launcher end every spare, and nothing starts after
  shutdown. The spares of a killed owner process die with it (the test kills a copy of itself
  that owns a grown pool).
- `cos-core`'s `the_core_prestarts_while_commands_are_on_and_releases_when_they_go_off` checks
  that the Core asks for one `prestart` at start, a release when commands go off, and a
  `prestart` when they come back on.
- The benign-exit classifier (`src/benign.rs`) replays every call the TypeScript suites make to
  `nonZeroExitIsBenign` and `benignExitNote`, recorded in `tests/benign-oracle.json` by
  `node rust/crates/cos-exec/differential/benign-oracle.mjs`. A benign exit (a search that found
  nothing, a reporting command cut by `Select-Object -First`) gets the TypeScript note and is
  not recorded as `process_exit_nonzero`.
- Unit tests cover the buffer, truncation, batches, allowlist, quoting repair, shell resolution
  and the environment.

`rg` is found in `resources/rg` above the executable (run `npm run rg` from the repository
root) or on `PATH`.

## Not ported yet

- The `apply_patch` interception inside `exec_command`: it needs `cos-patch`, which is not an
  edge of this crate.
- Background result delivery (completed output pages appended to later tool responses, and
  reminders for unpolled sessions): it needs a kernel hook.
- The recovery hints of `exec-hints.ts` (`execRecoveryHints`), and its glob and brace expansion
  for ripgrep (`normalizeShellCommand`).
- Request-to-chat correlation of session owners, and worker worktree checks (browser plane and
  multi-agent units).
- POSIX process groups and PTYs.

## License

`src/buffer.rs`, `src/truncate.rs` and the Job Object code in `src/platform/windows.rs` are
adapted from OpenAI Codex (`codex-rs`) at commit `1a4096e273e80da30947e57fdfa45be92858ca91`,
which is licensed under the Apache License 2.0 (`LICENSE-codex`). `NOTICE` lists each adapted
file and its source. The crate is therefore `MIT AND Apache-2.0`.
