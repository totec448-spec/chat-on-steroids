/**
 * The headless Claude seat, without a CLI.
 *
 * Every contract in `headless-claude.ts` that must fail closed is driven here through the
 * injectable runner: command construction, the subscription-only auth gate, the strict stream
 * parser, timeouts, truncation and the substitute-model refusal. The live CLI is exercised by
 * `headless-claude-live.test.ts`, which opts in by environment variable.
 */

import { describe, expect, it } from 'vitest';
import {
  HEADLESS_CODING_TOOLS,
  HEADLESS_MAX_RESULT_CHARS,
  HEADLESS_MODEL_ALIASES,
  defaultMaxTurns,
  formatHeadlessInvocation,
  headlessClaudeArgs,
  invokeHeadlessClaude,
  parseHeadlessStream,
  scrubHeadlessEnv,
  subscriptionAuth,
  type HeadlessInvocationRequest,
  type HeadlessProcessResult,
  type HeadlessProcessRunner,
  type HeadlessProcessSpec
} from '../src/main/headless-claude.js';

const SUBSCRIPTION_STATUS = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'someone@example.com',
  subscriptionType: 'max'
};

const init = (model = 'claude-fable-5-1', extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    cwd: 'C:\\work',
    session_id: 'sess-1',
    tools: [],
    mcp_servers: [],
    model,
    permissionMode: 'dontAsk',
    apiKeySource: 'none',
    ...extra
  });
const assistant = (model: string, text: string) =>
  JSON.stringify({ type: 'assistant', message: { model, role: 'assistant', content: [{ type: 'text', text }] }, session_id: 'sess-1' });
const result = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    session_id: 'sess-1',
    num_turns: 1,
    duration_ms: 2072,
    duration_api_ms: 2692,
    total_cost_usd: 0.0247,
    usage: { input_tokens: 2, output_tokens: 22, cache_read_input_tokens: 0, cache_creation_input_tokens: 3698 },
    permission_denials: [],
    ...extra
  });
const okStream = (text = 'HEADLESS_FABLE_SURFACE_OK', model = 'claude-fable-5-1') =>
  [init(), JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} }), assistant(model, text), result(text)].join('\n') + '\n';

const finished = (overrides: Partial<HeadlessProcessResult> = {}): HeadlessProcessResult => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  truncated: false,
  launchError: null,
  durationMs: 5,
  ...overrides
});

/** A runner that answers `claude auth status` and the invocation from two canned results. */
function fakeRunner(auth: HeadlessProcessResult, run: HeadlessProcessResult): { runner: HeadlessProcessRunner; calls: HeadlessProcessSpec[] } {
  const calls: HeadlessProcessSpec[] = [];
  const runner: HeadlessProcessRunner = async (spec) => {
    calls.push(spec);
    return spec.args[0] === 'auth' ? auth : run;
  };
  return { runner, calls };
}

const request = (overrides: Partial<HeadlessInvocationRequest> = {}): HeadlessInvocationRequest => ({
  prompt: 'Reply with exactly HEADLESS_FABLE_SURFACE_OK and nothing else.',
  model: 'fable',
  profile: 'reasoning',
  cwd: process.cwd(),
  maxTurns: 1,
  timeoutMs: 30_000,
  allowModelFallback: false,
  ...overrides
});

const BINARY = process.platform === 'win32' ? 'C:\\tools\\claude.exe' : '/usr/local/bin/claude';

describe('command construction', () => {
  it('builds the reasoning profile with no tools, no MCP, no skills and denied prompts', () => {
    const args = headlessClaudeArgs({ model: 'fable', profile: 'reasoning', maxTurns: 1 });
    expect(args).toEqual([
      '-p',
      '--model', 'fable',
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--permission-prompts', 'none',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-chrome',
      '--max-turns', '1',
      '--tools', '',
      '--permission-mode', 'dontAsk'
    ]);
    // The prompt is never on the command line.
    expect(args.join(' ')).not.toContain('HEADLESS');
    // Nothing here widens permissions or bypasses them.
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('bypassPermissions');
    // `--bare` would drop OAuth and demand an API key, which is the one auth this seat refuses.
    expect(args).not.toContain('--bare');
  });

  it('builds the coding profile restricted to file tools inside the working directory', () => {
    const args = headlessClaudeArgs({ model: 'sonnet', profile: 'coding', maxTurns: 25 });
    expect(args).toContain('--restricted');
    expect(args[args.indexOf('--tools') + 1]).toBe(HEADLESS_CODING_TOOLS.join(','));
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('25');
    for (const tool of HEADLESS_CODING_TOOLS.join(',').split(',')) expect(['Bash', 'PowerShell', 'WebFetch', 'WebSearch']).not.toContain(tool);
  });

  it('defaults turns to one for reasoning and a bounded loop for coding', () => {
    expect(defaultMaxTurns('reasoning')).toBe(1);
    expect(defaultMaxTurns('coding')).toBe(25);
  });

  it('keeps the model allowlist to named aliases that include fable', () => {
    expect([...HEADLESS_MODEL_ALIASES]).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
  });
});

