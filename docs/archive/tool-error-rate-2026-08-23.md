# Tool error-rate audit — 2026-08-23

This is the frozen evidence and implementation record for the 2026-08-23 review of recent
Chat On Steroids tool calls. It exists separately from `TOOL_CALL_ISSUES.md` so later cleanup of
that working issue file cannot erase the denominator, the projection correction, or the exact
reason each fix was accepted.

## Scope and denominator

Two views were measured because "last 50 chats" is ambiguous when some recorded sessions contain
no connector calls at all.

| Population | Calls | Stored error | Rejected | Failed/rejected | Rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| Newest 50 sessions **with at least one tool call** | 2,151 | 139 | 56 | 195 | **9.07%** |
| Literal newest 50 recorded sessions | 1,942 | 132 | 52 | 184 | **9.47%** |

Nineteen of the literal newest 50 recorded sessions contained zero tool calls. The 2,151-call
population is therefore the stable denominator for asking "how often does a recent tool call
fail?"; the 1,942-call view is still recorded because it is the literal interpretation of the
request.

The frozen 50-tool-using-session strata measured during the audit were approximately 6.3% for
ordinary sessions, 7.3% for workers, 8.1% for resumes, and 2.5% for `Unattributed activity`.
Those labels describe the stored session population, not a causal claim about why a call failed.

## Per-tool snapshot

The frozen 2,151-call population produced this useful prioritization:

| Tool | Calls | Failed/rejected | Rate | Note |
| --- | ---: | ---: | ---: | --- |
| `session` | 22 | 4 | 18.2% | Tiny denominator |
| `agents` | 303 | 40 | 13.2% | Lifecycle/durable recovery dominates |
| `exec_command` | 958 | 124 | 12.9% | Largest practical repair surface |
| `write_stdin` | 32 | 4 | 12.5% | Small denominator |
| `apply_patch` | 161 | 7 | 4.3% | Mostly caller/stale-context validation |
| `read` | 409 | 15 | 3.7% | Multi-path/range ergonomics mattered |
| `computer` | 213 | 1 | 0.5% | This sample only |
| `observe` | 45 | 0 | 0% | This sample only |
| `view_image` | 8 | 0 | 0% | Tiny denominator |

Do not use the percentages above as a timeless product benchmark. They are a frozen diagnostic
sample used to decide which failure classes were worth normalizing in this implementation pass.

## The projection error that was caught

An early review said the then-current fixes covered 77 of the 195 failures and projected
`9.07% -> 5.49%`. That mixed **symptom matching** with **actual implementation eligibility**.
For example, 20 historical failures looked glob-related, but the exact normalizer implemented at
that checkpoint rewrote only 5 of them. Git-outside-repository failures had better guidance but
were not automatically repaired at all.

The audit was rerun against the real predicates. At that checkpoint the mechanically verified
eliminations were:

- 17 benign search exit-1 calls classified correctly;
- 5 historical glob failures actually matched by the then-current rewrite;
- 15 multi-path/range `read` failures actually handled by the new surface.

That is **37 / 195**, leaving 158 failures in the frozen denominator and therefore a defensible
stage floor of **158 / 2,151 = 7.35%**. This is the number to use when discussing that checkpoint.

Subsequent narrow brace expansion matched 2 additional observed failures, and the PowerShell 5.1
`&&` / `||` recovery guidance matched 1. They were measured rather than extrapolated to their
whole symptom buckets. No new final percentage is asserted here because the current tree has
since changed in more ways and the full frozen-corpus classifier has not been rerun end-to-end.

## Failure classes and what changed

### 1. Search exit 1 was sometimes a result, sometimes a real failure

`rg`, `grep` and `findstr` legitimately spend exit code 1 on "no matches". Treating every such
call as a tool error inflated the rate. Treating every exit 1 from a line containing `rg` as
benign is worse: it can launder a failure from a different command.

The implementation was tightened in several review rounds:

- Determine the native program that can actually own `$LASTEXITCODE`, not merely the first
  program in a PowerShell pipeline.
- Never infer through `&&` / `||`; which branch ran is a runtime fact.
- Shell/parser refusal diagnostics withhold the exemption entirely.
- Wrapper scripts such as `rg.cmd`, `rg.bat` and `rg.ps1` do not inherit ripgrep's contract.
- Downstream PowerShell stages are skipped only for a small allowlist of exact passive shapes.
  Merely being a known cmdlet is not proof a stage could not fail.
- PowerShell backticks make the lightweight parser fail closed. An escaped `;`, `|` or newline
  cannot be treated as a real separator.
- A profile-enabled shell does not trust bare `rg` or even bare `rg.exe`: PowerShell functions
  can shadow both names. A path-qualified executable remains provable, and an explicitly
  profile-disabled shell may trust a bare application name.

The central rule is asymmetric on purpose: ambiguity costs a benign exemption. It must never
turn an ambiguous genuine failure into a successful no-match result.

### 2. PowerShell native-program path syntax caused avoidable retries

PowerShell does not perform bash-style filename glob or brace expansion for native executables.
The connector now repairs only shapes it can reproduce without changing meaning:

- narrow filename globs in the resolved command working directory;
- textual `{a,b}` alternatives that contain no quoted/script-block/ambiguous syntax.

