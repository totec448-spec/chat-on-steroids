# Worker bootstrap: bounded model selection and diagnostics (2026-10-09)

## Observed failure

The Windows Core accepted a worker creation request and opened a ChatGPT page, but
the browser command remained at `model` for the host's 90-second startup deadline.
An installed 2.1.29 companion was observed; the upstream 2.1.30 release already
extends initial pickup to 45 seconds but still has an unbounded cross-version
model-selection traversal. These observations locate the failure *stage*, not
the exact failing native menu interaction (no DOM capture was available).

## Candidate correction (based on official v2.1.30)

- Within the existing native model-picker authority, stop inspecting unrelated
  versions when the requested exact provider execution slug and effort are
  already available in a checked version. Display-name matches or missing
  efforts still use cross-version checking and existing denial rules.
- Bound the model-selection operation to 42 seconds. Picker observation waits
  consume the same budget; cleanup of a native focus trap gets a final 3 seconds.
  Timeout is **failure**, never a fallback to another model or a send.
- Report `model-opening/scanning/switching/confirming/closing/timeout` through
  existing command-step progress, and retain the last stage in a failed ACK.
  Only the provider's exact available selection and closed picker can succeed.

## Validation and deployment boundary

Tests cover exact selection without unrelated version traversal, bounded timeout,
and detailed failed-ACK diagnostics, as well as existing denied-model and
cross-version cases. Run `npm run typecheck`, `npm run build`, and
`npm exec --no -- vitest run test/model-picker-state.test.ts
test/content-script.test.ts test/bridge.test.ts`.

This checkout does **not** change any live installed companion extension or
desktop binary. A complete matching extension/desktop update and real ChatGPT
worker receive-and-run verification are still required. Never call a successful
invite or tab open a running worker.