describe('environment scrubbing', () => {
  it('removes every API-key, provider-routing, model-override and nesting variable', () => {
    const env: Record<string, string | undefined> = {
      PATH: 'C:\\bin',
      HOME: 'C:\\Users\\x',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      anthropic_auth_token: 'lower-case-spelling',
      ANTHROPIC_BASE_URL: 'https://proxy.example',
      ANTHROPIC_MODEL: 'claude-opus-5',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-from-env',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'parent',
      CLAUDE_PID: '123',
      AWS_BEARER_TOKEN_BEDROCK: 'bearer',
      CLAUDE_CONFIG_DIR: 'C:\\Users\\x\\.claude',
      OPENAI_API_KEY: 'unrelated-but-present'
    };
    const removed = scrubHeadlessEnv(env);
    expect(removed).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
      'AWS_BEARER_TOKEN_BEDROCK',
      'CLAUDECODE',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_PID',
      'anthropic_auth_token'
    ]);
    expect(Object.keys(env).sort()).toEqual(['CLAUDE_CONFIG_DIR', 'HOME', 'OPENAI_API_KEY', 'PATH']);
  });
});

describe('subscription auth guard', () => {
  it('accepts the stored claude.ai login with a subscription', () => {
    expect(subscriptionAuth(SUBSCRIPTION_STATUS)).toEqual({ ok: true, subscription: 'max' });
  });

  it.each([
    ['not logged in', { ...SUBSCRIPTION_STATUS, loggedIn: false }, /run `claude login`/],
    ['console or API-key auth method', { ...SUBSCRIPTION_STATUS, authMethod: 'console' }, /not the claude.ai subscription login/],
    ['an API key in reach', { ...SUBSCRIPTION_STATUS, apiKeySource: 'ANTHROPIC_API_KEY' }, /API key from ANTHROPIC_API_KEY/],
    ['no subscription on the login', { ...SUBSCRIPTION_STATUS, subscriptionType: null }, /no claude.ai subscription/],
    ['garbage', 'logged in', /not a JSON object/]
  ])('refuses %s', (_label, status, reason) => {
    const verdict = subscriptionAuth(status);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(reason);
  });
});

