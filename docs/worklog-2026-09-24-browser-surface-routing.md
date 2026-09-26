# Browser surface routing hardening — 2026-09-24

## Failure

A session explicitly asked to use Browser Use for a local Vite preview. The model described the
correct intent, then called Desktop `browser_tabs` three times. With no companion browser present,
Desktop returned its ordinary Chrome/companion diagnostic and the model incorrectly reported that
Browser Use required the companion extension. Core `browser` was never invoked.

## Invariant

- Browser Use / Browser panel → Core `browser` only.
- Existing companion-exposed or ChatGPT tab → Desktop `browser_*` only.
- A missing companion browser is not evidence about Browser Use availability.
- The two implementations remain independent. Guidance may name the other surface but never
  imports, routes or dispatches to it.

## Change

One shared vocabulary now supplies connector discovery, initialization instructions and tool
descriptions. Desktop's former broad “prefer browser_* for web work” guidance was removed.
Every Desktop browser declaration identifies itself as companion-browser control; Core `browser`
identifies the isolated Browser Use panel. A no-companion result is structured as
`surface: desktop_companion_browser` and directs a Browser Use request to Core instead
of implying that Browser Use is offline. Cached conversations that still choose Desktop therefore
receive truthful correction from the live handler.

No tool was renamed, preserving existing cached schemas and callers. No automatic cross-surface
fallback was added.

## Validation

Run in mainstream and Internal Chromium repositories:

- `npm test -- --run test/browser-tool.test.ts test/browser-control.test.ts test/tools-browser.test.ts test/mcp-user-instructions.test.ts --reporter=dot` — 43 passed.
- Focused `test/mcp.test.ts` surface identity/discovery/schema-budget cases — 4 passed.
- `npm run typecheck` — passed.

The changed production source and focused tests are byte-identical across both repositories;
their product maps retain their intentional mainstream/Internal Chromium differences.
