# Setup Connect draft handoff — 2026-09-24

## Reproduced failure

The Setup `Connect` button decided readiness only from persisted `AppState`. Tunnel ID was saved
by `change`, while the API key was saved by `blur`. With a freshly pasted key, the button remained
disabled; a disabled button cannot receive the click that would blur the field, so the key never
became durable. The sidebar Connect action saw the same stale state, reopened Setup and returned,
which looked like a no-op.

ChatGPT login inside Internal Chromium is deliberately unrelated. It proves provider login, not
that the local MCP server and OpenAI tunnel are configured or running.

## Repair

- Persisted setup facts remain the authority for runtime and wizard completion.
- Button readiness additionally projects valid Tunnel ID/API-key drafts currently visible in the
  Setup form, solely so the user can initiate the commit.
- Setup and sidebar Connect now share one action owner.
- That owner stores the exact tunnel settings, awaits the settings queue, stores the API key in
  the selected setup profile, awaits secure storage, rechecks persisted readiness and only then
  calls `connection:connect`.
- A genuinely missing value still routes to, scrolls to and focuses the exact Setup step.
- An already configured connection keeps its previous direct path and does not wait on unrelated
  save promises.

No tunnel backend, Internal Chromium subsystem, plugin manager or credential storage contract was
changed.

## Validation

- Mainstream `test/renderer-state.test.ts`: 54/54 passed.
- Internal `test/renderer-state.test.ts`: 55/55 passed (one pre-existing Internal-only case).
- Typecheck passed in both repositories.
- `git diff --check` passed in both repositories.
- Mechanical Impeccable detector reported no findings for the renderer change.

The regression test covers both Connect controls and proves the order
`settings → API key → connection` from unsaved valid drafts.

A post-repair Internal x64 test installer was produced from the mirrored implementation. No
mainstream installer, commit or push was produced at this checkpoint.
