/**
 * The one `UnifiedExecProcessManager` for this app.
 *
 * Codex hangs the manager off `session.services`, so every `exec_command` and `write_stdin` in a
 * conversation shares it and a session id stays meaningful between calls. This connector has one
 * long-lived main process rather than a per-conversation session object, so the manager is a
 * module singleton -- the same lifetime, reached the same way.
 */

import type { TruncationPolicy } from './truncate.js';
import {
  DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  UNIFIED_EXEC_OUTPUT_MAX_TOKENS
} from './unified-exec-constants.js';
import { UnifiedExecProcessManager } from './unified-exec.js';

export const unifiedExecManager = new UnifiedExecProcessManager(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS);

/**
 * The budget for output the model was given no way to ask about.
 *
 * `formatExecOutputForModel` takes a policy and nothing else, so for the intercepted `apply_patch`
 * path this value *is* the whole budget rather than a ceiling over a request. It is therefore the
 * advertised default, stated in the same unit the contract is written in.
 */
export const DEFAULT_TRUNCATION_POLICY: TruncationPolicy = { kind: 'tokens', tokens: DEFAULT_MAX_OUTPUT_TOKENS };

/**
 * The ceiling for the tools that *do* take `max_output_tokens`, which is a different job.
 *
 * `modelOutputMaxTokens` is `min(max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS, policyTokenBudget(policy))`.
 * Two limits meet in that expression and only one of them is the default: `resolveMaxTokens`
 * supplies the 10_000-token default when the caller omitted a budget, and the policy is the safety
 * ceiling over whatever the caller did ask for. Setting the policy to the default collapses both
 * roles into one and makes every explicit request above 10_000 inert — the same class of bug, one
 * order of magnitude up, as the `{ kind: 'bytes', bytes: 10_000 }` policy that made the real ceiling
 * 2_500 tokens while `MAX_OUTPUT_TOKENS_DESCRIPTION` promised the model 10_000.
 *
 * So the ceiling is the largest output that can physically reach here: `HeadTailBuffer` stops
 * collecting at `UNIFIED_EXEC_OUTPUT_MAX_BYTES` (1 MiB), and `UNIFIED_EXEC_OUTPUT_MAX_TOKENS` is
 * that same cap expressed in the truncator's four-bytes-per-token estimate. `min(request, policy)`
 * is preserved exactly: omitted yields 10_000 tokens, an explicit 30_000 yields 30_000, and an
 * absurd request is bounded by a limit the collection buffer has already enforced in bytes.
 */
export const EXEC_OUTPUT_CEILING_POLICY: TruncationPolicy = {
  kind: 'tokens',
  tokens: UNIFIED_EXEC_OUTPUT_MAX_TOKENS
};