It deliberately refuses bracket classes, backtick-containing lines, brace alternatives that
still need a glob stage, and unknown ripgrep option shapes. The ripgrep option table is derived
from the bundled binary's help rather than guessed from memory. A missed rewrite costs a retry;
rewriting the wrong token can make a different command succeed, which is much worse.

### 3. Windows PowerShell 5.1 has no `&&` / `||`

Blindly rewriting either operator to `;` is incorrect and potentially destructive. The faithful
forms are:

- `A; if ($?) { B }` for `A && B`
- `A; if (-not $?) { B }` for `A || B`

The connector gives these as recovery guidance when the 5.1 parser refuses a chain. It does not
pretend that `A; B` preserves the original condition.

The shared instructions also warn that redirecting a native program with `2>&1` under Windows
PowerShell can leave `$?` false even when the native program exited 0. That is guidance rather
than a normalizer because removing a redirect changes the output contract.

### 4. `read` telemetry and all-failed semantics

Multi-path/range support removed 15 exact failures in the frozen checkpoint. A later review found
two correctness issues in the success accounting itself:

- if every explicitly requested target failed, returning only `ERROR` sections is now a failed
  tool call rather than a healthy `ok(...)` response;
- the recorded count is the number of sections actually read, not `targets - failures`, because
  the aggregate byte cap can stop iteration before later targets are attempted.

Partial multi-read remains intentionally successful so one stale path does not discard useful
files that were read correctly.

### 5. Explicit shell requests could silently change language

An explicit missing/unknown shell used to fall back to another shell. On Windows that can turn a
PowerShell 7 command into Windows PowerShell 5.1 or `cmd.exe` and make the resulting parser error
look like the user's command failed.

Explicit shell selection now fails closed. `powershell` and `pwsh` are distinct brands even
though both map to the internal PowerShell shell type; path-like inputs mean the exact file; and
relative explicit paths are resolved against the command's `workdir`, where the child process
would resolve them.

### 6. Unified exec had drifted from the shared child environment

`exec_command` rebuilt a subset of the process environment instead of calling the shared
`childEnv()` contract. That copy missed important behavior: connector/control-plane secret
scrubbing, bundled-ripgrep PATH injection, and Windows PATH repair. It now starts from
`childEnv()` and adds only the dev-toolchain discovery specific to this surface.

Regression coverage sets a fake `OPENAI_API_KEY` and proves the model-run child cannot see it;
when the bundled ripgrep exists, `Get-Command rg -CommandType Application` resolves to that
binary.

### 7. Compaction's machine-settle barrier was conflated with recorder attribution settling

The handoff must not be generated while this chat still has a command/edit inside dispatch. The
barrier is therefore fail-closed: a non-zero `pendingTools` at the deadline, or an app that cannot
provide a valid pending count after bounded retries, causes "nothing was compacted" rather than
silently proceeding.

A separate recorder path can outlive the result: an unattributed finished call may spend up to
`REQUEST_ID_GRACE_MS` waiting for browser correlation before its durable record lands. That is
important diagnostic/accounting state, but the handler/result are already finished and it cannot
mutate the workspace. Counting it as `pendingTools` coupled the 20-second compaction deadline to
a 15-second attribution grace window and conservatively charged an unknown owner to every chat.

The current contract is split:

- `/activity.pendingTools` = calls still inside dispatch, the machine-settle barrier input;
- `/activity.settlingTools` = finished calls whose unattributed durable record is still landing,
  diagnostic only;
- the internal conservative `inFlightToolCalls()` still exposes the union for accounting/tests
  that mean "not fully accounted for yet".

This preserves the false-zero protection for diagnostics without making recorder bookkeeping
block a handoff about an already-settled machine.

## Multi-agent failures stay a repair target, not a removal target

The frozen audit had concentrated `agents` failures, including durable-barrier/lifecycle retries
in a few sessions. The user explicitly chose to keep agent spawning. Therefore the right follow-up
is to improve lifecycle idempotency, retry behavior, error text and durable recovery where the
data justifies it. Removing or suppressing spawn to improve the headline percentage would violate
the product requirement and would make the metric better by deleting capability rather than
making the capability reliable.

## Validation for the current repair batch

Focused validation after the 2026-08-23 fixes includes:

```text
npm run typecheck
npx vitest run test/exec-hints.test.ts test/codex-runtime-parity.test.ts test/mcp.test.ts
  -> 186 passed, 0 failed

npm run typecheck
npx vitest run test/call-context.test.ts test/mcp-inflight.test.ts test/bridge.test.ts \
  test/content-script.test.ts test/exec-hints.test.ts
  -> 334 passed, 34 skipped, 0 failed
```

One earlier combined targeted run produced a single timing failure in the Compact & Resume test
`starts one job on a press and refuses a second press while it runs` (one compact request observed
instead of two). The same test passed isolated, and the complete `content-script.test.ts` file
then passed. This is being treated as a possible load/order flake until the full CI-equivalent run
below proves the final tree; it is not being hidden as a product success.

Before shipping this batch, run `git diff --check` and the repository's full `npm run verify:ci`.
Do not quote a new final error-rate percentage until the frozen 2,151-call corpus is rerun through
the final predicates rather than estimated from symptom categories.
