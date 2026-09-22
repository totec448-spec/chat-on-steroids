# Selective GitHub fixes — 22 September 2026

The review covers 71 open issues and 19 open PRs. The [complete disposition ledger](github-triage-2026-09-22.md) separates reproduced bugs, accepted ideas, superseded patches and unresolved field evidence. Eight focused changes were implemented; routine Linux, Windows and macOS CI remains unchanged.

## Changes

- **Plugins page (#350/#351):** both controls open the current `/plugins` route. The signed-in provider page and both renderer actions were checked.
- **Explicit adopted-Astra input (#361):** an idle conversation does not need an earlier locally recorded terminal event before accepting a new manual message. Current activity, tool execution and native Send guards remain; automatic after-turn checkpoints still need confirmed completion.
- **Automatic compaction cancellation (#357):** record the current source/handoff turn refusal before durably retiring the ticket. The existing checkpoint queue serializes claim, commit and cancellation. A late summary cannot revive a cancelled ticket, and an already owned commit cannot also report a successful abort.
- **Explicit plugin refresh retry (#362/#363):** a successful user Restart gives matching unclaimed, non-manual, unfinished refresh debt a fresh ID. The existing serialized ledger owns the write and wake. No extra browser retry owner is introduced.
- **Project order (#354/#355):** whole project groups reuse bounded sidebar ordering and its existing local persistence. Drag the heading or use Alt+Up/Down; keep chats, selection and disclosure attached to their original project.
- **Turkish (#366):** adapt the reviewed translation to both current language controls, preserve numbered arguments and authored content, use Turkish-aware settings search, and translate elapsed minutes. Include current catalog entries added since the original contribution.
- **Reading position (#359):** replace the 40-pixel near-bottom follow rule with one-pixel rounding tolerance. Repeated notifications from another chat can no longer reclaim a deliberate reading position near the tail.
- **Installer lifetime (#345):** retain installer ownership until the child `close` event. Preserve the existing deadline, error handling and process-tree teardown; callers must not retire a staged runtime on an earlier `exit` event.

## Validation

Before editing, the new adopted-Astra, cancellation, near-tail scrolling and installer-lifetime regressions failed at their intended boundaries. Focused suites passed after correction. Native Electron acceptance covers project drag/keyboard/persistence, near-tail background refresh and 72 setup layouts including Turkish at normal, zoomed and narrow sizes. The real Windows installer-environment test launches a copied executable and removes the temporary profile immediately after completion.

On the shared working tree, `npm run verify` passed: **6,007 tests plus 26 separately run desktop/shutdown tests**, with 47 platform/opt-in skips. Privacy, license notices, pinned native sources and TypeScript checks passed. This is evidence for that working tree; the separately prepared public integration is verified independently below.

The isolated public integration also passed `npm run verify`: **5,817 tests plus 26 desktop/shutdown tests**, with 47 platform/opt-in skips. Its production build and all three native Electron scripts passed independently: `verify-sidebar-setup.cjs`, `verify-setup-guide.cjs` (72 layouts) and `verify-chat-opening-scroll.cjs`. The Turkish narrow layout was inspected visually. The different test totals reflect unrelated ongoing work retained outside the public integration.

No app installation, version bump, packaged release or native macOS interaction is claimed by this worklog.

## Review boundaries and credit

The default-on Business approval patch (#349) is not adopted. Its connector-name matching and missing current-turn ownership do not establish action consent, including for external plugin actions. The broad native Mac patches remain open for specific physical negative cases. The elapsed-work compaction and poll-count page-reopening patches are declined because they bypass existing cancellation or browser ownership.

The red Windows jobs on #325 and #317 failed live-plugin cleanup with EBUSY; they are not evidence that those PRs caused a shutdown or model-selection failure. The installer-close regression is independently demonstrated, but this change does not assert every CI cleanup failure has the same cause.

Credit: lavalava45 (#351/#363), 27mfp (#355), ayhanmalkoc (#366), and Haz4rdovisk (#345 installer close). Contributor records and the fresh public commit retain their GitHub noreply co-author identities. No private local branch ancestry or captured user/session evidence is published.
