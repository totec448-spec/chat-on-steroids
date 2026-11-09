# Alternate ChatGPT page compatibility, issue #311

## Failure and source

The affected account reported titles reaching the app while messages remained empty and model
discovery stayed pending. The reporter's follow-up after #317 still showed both symptoms.
The busy-tab/deadline fixes in #317 did not teach the recorder the alternate page model.

@ehkogh's draft #318, inspected at `c18f289c14f7237810ac1b5b91409d07a08d72b9`, provided concrete
editor, turn, picker and stream fixtures. This change adapts that contribution rather than
merging the entire draft. @redzrush101 supplied the original report, structural screenshot and
unsuccessful retest. Both contributions are credited in CONTRIBUTORS.md.

## Narrow repair

The marked shell composer contains an id-less editable textbox. Its picker portal and version
toggle have different data attributes, and its owner exposes evaluated powers and version
options rather than the classic picker-state object. A bounded adapter translates that state
into the existing snapshot, preserving exact execution ids, explicit denials, version traversal,
requested effort and restoration. The old native picker remains supported.

A shell exchange contains the user slot, activity and answer together. The MAIN helper reads
only the mounted row's typed items. Exact provider message ids and same-scan slot stamps feed
the existing recorder; no layout key becomes an invented message id. Tool identity comes from
the actual call id and connector/tool pair. A per-call completion flag can acknowledge that
call, but an ended/cancelled turn cannot acknowledge all calls. The last eligible final item
must itself be complete and belong to a completed turn before it supplies terminal evidence.

For a local thread id, the helper may read a bounded exact local/server pair from the native
query key. It never reads cached conversation text or chooses a message-tree branch. Complete
root-add stream events and UUID request ids use the existing request-origin and app receipt
pipeline. Partial patches and quoted metadata provide no such evidence.

The recorder and MAIN helper advance together to version 15; this is not an app release/version
bump. The browser repair path still restores the matched adapter/helper/recorder pair.

## Deliberately excluded

No generic A/B switch replaces the classic reader. Quoted markers cannot select a renderer.
No synthetic tool results, last-child cache traversal or positional Chat/Work button selection
is introduced. The native shell transcript/activity stays visible: alternate Overwrite,
activity chrome, attachment handling and literal-paste changes from #318 are outside this fix.
Id-less private/activity items are not promoted into invented canonical messages.

## Existing authorized work preserved

The publication snapshot includes the pending #317 discovery fixes and the previously implemented
follow-up/recorder-repair changes from the shared worktree. It also retains the newer public
#316 recovery/journal changes through three-way integration. Unrelated source is not rewritten;
private local evidence and old private worklogs are not publication inputs.

The final full-tree snapshot also preserves the later shared route-binding and reload-activity
fixes. Opening-route binding commits the exact pending input before releasing its journal,
rechecking the document after awaits. Historical final revisions use canonical completion
after the entire batch, so they cannot clear a newer turn's activity or recovery deadline.

## Validation boundaries

The new shell suite exercises the actual DOM adapter and MAIN helper, then sends their output
through the actual isolated recorder and model-catalog publication path. It covers the original
empty-editor/empty-turn/picker failures, cancelled/unknown turns, an unselected cached answer,
conflicting local/server pairs, duplicate/recycled ids, translated controls, version selection,
denials and stale/quoted anchors. Stream regressions cover UUID root-add and socket events,
split network chunks, partial patches and quoted metadata. Classic fixtures remain separate.

The first shell regression run failed against the unchanged reader (13 failures); subsequent
integration caught a missing slot stamp and an asynchronous startup-fixture gate before the
new end-to-end checks passed. Full snapshot verification, build and CI are separate gates.
The combined production snapshot passed `npm run verify`: 5,501 tests passed and 45 were skipped,
including the separately executed six socket-drain tests. TypeScript, public-history privacy,
dependency notices and native-source metadata checks passed. The production build and Windows
installer packaging also passed through `npm run dist:x64`.

The final shared-tree additions strengthen route-binding rejection/race coverage and prove
separate session ownership for intentional sends with identical short or long opening text.
Both updated suites passed all 389 tests, and TypeScript passed again. Production code did
not change in that last addition; final-head CI remains required before merging.

The maintainer's live account has the classic interface. A fresh exact-code picker probe was
not executed because its empty test page navigated to a real conversation before input; that
conversation was left intact. The earlier #317 native check remains separate evidence. The
alternate shell is covered by the contributed structural fixtures and actual recorder pipeline,
not a claimed live acceptance on either reporter's affected account.

Installation is authorized only after the publication PR has merged and all its CI checks
have passed. The installed payload must match the verified package and the merged source tree.
