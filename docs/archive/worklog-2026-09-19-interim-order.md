# Reloaded interim messages in the desktop timeline

## Problem and change

After a provider-page reload, later assistant interim messages could be recorded without a
document-local turn ID. Their provider creation times were correct. The desktop grouped all
known tool calls under the original response, then displayed the unowned interim messages
below that entire group. Each additional tool pushed the older messages further down.

The canonical assistant keys already preserve the provider's working-turn and exchange UUIDs.
The shared timeline projection now uses that exact pair to recover a display boundary from an
existing assistant message whose local response is known. It handles both the older parent-based
key and the creation-time-based key. All store read paths supply the canonical message map,
including anchors and conflicting owners outside the current page.

This changes only `turnOrigin` presentation metadata. Original message IDs, separate authored
blocks, timestamps, origin positions, revision cursors, journal bytes and canonical shards stay
unchanged. No lifecycle turn ID, completion proof, recovery permission or caller authority is
inferred. Partial identities, raw IDs, another agent and conflicting known/unknown response
owners do not establish a join. Existing exact lifecycle aliases can resolve to one boundary.

## Evidence and validation

The reported private recording contains both forms of unowned interim message. Its first
interim message still has the original owner and the same native response pair. A read-only
snapshot reproduces the screenshot ordering without editing the installed application's data.

The regression failed before the change by placing the interim after both later tools. Shared
chronology and pagination tests then passed, including negative identity cases. Store tests
exercise incremental history, tail/forward pages, the activity feed and cold restart with
unchanged stored bytes. The renderer test checks separate tool groups and an expanded group
through live additions and an unchanged repaint.

Both original interim messages were replayed between the correct preceding/following tool
calls. All 360 recording windows retained complete-transcript relative order. The real Electron
renderer replay retained every expected canonical row, with no duplicates or missing rows and
zero measured paging drift. The resulting screenshot was visually reviewed. The existing dense
history, native-wheel, interjection and live-refresh checks also passed. TypeScript passed.

The complete focused run passed all 379 tests in the chronology, transcript-window, session
store and desktop timeline files. The full project verification then ran against an isolated
snapshot of the shared working tree: 212 test files passed, four were skipped, 5,347 tests
passed and 45 were skipped. The separate MCP shutdown run passed all six tests. Privacy,
dependency notices, pinned native source checks and TypeScript also passed. The production
build completed successfully on the same snapshot. A source comparison found only unrelated
worklog edits during verification; the tested implementation remained unchanged.

Private recordings, screenshots and diagnostic scripts remain in ignored output directories.
The installed application and browser extension have not been replaced or restarted.
