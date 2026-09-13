import { describe, expect, it } from 'vitest';
import { goalErrorMessage } from '../src/shared/goal-errors.js';

describe('Goal failure explanations', () => {
  it('distinguishes missing tool evidence from a confirmed lost connection or disabled Loop', () => {
    const message = goalErrorMessage('loop_mcp_call_missing');
    expect(message).toContain('cannot tell whether the tool connection was lost');
    expect(message).toContain('Loop remains enabled');
    expect(message).not.toMatch(/logged out|sign in|tunnel is off/i);
    expect(goalErrorMessage('goal_reply_not_pending')).not.toContain('No MCP tool call');
  });

  it('distinguishes oversized input from oversized helper output, including wrapped failures', () => {
    expect(goalErrorMessage('request_failed: goal_context_too_large')).toContain('Shorten the task');
    expect(goalErrorMessage('reply_too_long')).toContain('helper wrote a continuation');
    expect(goalErrorMessage('stream_record_too_long')).not.toContain('Shorten the task');
    expect(goalErrorMessage('request_failed: fetch failed')).not.toContain('too long');
  });

  it('retains native delivery and recognized protocol causes through bounded request wrappers', () => {
    expect(goalErrorMessage('request_failed: goal_browser_send_failed: Temporary Chat was not confirmed.'))
      .toBe('The helper prompt could not be delivered. Temporary Chat was not confirmed.');
    expect(goalErrorMessage('request_failed: request_failed: invalid_goal_decision_json')).toContain('unusable continuation');
    expect(goalErrorMessage('request_failed: stream_record_too_long')).toContain('oversized response');
    expect(goalErrorMessage('request_failed: goal_browser_send_failed: ' + 'x'.repeat(400)))
      .toBe('The helper prompt could not be delivered. ' + 'x'.repeat(200));
    const generic = goalErrorMessage('request_failed');
    expect(goalErrorMessage('request_failed: unexpected_private_cause')).toBe(generic);
    expect(goalErrorMessage('request_failed: fetch failed')).toBe(generic);
    expect(goalErrorMessage('request_failed: '.repeat(10) + 'no_api_key')).toBe(generic);
  });

  it('explains known provider failures without echoing arbitrary provider diagnostics', () => {
    expect(goalErrorMessage('auth_rejected: private provider detail')).toContain('Check its API key');
    expect(goalErrorMessage('auth_rejected: private provider detail')).not.toContain('private provider detail');
    expect(goalErrorMessage('rate_limited: limit')).toContain('rate-limiting');
    expect(goalErrorMessage('http_503: upstream unavailable')).toContain('HTTP 503');
    expect(goalErrorMessage('invalid_goal_decision_json')).toContain('Nothing was sent');
  });

  it('keeps uncertain delivery distinct from a safe retry and preserves readable errors', () => {
    expect(goalErrorMessage('goal_browser_send_unconfirmed')).toContain('avoid sending it twice');
    expect(goalErrorMessage('goal_browser_send_failed')).toContain('could not be delivered');
    expect(goalErrorMessage('Enter a task of at most 16000 characters')).toBe('Enter a task of at most 16000 characters');
    expect(goalErrorMessage('future_goal_error')).toContain('Check the app diagnostics');
  });
});
