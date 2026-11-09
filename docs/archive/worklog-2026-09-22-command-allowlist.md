# Optional command launch policy — issue #282

## Scope

Implemented one optional application-wide command policy with Allowlist and Denylist modes.
There is no approval UI, pending request, timeout, cancellation, per-rule priority or project policy.

## Ownership and behavior

- Validated config owns `{ enabled, mode, rules }`; fresh installs default to disabled Allowlist,
  and legacy configs without `mode` retain Allowlist behavior.
- Settings uses the existing serialized `{ base, patch }` three-way merge and shows line-specific
  validation beside a multiline one-rule-per-line editor.
- The shared Core handler preflights direct and code-mode `exec_command` calls, including every
  batch item, before command rewrites, patch interception, process ids or launch.
- Rules match exact literal argv, with only a final standalone `*` permitting additional args.
  Allowlist permits matches; Denylist blocks matches. Unsupported shell constructs fail closed
  with `COMMAND_NOT_ALLOWED` in both modes.
- `write_stdin`, process custody, capabilities, Read-only and workspace checks are unchanged.
- This controls launches only. Allowed programs, child processes, stdin, project code and shell
  environment remain trusted; it is not an OS sandbox. The workspace terminal is out of scope.

## Validation

Focused matcher, config, MCP, code-mode, IPC and renderer regressions were added.

- `npm run typecheck` — passed.
- `npm run verify:notices` — passed for 153 production packages, seven catalog entries and
  730 pinned native source archives/patches.
- Focused command policy, config, IPC, Core/code-mode and renderer suites — 420 passed with six
  platform/optional skips; the adjacent renderer timeline suite also passed all 187 tests.
- `npm run build` — passed for main, preload and renderer production bundles.
- Direct Node production-matcher smoke — passed exact, wildcard, compound rejection and enabled
  empty-list rejection. Follow-up review added and passed regressions for PowerShell quote
  concatenation/comma syntax and POSIX tilde expansion.
- Isolated built-app smoke — the Settings controls rendered, enabling an empty allowlist saved
  an active empty Allowlist, and the enabled toggle remained selected after restart.
- Allowlist/Denylist extension — focused policy, migration, IPC, Core/code-mode and renderer
  regressions passed; typecheck and the production build passed.
