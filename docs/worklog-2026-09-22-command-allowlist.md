# Optional command allowlist — issue #282

## Scope

Implemented the revised proposal as one optional application-wide allowlist. The original
Allow / Ask / Deny design was deliberately narrowed: there is no approval UI, pending request,
timeout, cancellation, deny-list, priority or project policy.

## Ownership and behavior

- Validated config owns `{ enabled, rules }`; fresh and legacy installs default to disabled.
- Settings uses the existing serialized `{ base, patch }` three-way merge and shows line-specific
  validation beside a multiline one-rule-per-line editor.
- The shared Core handler preflights direct and code-mode `exec_command` calls, including every
  batch item, before command rewrites, patch interception, process ids or launch.
- Rules match exact literal argv, with only a final standalone `*` permitting additional args.
  Unsupported shell constructs fail closed with `COMMAND_NOT_ALLOWED`.
- `write_stdin`, process custody, capabilities, Read-only and workspace checks are unchanged.
- This controls launches only. Allowed programs, child processes, stdin, project code and shell
  environment remain trusted; it is not an OS sandbox. The workspace terminal is out of scope.

## Validation

Focused matcher, config, MCP, code-mode, IPC and renderer regressions were added.

- `npm run typecheck` — passed.
- Direct Node production-matcher smoke — passed exact, wildcard, compound rejection and enabled
  empty-list rejection.
- Focused Vitest — blocked before collection because Vite/esbuild child-process creation returns
  `spawn EPERM`; the alternative runner loader reaches the same sandbox restriction.
- `npm run verify` — staged the verified bundled ripgrep, then stopped in
  `verify-public-history.mjs` because its `git remote` child process could not start.
- `npm ci` — blocked by lifecycle-script `spawn EPERM`; `npm install --ignore-scripts` supplied
  JavaScript-only typecheck/test tooling and did not change the lockfile.

No Electron UI/runtime smoke was claimed from this restricted environment.