describe('stream parsing', () => {
  it('reads init, the answering model, the result and usage from a stream-json run', () => {
    const parsed = parseHeadlessStream(okStream());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.stream.init).toEqual({ model: 'claude-fable-5-1', sessionId: 'sess-1', tools: [], apiKeySource: 'none' });
    expect(parsed.stream.lastAssistantModel).toBe('claude-fable-5-1');
    expect(parsed.stream.fallback).toBeNull();
    expect(parsed.stream.result).toMatchObject({
      subtype: 'success',
      isError: false,
      text: 'HEADLESS_FABLE_SURFACE_OK',
      sessionId: 'sess-1',
      turns: 1,
      permissionDenials: 0,
      usage: { input_tokens: 2, output_tokens: 22, cache_creation_input_tokens: 3698, total_cost_usd: 0.0247, api_duration_ms: 2692 }
    });
  });

  it('records a provider substitution from the CLI’s own fallback event', () => {
    const stream = [
      init(),
      JSON.stringify({
        type: 'system',
        subtype: 'model_refusal_fallback',
        trigger: 'refusal',
        original_model: 'claude-fable-5-1',
        fallback_model: 'claude-opus-4-8',
        api_refusal_category: 'cyber'
      }),
      JSON.stringify({
        type: 'assistant',
        message: { model: 'claude-opus-4-8', content: [{ type: 'fallback', from: { model: 'claude-fable-5-1' }, to: { model: 'claude-opus-4-8' } }] }
      }),
      assistant('claude-opus-4-8', 'OK'),
      result('OK')
    ].join('\n');
    const parsed = parseHeadlessStream(stream);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.stream.fallback).toEqual({ from: 'claude-fable-5-1', to: 'claude-opus-4-8', reason: 'cyber' });
    expect(parsed.stream.lastAssistantModel).toBe('claude-opus-4-8');
  });

  it.each([
    ['a non-JSON line', 'Welcome to Claude\n' + okStream(), /line 1 .* not JSON/],
    ['an event without a type', JSON.stringify({ hello: 'world' }) + '\n' + okStream(), /no event type/],
    ['no init event', [assistant('claude-fable-5-1', 'x'), result('x')].join('\n'), /never reported its init/],
    ['no result event', [init(), assistant('claude-fable-5-1', 'x')].join('\n'), /never reported a result/],
    ['an empty stream', '', /init/]
  ])('refuses %s', (_label, stdout, reason) => {
    const parsed = parseHeadlessStream(stdout);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(reason);
  });

  it('skips unknown but well-formed events such as hooks and rate limits', () => {
    const stream = [
      init(),
      JSON.stringify({ type: 'system', subtype: 'hook_started', hook: 'SessionStart' }),
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
      assistant('claude-fable-5-1', 'fine'),
      result('fine')
    ].join('\n');
    expect(parseHeadlessStream(stream).ok).toBe(true);
  });
});

