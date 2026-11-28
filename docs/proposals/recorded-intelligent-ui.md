# Proposal: faithfully mirror recorded ChatGPT rich-reply visuals

**Status:** Design discussion only. This document changes no application behavior.

**Concrete evidence:** [one English fictional static Bento in ChatGPT, the installed app and the recorded
experimental timeline](recorded-intelligent-ui-evidence.md), including missing structure,
which attributes are already recorded, and an isolated renderer-only margin
experiment. This proposal PR contains no runtime implementation.

## Problem and existing behavior

Chat On Steroids can already present parts of recorded ChatGPT replies as rich
cards, charts, tables and other layouts. In particular, [#1743](https://github.com/totec448-spec/chat-on-steroids/pull/1743)
established safe presentation of recorded cards/charts and a text-matching guard;
[#2152](https://github.com/totec448-spec/chat-on-steroids/pull/2152)
keeps chart directives inside code examples literal. This proposal would build
on those owners, **not** introduce a competing reply renderer.

**User goal:** see an already-generated ChatGPT reply **inside the CoS chat
timeline with the same visualizations as the original browser conversation**.
There must be no special prompt, new UI generation, or separate designer. The
existing *Open in browser* action remains available as a way to view the
unaltered official experience, but is not a replacement for this timeline goal.

Some newer rich replies contain visual structure beyond the subset currently
restored. Their fallback text is readable, but loses nested cards, chart
presentation, column spans, captions and relative hierarchy. Blindly replaying
the browser DOM, bundling provider CSS or guessing controls from prose would
be unsafe: the browser representation can contain provider-specific code and
state that the app did not capture.

## Intended outcome

Mirror the **visual content of the same recorded reply** in the CoS timeline,
initially as a faithful **read-only presentation** of an explicitly supported
subset. Keep the canonical recorded message as the source of truth and retain
today's Markdown fallback when structural evidence is insufficient. Visual
fidelity is the acceptance goal, measured side by side against the original
reply at comparable viewport and theme. This is **not** a second generative
UI compiler, not a promise of pixel-perfect parity and not a claim to execute
provider React callbacks.

The first implementation PR should cover only **static Bento/card hierarchy**:

- Supported: title, text, caption, box, row, bounded grid/grid-item, badge,
  divider and existing safe table presentation. Preserve text order and links
  under the current sanitizer; avoid duplicating existing table/chart logic.
- Excluded initially: provider forms or form submissions, generated scripts,
  remote style sheets, executable SVG, map controls, arbitrary animations,
  streaming state, generative applications and inferred calculations.
- Existing chart and code-example handling must remain unchanged. Add chart
  extensions only in a separate follow-up with a typed, verifiable data source.

For widgets that cannot be reproduced accurately as safe DOM, later design
reviews may consider an **explicitly bounded, static per-widget visual
snapshot** as an alternative to a misleading approximation. A snapshot
would be noninteractive, preserve a textual/accessibility fallback and never
silently capture or publish an entire account page. Do not introduce such a
path as part of the first static-layout PR without a separate privacy and
security decision. The original authenticated browser remains the source of
truth for live interactions.

## Ownership and trust boundaries

The intended path is:

1. **Browser recorder** observes an assistant reply in a browser already
   connected by the person. It must respect the existing exact conversation,
   message and turn ownership rules; a nearby tab or matching title is not
   evidence of ownership. An incomplete or still-changing turn is not final.
2. **Stored message** retains canonical text. If an additive structured view
   is needed, it is versioned, bounded and marked as optional presentation
   data. Do not create a new authority for Send, recovery, identity or tools.
   Do not overwrite or silently migrate earlier recordings.
3. **Renderer** accepts only allowlisted elements, attributes and bounded
   structural hints; it builds app-owned DOM with text nodes. No captured
   scripts, event handlers, URLs or raw CSS execute. Unrecognized parts stay
   safely readable through the canonical response.
4. **Revision guard** ties the presentation to the same saved message and
   current canonical text. Edited text, truncated capture, ambiguous matches,
   mixed versions or mismatched numerical data must fall back to Markdown;
   never show a stale chart or a layout belonging to another reply.

Prefer extending the already-owned `extension/fiber.js` capture and
`src/renderer/chat.ts` rendering/sanitization path. Any new fields, message
formats or extension events require a documented contract update in `AGENTS.md`
and compatibility tests. Avoid hidden browser API calls or account/tunnel
switching to obtain extra UI data.

## Presentation and accessibility constraints

- Use the app's **semantic theme tokens**, not provider CSS, hard-coded
  brand colors or screenshots as a styling contract. Respect dark/light mode,
  high contrast, increased text size and reduced motion.
- Bound grid columns and spans. Preserve reading order, visible labels,
  focus visibility and responsive stacking down to narrow windows.
- Native `select`, radio, checkbox and slider elements that cannot be
  reconstructed from recorded state remain inert with an honest explanation.
  A later, separately reviewed PR may support strictly typed **local-only**
  interaction without writing to the provider or pretending it did.
- Any new person-facing UI strings, including accessibility text and fallback
  reasons, ship through all **12 existing translations** with that PR.
- No additional provider requests, background polling, metrics, telemetry or
  account changes should result from viewing a recorded reply. No regeneration,
  new ChatGPT prompt or invented component data. Bound snapshot bytes and DOM
  node counts, and test the cost of large replies.

## Suggested incremental PRs

These are independent review milestones, **not** commitments to ship every
component. Keep each implementation PR within the usual 600 changed-code-line
limit, or explicitly agree on an exception before implementation.

1. **Static visual mirroring:** start with the existing recorder, extending
   its optional, versioned allowlisted representation only where needed;
   compare the original and CoS render of the *same* fictional Bento reply,
   including grid spans, type hierarchy and theme; Markdown fallback.
2. **Exact chart data and accessibility:** only additional chart shapes whose
   categories, metric names and values can be independently verified from
   recorded machine-readable evidence. Reuse the current chart renderer.
3. **Known local controls:** a separate typed contract for recorded values,
   explicit local state, no provider action or implied synchronization.
4. **Broader components:** maps, diagrams or app-like content only after
   separate security and feasibility reviews. Unsupported UI stays readable.

Each implementation PR should have a fail-first regression, the project-wide
`npm run verify` gate, appropriate `npm run verify:ui` checks, and real-Electron
before/after screenshots with **fictional** text, names and paths. The first
docs-only proposal requires none of those runtime changes or screenshots.

## Acceptance cases for the first implementation

| Case | Required behavior |
| --- | --- |
| Supported, complete assistant reply | Show the same visual hierarchy in CoS without losing canonical text |
| Same fictional reply in browser and CoS | Side-by-side visual proof at matching viewport/theme; no extra generation |
| Plain Markdown or old saved message | Render as before, no migration required |
| Truncated, malformed or ambiguous capture | Reject rich layout; safe Markdown fallback |
| Canonical text edited after capture | Reject the obsolete layout |
| Missing node, conflicting span, excessive nesting | Bound or refuse structure; never create overflow or new authority |
| Script, handler, dangerous URL or untrusted style | Never execute or import it |
| Code fences and inline code | Keep literal DIL/chart syntax literal, as today |
| Non-English reply and all supported app languages | Use structural fields; no English keyword heuristics |
| Dark/light, high contrast, zoom and narrow width | Maintain readable text, visual hierarchy, keyboard access |
| Windows/macOS/Linux and restart/reopen | Stable rendering; old data remains readable |
| Control-like DOM without typed behavior | Clearly read-only; never submit to ChatGPT |

Tests should include a **small synthetic fixture with placeholder data**, plus
one explicitly authorized, sanitized real-app rendering proof if appropriate.
No real account screenshots, identifiers, conversation contents, credentials or
machine paths belong in the public PR. The browser integration is not an
official ChatGPT API and must follow the project's responsible-use policy.

## Questions for the maintainer

1. Is a **static-only Bento/layout first PR** the right review boundary,
   considering the existing card/chart work in #1743?
2. Should the capture use an optional additive format or only the safe DOM
   attributes already stored today? Which component/size limits belong at
   the recorder versus renderer boundary?
3. Should the feature be enabled by default only after the current fallback,
   or hidden behind an experimental preference while its coverage is small?
4. When exact safe structural reproduction is unavailable, should CoS keep
   Markdown only, offer a separately reviewed static widget snapshot, or
   direct the person to the existing *Open in browser* action?

The goal of this draft is to agree on those boundaries **before** submitting
the implementation. It does not include the experimental prototype branch.
