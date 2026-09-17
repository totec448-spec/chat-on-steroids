# Model picker compatibility: 2.1.12

The reported UI displays effort-only headings under Latest, retains a version prefix
for explicit selections and 6 Pro, and adds a retirement caption to a version row.

## Failure boundaries and repair

- Discovery compared the full version-row text with the primary label. A retirement
  caption made that equality false and discarded the entire catalog. Navigation now
  matches the leading visible label subtree; duplicate labels and description-only
  mentions cannot authorize a selection.
- Account metadata required every category shortLabel. Display text is not model
  identity: optional/effort-only labels now use the provider family/title, or its exact
  execution slug for presentation. Slug, effort, availability, denial and bucket
  consistency checks remain authoritative.
- Closed-trigger observation accepts effort-only and version-prefixed labels, including
  adjacent 6/Pro spans. A prefix must agree with the observed execution model. A known
  account denial cannot fall through to the older closed-trigger observation path.

## Verification scope

`test/model-picker-state.test.ts` includes regression cases for captioned rows, ambiguous
and description-only matches, missing/effort-only titles, old and new closed labels,
conflicting execution identity, denial checks and unchanged drafts/route ownership.
The hotfix preparation runs these new regressions against the old implementation before
applying the fix, then requires the full suite, typecheck and app build. The existing
publish workflow builds and smoke-tests all six native targets from the version tag.

The screenshots establish UI presentation, not a complete provider React-state capture.
No signed-in live-browser replay was possible during this remote-only preparation. Fixture,
CI and package checks must not be described as live account validation.