describe('invocation', () => {
  it('checks subscription auth in the scrubbed environment, feeds the prompt on stdin and reports the answer', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-must-not-leak';
    try {
      const { runner, calls } = fakeRunner(finished({ stdout: JSON.stringify(SUBSCRIPTION_STATUS) }), finished({ stdout: okStream() }));
      const invocation = await invokeHeadlessClaude(request(), { runner, binary: BINARY });
      expect(invocation.status).toBe('completed');
      expect(invocation.ok).toBe(true);
      expect(invocation.auth).toEqual({ method: 'claude.ai', subscription: 'max' });
      expect(invocation.model).toEqual({ requested: 'fable', canonical: 'claude-fable-5-1', resolved: 'claude-fable-5-1', fallback: null });
      expect(invocation.session_id).toBe('sess-1');
      expect(invocation.result).toBe('HEADLESS_FABLE_SURFACE_OK');
      expect(invocation.usage?.output_tokens).toBe(22);
      expect(invocation.turns).toBe(1);
      expect(invocation.binary).toBe(BINARY);

      expect(calls).toHaveLength(2);
      const [auth, run] = calls as [HeadlessProcessSpec, HeadlessProcessSpec];
      expect(auth.args).toEqual(['auth', 'status']);
      expect(auth.stdin).toBeNull();
      expect(run.args).toEqual(headlessClaudeArgs({ model: 'fable', profile: 'reasoning', maxTurns: 1 }));
      expect(run.stdin).toBe('Reply with exactly HEADLESS_FABLE_SURFACE_OK and nothing else.');
      expect(run.cwd).toBe(process.cwd());
      expect(run.timeoutMs).toBe(30_000);
      for (const spec of calls) {
        expect(spec.file).toBe(BINARY);
        expect(Object.keys(spec.env).map((key) => key.toUpperCase())).not.toContain('ANTHROPIC_API_KEY');
        expect(Object.keys(spec.env).map((key) => key.toUpperCase())).not.toContain('CLAUDECODE');
      }
    } finally {
      delete process.env['ANTHROPIC_API_KEY'];
    }
  });

  it('refuses before spawning the model when the CLI is not installed', async () => {
    const { runner, calls } = fakeRunner(finished(), finished());
    const invocation = await invokeHeadlessClaude(request(), { runner, binary: null });
    expect(invocation.status).toBe('launch_failed');
    expect(invocation.error).toMatch(/not installed/);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['no stored login', finished({ stdout: JSON.stringify({ ...SUBSCRIPTION_STATUS, loggedIn: false }) }), /claude login/],
    ['an API key the CLI would bill', finished({ stdout: JSON.stringify({ ...SUBSCRIPTION_STATUS, apiKeySource: 'ANTHROPIC_API_KEY' }) }), /API key/],
    ['a status command that printed prose', finished({ stdout: 'Not logged in. Run claude login.' }), /did not return JSON/],
    ['a status command that hung', finished({ timedOut: true }), /did not answer in time/]
  ])('fails closed on %s without launching the model', async (_label, auth, reason) => {
    const { runner, calls } = fakeRunner(auth, finished({ stdout: okStream() }));
    const invocation = await invokeHeadlessClaude(request(), { runner, binary: BINARY });
    expect(invocation.status).toBe('auth_required');
    expect(invocation.ok).toBe(false);
    expect(invocation.error).toMatch(reason);
    expect(invocation.result).toBeNull();
    expect(calls.map((call) => call.args[0])).toEqual(['auth']);
  });

  it('refuses a run whose init reports an API key even though the pre-check passed', async () => {
    const stream = [init('claude-fable-5-1', { apiKeySource: 'ANTHROPIC_API_KEY' }), assistant('claude-fable-5-1', 'x'), result('x')].join('\n');
    const { runner } = fakeRunner(finished({ stdout: JSON.stringify(SUBSCRIPTION_STATUS) }), finished({ stdout: stream }));
    const invocation = await invokeHeadlessClaude(request(), { runner, binary: BINARY });
    expect(invocation.status).toBe('auth_required');
    expect(invocation.error).toMatch(/API key from ANTHROPIC_API_KEY/);
  });

  it('refuses a substitute model by default and reports exactly which one answered', async () => {
    const stream = [
      init(),
      JSON.stringify({ type: 'system', subtype: 'model_refusal_fallback', original_model: 'claude-fable-5-1', fallback_model: 'claude-opus-4-8', api_refusal_category: 'cyber' }),
      assistant('claude-opus-4-8', 'HEADLESS_FABLE_SURFACE_OK'),
      result('HEADLESS_FABLE_SURFACE_OK')
    ].join('\n');
    const { runner } = fakeRunner(finished({ stdout: JSON.stringify(SUBSCRIPTION_STATUS) }), finished({ stdout: stream }));
    const refused = await invokeHeadlessClaude(request(), { runner, binary: BINARY });
    expect(refused.status).toBe('model_fallback');
    expect(refused.ok).toBe(false);
    expect(refused.model).toEqual({
      requested: 'fable',
      canonical: 'claude-fable-5-1',
      resolved: 'claude-opus-4-8',
      fallback: { from: 'claude-fable-5-1', to: 'claude-opus-4-8', reason: 'cyber' }
    });
    expect(refused.error).toMatch(/substituted claude-opus-4-8 \(cyber\)/);

    const accepted = await invokeHeadlessClaude(request({ allowModelFallback: true }), { runner, binary: BINARY });
    expect(accepted.status).toBe('completed');
    expect(accepted.model.fallback).toEqual({ from: 'claude-fable-5-1', to: 'claude-opus-4-8', reason: 'cyber' });
    expect(formatHeadlessInvocation(accepted, '/workspace')).toContain('model_fallback: claude-fable-5-1 -> claude-opus-4-8 (cyber)');
  });

  it('detects an unannounced substitution from the answering model alone', async () => {
    const { runner } = fakeRunner(finished({ stdout: JSON.stringify(SUBSCRIPTION_STATUS) }), finished({ stdout: okStream('OK', 'claude-sonnet-5') }));
    const invocation = await invokeHeadlessClaude(request(), { runner, binary: BINARY });
    expect(invocation.status).toBe('model_fallback');
    expect(invocation.model.fallback).toEqual({ from: 'claude-fable-5-1', to: 'claude-sonnet-5', reason: null });
  });

  it('reports a timeout with whatever identity the child managed to say', async () => {
    const partial = init() + '\n';
    const { runner } = fakeRunner(finished({ stdout: JSON.stringify(SUBSCRIPTION_STATUS) }), finished({ stdout: partial, timedOut: true, exitCode: null }));
    const invocation = await invokeHeadlessClaude(request({ timeoutMs: 10_000 }), { runner, binary: BINARY });
    expect(invocation.status).toBe('timeout');
    expect(invocation.error).toMatch(/within 10 s/);
    expect(invocation.result).toBeNull();
    // The init event alone is not a parseable answer, so nothing from it is trusted as a result.
    expect(invocation.session_id).toBeNull();
  });

  it.each([
    ['prose on stdout', finished({ stdout: 'Welcome!\n' + okStream() }), /not JSON/],
    ['a stream that never finished', finished({ stdout: init() + '\n' + assistant('claude-fable-5-1', 'x') }), /never reported a result/],
    ['stdout past the ceiling', finished({ stdout: okStream(), truncated: true }), /more than/]
  ])('fails closed on %s', async (_label, run, reason) => {
    const { runner } = fakeRunner(finished({ stdout: JSON.stringify(SUBSCRIPTION_STATUS) }), run);
    const invocation = await invokeHeadlessClaude(request(), { runner, binary: BINARY });
    expect(invocation.status).toBe('malformed_output');
    expect(invocation.ok).toBe(false);
    expect(invocation.error).toMatch(reason);
  });

  it('reports the CLI’s own error result as an error, not as an answer', async () => {
    const stream = [init(), result('', { subtype: 'error_max_turns', is_error: true, result: null, errors: ['Reached max turns (1)'] })].join('\n');
    const { runner } = fakeRunner(finished({ stdout: JSON.stringify(SUBSCRIPTION_STATUS) }), finished({ stdout: stream, exitCode: 1 }));
    const invocation = await invokeHeadlessClaude(request(), { runner, binary: BINARY });
    expect(invocation.status).toBe('error');
    expect(invocation.error).toBe('claude reported error_max_turns (exit 1): Reached max turns (1)');
    expect(invocation.result).toBeNull();
  });

  it('refuses a reasoning run that started with tools', async () => {
    const stream = [init('claude-fable-5-1', { tools: ['Bash'] }), assistant('claude-fable-5-1', 'x'), result('x')].join('\n');
    const { runner } = fakeRunner(finished({ stdout: JSON.stringify(SUBSCRIPTION_STATUS) }), finished({ stdout: stream }));
    const invocation = await invokeHeadlessClaude(request(), { runner, binary: BINARY });
    expect(invocation.status).toBe('error');
    expect(invocation.error).toMatch(/started with tools enabled: Bash/);
  });

  it('reports a launch failure of the model process', async () => {
    const { runner } = fakeRunner(finished({ stdout: JSON.stringify(SUBSCRIPTION_STATUS) }), finished({ launchError: 'spawn EACCES', exitCode: null }));
    const invocation = await invokeHeadlessClaude(request(), { runner, binary: BINARY });
    expect(invocation.status).toBe('launch_failed');
    expect(invocation.error).toBe('claude did not start: spawn EACCES');
  });

  it('bounds the model-visible answer and says so', async () => {
    const long = 'x'.repeat(HEADLESS_MAX_RESULT_CHARS + 10);
    const { runner } = fakeRunner(finished({ stdout: JSON.stringify(SUBSCRIPTION_STATUS) }), finished({ stdout: okStream(long) }));
    const invocation = await invokeHeadlessClaude(request(), { runner, binary: BINARY });
    expect(invocation.status).toBe('completed');
    expect(invocation.result).toHaveLength(HEADLESS_MAX_RESULT_CHARS);
    expect(invocation.result_truncated).toBe(true);
    expect(formatHeadlessInvocation(invocation, '/workspace')).toContain('result_truncated: true');
  });

  it('prints one deterministic fact per line ahead of the answer', async () => {
    const { runner } = fakeRunner(finished({ stdout: JSON.stringify(SUBSCRIPTION_STATUS) }), finished({ stdout: okStream() }));
    const invocation = await invokeHeadlessClaude(request(), { runner, binary: BINARY });
    const text = formatHeadlessInvocation({ ...invocation, duration_ms: 42 }, '/workspace');
    expect(text).toBe(
      [
        'status: completed',
        'provider: claude',
        'profile: reasoning',
        'cwd: /workspace',
        'model_requested: fable',
        'model_canonical: claude-fable-5-1',
        'model_resolved: claude-fable-5-1',
        'model_fallback: none',
        'session_id: sess-1',
        'auth: claude.ai subscription (max)',
        'turns: 1',
        'usage: input=2 output=22 cache_read=0 cache_write=3698 list_cost_usd=0.0247',
        'permission_denials: 0',
        'duration_ms: 42',
        'result_truncated: false',
        'result:',
        'HEADLESS_FABLE_SURFACE_OK'
      ].join('\n')
    );
  });
});
