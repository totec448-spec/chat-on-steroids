# Usage model attribution

The baseline estimate caps final frontend context at 400,000 tokens when the
observed account catalog offers any Pro model or Pro reasoning option, otherwise
256,000, times unique local tool calls divided by two. This account-wide ceiling
applies to ordinary and Pro models alike. Historical model usage is not availability
evidence. The cap is included in the returned Usage snapshot and cache revision, so
catalog changes recalculate existing totals. Recorded token totals and compaction
are unchanged.
A model switch changes attribution of subsequent calls; it does not
split the frontend context or increase the call count. Each call's day receives its
share of the frontend's final context.

Recorded event model and effort metadata establish chronological selection within a
frontend. Explicit call metadata overrides that call. Native user messages without
selection evidence reset inheritance; app-injected `input:` rows neither establish
nor reset it. Frontend changes, session starts and unattributed calls isolate the
selection. Missing historical selection is visibly assumed GPT-5.6 High. A recorded
model without effort stays effort-unknown rather than acquiring the legacy default.

The existing versioned durable usage cache now stores daily model/effort totals.
Unchanged session revisions reuse them across process restarts. Changed revisions
rebuild only that session and removed recordings remove their cached contribution.
The model totals and daily totals derive from the same rows, without a second cache.

Usage displays model/effort token totals and cached-input equivalent costs. The
divisor, cost multiplier (default 1.2), and each model's USD-per-million cached-input
comparison rate are editable display preferences under one localStorage key.
Changing them projects cached baseline totals without rereading transcripts.
Verified Sol, Astra and GPT-5.5 rates initialize automatically from the shared
formula default; other model rates remain unknown until entered. Partial costs expose the
unpriced token count and are never presented as a complete bill or official price.
The static Usage HTML owns the divisor and multiplier controls; renderer startup
only binds them. The obsolete comparison-model picker and published-price claims
were removed. Model rate fields are generated from the recorded model rows.

Validation: session-usage tests cover model switches, effort changes, duplicate
calls, unknown native selection, injected rows, frontend isolation, late revision
changes, persisted model-cache reuse, mutation isolation, and per-model formula
projection. Source tests and typechecking do not establish installed or browser proof.
The renderer interaction test loads the real HTML, changes divisor/multiplier/rates,
rejects an invalid divisor, verifies no recording refetch, and restores preferences.
Formula text, editable controls, rates and pricing sources now live in a native
collapsed details disclosure named "Edit cost formula". The total and model/day
breakdowns stay outside it. The same interaction test exercises opening/closing
the disclosure and verifies calculations still update. Known feature quotas use
human labels (Deep research, File uploads, Pasted text files, Image generation),
and missing model balance text no longer assumes a position for the quota rows.

## Official rate verification, 5 September 2026

The following official pages were searched and opened directly. These are Standard
short-context cached-input USD rates per million tokens, before the user's 1.2
comparison multiplier; they are suitable automatic comparison defaults:

| Exact model ID | Cached input | Official evidence |
| --- | --- | --- |
| `gpt-5.6-sol`, alias `gpt-5.6` | $0.40 | [Sol model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol), Pricing; the introduction explicitly establishes the alias |
| `gpt-6-astra` | $1.00 | [Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra), Pricing |
| `gpt-5.5`, snapshot `gpt-5.5-2026-04-23` | $0.50 | [GPT-5.5 model page](https://developers.openai.com/api/docs/models/gpt-5.5), Pricing and Snapshots |

The [official pricing table](https://developers.openai.com/api/docs/pricing)
also distinguishes long-context rates: Sol cached input $0.80 and Astra $2.00.
Astra's model page identifies the threshold as more than 272K input tokens.
The app's configurable comparison formula is not an implementation of every API
service-tier, context-length, cache-write or residency billing condition.

No separate exact `gpt-6-pro` or `gpt-6-astra-pro` API price was established by
official model/pricing searches. Do not manufacture either alias. Astra's
[model guide](https://developers.openai.com/api/docs/guides/latest-model) explicitly
links its supported pro mode to the
[reasoning-mode documentation](https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode).
That documentation says pro mode bills the aggregate model work at the selected
model's standard token rates, increasing token quantity rather than specifying a
separate per-token rate. Applying Astra's rate to a recorded Astra model with pro
mode is supported by those documents; equating an unverified ChatGPT UI model slug
with Astra is not. The reasoning-mode section still introduces itself through
GPT-5.6 examples, while the Astra guide links it explicitly.

The authorized implementation follow-up centralizes these four exact ID/alias
defaults in DEFAULT_USAGE_FORMULA. The renderer links the official sources and
verification date beside the editable formula. Existing saved edits override the
defaults; newly verified defaults fill previously absent models. Explicitly clearing
a rate persists null so it stays unpriced after restart. No GPT-6 Pro alias was added.

## GPT-6 Pro rate verified 2026-09-06
Added exact gpt-6-pro alias to the existing cached-input comparison formula at USD 1 per million tokens. Official Astra model page: https://developers.openai.com/api/docs/models/gpt-6-astra (input 10, cached input 1, output 50 USD per million; long-context premiums remain outside this comparison formula). ChatGPT naming: https://help.openai.com/en/articles/20001354-gpt-56-in-chatgpt identifies GPT-6 Pro as powered by GPT-6 Astra. This is the existing editable comparison estimate, not a ChatGPT subscription bill. No formula divisor/multiplier changes.


## Recorded picker pricing fixed 2026-09-07

The screenshot's `gpt-5-6-thinking` row was unpriced because the comparison and rate editor used the recorded ID directly. The provider picker fixture in `test/model-picker-state.test.ts` identifies that exact ID as GPT-5.6 Sol. The shared `usageRate` projection now resolves that exact ID to the Sol rate; the calculator and editor both use it. Recorded model IDs, effort, token cache, divisor and multiplier stay intact. An explicit per-ID edit, including zero or null, wins over the alias. Unknown and lookalike IDs remain unpriced.

Official Standard short-context cached-input rates were checked on 7 September 2026: [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) $0.40, [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra) $0.20, [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) $0.02, [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) $1.00 and [GPT-5.5](https://developers.openai.com/api/docs/models/gpt-5.5) $0.50 per million tokens. Terra and Luna exact API IDs now have defaults. No speculative provider aliases were added. These remain editable comparison prices, with the existing context-length/service-tier limitations above.

The four model keys present in the current usage cache are `gpt-5-6-thinking`, `gpt-5.6`, `gpt-5.6-sol`, and `gpt-6-pro`; all now have a baseline. The screenshot's 427245 tokens project to $0.2050776, displayed as $0.21 at the default formula. The regression first failed with all 427245 tokens unpriced; then shared/renderer tests passed, including raw ID retention, unknown IDs, explicit rates, and clearing/reloading an alias rate without rereading recordings. Source and tests only; no package, installation or live UI proof was performed for this change.
