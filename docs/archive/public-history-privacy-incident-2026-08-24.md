# Public-history privacy incident — 2026-08-24

## What happened

The public repository contained a personal maintainer email in Git author and committer metadata.
Several commit messages also carried Claude provenance session URLs. The source snapshot itself
did not contain those values, and the audit found no live API key, password, or cloud credential.

The first cleanup flattened the two public branches but left two reachability paths behind: the
new root commit still used a personal email, and historical release tags still pointed at the old
commit graph. A concurrent corrective rewrite then replaced the root identity with GitHub's
numeric noreply address and deleted every historical tag. Git's force-with-lease correctly
rejected a stale concurrent push instead of overwriting that newer cleanup.

## Cleanup performed

- Both public branches now point to one root snapshot with a GitHub noreply author and committer.
- Historical tags were deleted, so normal branch and tag traversal no longer reaches the old graph.
- The local backup branches, original rewrite refs, tags, reflogs, and unreachable objects were
  removed after the public tree was verified byte-for-byte unchanged.
- The repository-local Git identity now uses the numeric GitHub noreply address.
- The published source snapshot was scanned for the exposed metadata, session URLs, and private
  Windows user paths; no tracked-tree hit remained.

GitHub still served an old commit when addressed directly by its object id, and merged pull
request 1 retained a read-only pull-request ref. GitHub documents these as server-side cached or
pull-request references that repository owners cannot rewrite. A Support request is required to
dereference the pull request, clear cached views, and run server-side garbage collection. Existing
forks and clones are independent copies and require coordination with their owners.

Deleting the historical tags converted four former releases into draft release records. The 2.0.0
release must therefore be rebuilt and published from a new clean tag through the existing reviewed
publish workflow; old candidate artifacts must not be reused.

## Prevention

- `npm run verify:privacy` audits reachable commit identities, commit and annotated-tag messages,
  and the tracked source tree without echoing a detected private value.
- Maintainer identities are accepted only when they use the GitHub noreply domain.
- Claude session provenance, the known personal mailbox, and the known local Windows user path are
  blocked in commit messages and tracked content.
- Versioned pre-commit, commit-message, and pre-push hooks enforce the same checks locally after
  `npm run hooks:install`.
- `CLAUDE.md` explicitly forbids session trailers and requires the privacy gate before commits,
  pushes, tags, and releases.
- Normal verification, CI verification, candidate packaging, and final publishing all run the
  privacy gate. The final publish job checks it again immediately before creating a release.

The rule is intentionally redundant: agent instructions prevent the mistake, Git hooks stop it at
authoring time, CI stops it at integration time, and the publish workflow stops it at release time.
