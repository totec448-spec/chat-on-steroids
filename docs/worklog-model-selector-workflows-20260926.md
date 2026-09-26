# Model selector and workflow correctness — R6

## Reproduction and scope

The native catalog contained seven models and eleven model/effort pairs. A single combined
slider hid some observed lanes and displayed bare numeric family captions. A Pro selection
with the provider's machine effort `medium` consequently appeared as `6 · Medium` instead of
GPT-6 Pro. This was a presentation regression, not proof that the account had lost models.

## Changes

The composer now has separate keyboard-accessible model and reasoning radio groups. All
observed models are retained, including Instant and older generations. Native display captions
are bounded metadata; execution identities remain exact. The existing hidden selects and Send
validation remain authoritative. Status-only pushes preserve focus, selection and user drafts.

Generated plans in an existing chat now carry the captured original task and complete workflow
in their first delivered instruction, including when paired with a user correction. Later
checkpoints remain literal. Generic workflow wording does not ask non-Astra models to call the
Astra-only finish tool. Older Pro Loop uses its actual after-turn eligibility rather than an
unavailable finish boundary. The existing exact-turn MCP requirement for automatic Loop remains.

User-facing Goal control saves no longer expose an uncommitted proposal or roll back over a
newer clear/resume movement. Both control ledgers reuse the existing serialized queue, with
bounded rebasing and repair of accepted state. An Off targeting the currently published mode
invalidates unaccepted mode switches. This is not a new atomic transaction across all ledgers.

Starting instructions distinguish current permission from unqualified capability claims, keep
Goal/Loop within the real task, respect Stop and explicit denials, and distinguish dispatch from
verified completion. Generated helper instructions are delivered unchanged: the synthetic typo
and punctuation-rewriting pipeline was removed.

Compaction prompts use a character allowance accounting for the saved plan and replacement
framing. Fitting briefs retain every character; oversized briefs are visibly refused with the
original chat retained, rather than deleting the middle. The bridge durably withdraws that
invalid capture instead of retrying the same oversized text forever. Handoffs distinguish real
user corrections, automatic control messages, worker claims and independently verified results.

## Evidence and limits

Signed-in native selection was exercised for all eleven observed pairs on an explicitly owned
empty helper. Each selected pair matched the requested native identity and the original choice
was restored. These checks did not send user messages or exercise every model's generation.

The actual renderer module and stylesheet passed isolated Chromium layout and interaction
checks at 1400, 1100 and 900 pixel viewports, including preservation of an unsent fixture draft.
Source tests exercise plan admission/delivery, Goal/Loop eligibility, delayed/rejected durable
writes, continuation framing, oversized refusal, unknown choices and native-caption propagation.
The test runner's normal bridge isolation remained enabled.

Installation is intentionally deferred while another real user job has active workers. A staged
archive and clean extension are not an installed/live acceptance result. No live end-to-end
Goal, Loop or Compact & Resume certification is claimed for the new build. In particular, prior
native accessibility and exact worker-attribution limitations are not fixed by a selector change.
Personal conversations, credentials, screenshots, diagnostic pages, runtime databases and local
installation helpers are excluded from the public contribution.

## Final validation record

The final broad software run completed with **5,919 passing tests, one failure and 47 skips**
across 235 files. Its only failure was the existing Skills linked-package retargeting race
fixture; neither that production subsystem nor its test was changed. The entire Skills file
then passed separately, **12/12**. A clean uninterrupted all-green broad run is not claimed.
The shutdown suite passed separately, **6/6**. Native foreground/accessibility tests were not
rerun while the other user job was active.

The final Goal-control race and Goal suites passed **154/154**, including the newer-Off and
bounded-churn regressions. TypeScript, JavaScript syntax, patch whitespace, production build,
privacy and dependency/native-source notice checks passed. The staged archive verification
compared 132 compiled files, retained 170 native unpacking entries and preserved 3,212 other
dependency/package files. The clean companion snapshot contains 18 files.

The local installer passed its read-only hash check and an actual refusal test while CoS was
running; the original process and archive were unchanged. Installation and post-install native
workflow acceptance remain deferred. Overlapping suite counts above must not be added together.
