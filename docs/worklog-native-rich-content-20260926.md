# Native rich content and durable streaming refresh

## Reproduced failures

The current native transcript can contain `:chatgpt-content-reference{index="0"}`
tokens and `:::writing{...}` block containers. Treating those as ordinary Markdown
leaked transport syntax into the desktop transcript. Returned files use native
preview controls rather than ordinary HTTP anchors; dropping their unsafe
`sandbox:` URL alone preserved text but lost usable file access.

The desktop renderer also added a 400 ms delay after the main process had already
coalesced a durable session change for 400 ms. The extra delay did not provide an
additional durability guarantee.

## Changes

* Preserve a bounded, allowlisted public reference projection alongside each
  authored assistant message. Carry it through the existing recorder, canonical
  store, incremental activity feed and desktop renderer. Reference-only updates
  do not create authored work or change message chronology.
* Render writing containers as titled, copyable cards and indexed web citations
  as their observed source links. Keep code examples literal and sanitize all
  generated HTML through the existing renderer boundary.
* Render returned files as accessible cards and blue inline links. An explicit
  click resolves the recorded reference in main, then uses the existing browser
  RPC for one fixed, exact native preview action. No arbitrary JavaScript or
  local filesystem operation is accepted by the UI IPC. Readiness and input are
  separate phases with a permission recheck and a fixed document identity.
* Retain upstream public thought/preamble joins and add native Python execution
  labels from stable execution ids/status, without copying code or output.
  Unknown assistant phases cannot become public commentary.
* Remove the redundant renderer delay while retaining one active reload and a
  dirty-follow-up guard. The journal, canonical writes and main notification
  coalescing remain unchanged.
* Support an explicit `--connect` launch after a manual installation without
  modifying the saved automatic-connection preference.
* Keep Send receipts exact across the native editor's Markdown serialization:
  literal readback must come from the current, exactly stamped user slot.
  Recover a lost acknowledgement only for the single already-authorized,
  already-bound opening with matching recorded text; never repeat Send.
* Preserve the earlier locale-independent PowerShell batch parse fix. The batch
  wrapper reports its actual pre-execution parse outcome under the existing
  random framing marker, instead of inferring it from English exception text.
  Runtime failures cannot claim that preceding mutations never executed. The
  model-selector test also accepts the active locale's number grouping.

## Validation contract

Regression coverage includes exact references and file ownership, revision and
restart persistence, malformed metadata, forbidden URL/path forms, code fences,
writing-title escaping, incomplete writing streams, duplicate native controls,
native document/permission changes, real renderer card actions, and coalesced
streaming refresh without the second wait. Live acceptance additionally checks
the actual native file-preview control, not just a fabricated anchor fixture.

The change builds on the current upstream shell/agent compatibility work rather
than republishing an earlier local repair tree. No personal conversations,
credentials, browser diagnostics, runtime databases, screenshots, generated
archives or installation helpers are part of this contribution.

## Live acceptance and limits

A fresh desktop-originated conversation requested a citation, a generated text
file and a writing block. The installed app displayed the observed source link,
the public `Analyzed` activity, a titled writing card and a returned-file card.
The native `standard` writing variant is covered in addition to `document`.
An already-completed opening cleared its pending receipt without another send.

Clicking the returned-file card traversed renderer IPC, stored-reference lookup,
browser custody and native preview input. The browser displayed the generated
file's expected contents. Native code chips and ordinary file-preview buttons
both have coverage: ordinary cards may copy a reference object, so that case
requires the exact native message wrapper and a unique canonical file tuple.
Dispatch latency is logged separately from download completion. Opening a
preview does not run the returned file.

Two native Windows accessibility-tree tests still fail when the active browser
does not expose its UI Automation root. They are separate from the successful
software suite and are not suppressed or described as fixed by this change.
A worker can still fail its explicit finish call with `AGENTS_BUSY` when exact
MCP family attribution is unavailable; this presentation change does not relax
that ownership boundary. The renderer improvement removes one redundant 400 ms
wait; it does not claim faster model generation or solve every cold-page delay.
Immediately after an extension reload, the old browser incarnation can remain
in the existing presence window; ambiguous browser selection fails without
dispatch rather than choosing a possibly foreign browser.
