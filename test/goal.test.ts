/**
 * The goal loop: the second model that stands in for the user.
 *
 * The three things worth pinning here are the three that cost something when they go wrong.
 * The *context* is a privacy boundary — what leaves this machine is the conversation and
 * nothing else, and a regression there is silent. `NO_REPLY` is the loop's stopping
 * condition, and a loop that cannot stop types into somebody's chat forever. And one draft
 * per generation is what stands between a retried request and two messages in one chat.
 *
 * The page's half — deciding that a turn is *really* over — is tested in
 * test/content-script.test.ts against the real content script.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0' },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  }
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath, setSecret } = await import('../src/main/secrets.js');
const { appendEvent, createSession, initSessionStore, resetSessionStoreForTests } = await import(
  '../src/main/session/store.js'
);
const goal = await import('../src/main/goal.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;
const realFetch = globalThis.fetch;

/** An SSE body shaped the way OpenRouter actually sends one, split where a test wants it. */
function stream(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encode = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encode.encode(chunk));
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const delta = (text: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`;

/** The non-streaming strict response shape requested from OpenRouter in production. */
function decision(action: 'stop' | 'continue', reply = ''): Response {
  return Response.json({
    choices: [{ message: { content: JSON.stringify({ action, reply }) } }]
  });
}

/** Waits for a draft to leave the two stages that mean "still working". */
async function settled(conversationId: string): Promise<NonNullable<ReturnType<typeof goal.goalViewFor>>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const view = goal.goalViewFor(conversationId);
    if (view && view.stage !== 'sending' && view.stage !== 'answering') return view;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the draft never settled');
}

beforeAll(async () => {
  dir = await makeTempDir('clf-goal-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
});

afterAll(async () => {
  resetSessionStoreForTests();
  await removeTempDir(dir);
  globalThis.fetch = realFetch;
});

beforeEach(async () => {
  goal.resetGoalStateForTests();
  await saveConfig({
    ...defaultConfig(),
    goal: { ...defaultConfig().goal, enabled: true, model: 'deepseek/deepseek-v4-flash', reasoning: 'default' }
  });
  await setSecret('openRouterApiKey', 'sk-or-test');
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('the instruction the goal model is given', () => {
  /**
   * The failure this prompt is written against is a model that answers *about* the
   * conversation — "the assistant should now implement X" — which reads as a review the
   * moment it lands in somebody's composer.
   */
  it('keeps going until the whole request and its questions are explicitly reported complete', () => {
    const prompt = goal.goalSystemPrompt();
    // The situation, stated before anything else: whose seat this is and where the goal
    // comes from when nobody supplied one.
    expect(prompt).toContain('Your job is to prompt ChatGPT');
    expect(prompt).toContain('Nobody handed you a separate goal');
    // The two moves, and the stop sentinel the app-owned output protocol maps onto.
    expect(prompt).toContain('You have exactly two moves');
    expect(prompt).toContain('NO_REPLY');
    // The named failure modes.
    expect(prompt).toContain('never invent a task the person never asked for');
    expect(prompt).toContain('never grade or summarize what it produced');
  });

  /**
   * The five worked examples are the part that fixes a small model reading the role wrong,
   * so their presence is a contract rather than decoration. Both prompts carry five, and
   * both cover the two decisions that actually go wrong: stopping when the job is done, and
   * refusing to invent work that was never requested.
   */
  it('teaches both jobs by example, including when not to speak', () => {
    for (const prompt of [goal.goalSystemPrompt(), goal.goalObjectivePrompt()]) {
      expect(prompt).toContain('Five examples.');
      for (const n of [1, 2, 3, 4, 5]) expect(prompt).toContain(`\n${n}. `);
      // At least one example must end in silence, or the model only ever learns to talk.
      expect(prompt).toContain('You answer: NO_REPLY');
    }
  });

  /**
   * The examples are monolingual on purpose, and the prompt has to say why.
   *
   * Few-shot examples bias the *language* of the output as strongly as its shape. An earlier
   * draft wrote them in the mix of English and German this app is used in, which teaches a
   * cheap model to answer an English chat in German. The rule replaces the demonstration:
   * examples in one language, plus an explicit line that the language comes from the user.
   */
  it('does not let the examples decide which language the reply is written in', () => {
    for (const prompt of [goal.goalSystemPrompt(), goal.goalObjectivePrompt()]) {
      expect(prompt).toContain("the language you actually write in is the user's");
      expect(prompt).toMatch(/written in English only/);
    }
    expect(goal.goalSystemPrompt()).toContain("Write in the person's own language and register");
    expect(goal.goalObjectivePrompt()).toContain("Write in the user's own language and register");
  });

  /**
   * The driver is the other half of the same feature and is now editable too, so it needs
   * the same contract test the gate has always had.
   */
  it('points the driver at the stated goal, and caps it there', () => {
    const prompt = goal.goalObjectivePrompt();
    expect(prompt).toContain('Your job is to prompt ChatGPT');
    expect(prompt).toContain('they have handed you the wheel');
    expect(prompt).toContain('it is also your ceiling');
    expect(prompt).toContain('Never widen it');
    expect(prompt).toContain('NO_REPLY');
  });
});

describe('what leaves this machine', () => {
  /**
   * The privacy boundary. The goal model decides whether the user's request has been met,
   * and the conversation is the only evidence it needs for that — every tool call,
   * argument, result and file path is this machine's business and stays here.
   */
  it('is the conversation and nothing else', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-goal-1' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'add the retry', truncated: false, chars: 13 }
    });
    await appendEvent(session.id, {
      time: 1_100,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'call-1',
        tool: 'read',
        attribution: 'request_id',
        requestId: 'wfr_1',
        conversationId: 'c-goal-1',
        attributionMethod: 'request_id',
        args: { text: '{"path":"/repo/secrets.env"}', truncated: false, chars: 28 },
        result: { text: 'SECRET=hunter2', truncated: false, chars: 14 },
        outcome: 'ok',
        durationMs: 1,
        summary: { kind: 'read', tone: 'neutral', title: 'Read secrets.env' }
      }
    });
    await appendEvent(session.id, {
      time: 1_200,
      source: 'extension',
      kind: 'assistant_message',
      final: true,
      message: { text: 'done, added it', truncated: false, chars: 14 }
    });
    // A streaming snapshot of the same answer. Including it would show the model the same
    // reply twice, with the half-written one second.
    await appendEvent(session.id, {
      time: 1_150,
      source: 'extension',
      kind: 'assistant_message',
      final: false,
      message: { text: 'done, add', truncated: false, chars: 9 }
    });

    expect(await goal.conversationMessages(session.id)).toEqual([
      { role: 'user', content: 'add the retry' },
      { role: 'assistant', content: 'done, added it' }
    ]);
  });

  it('collapses repeated final snapshots from a legacy append-only recording by ChatGPT message id', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-goal-legacy-snapshots' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      messageId: 'user-1',
      message: { text: 'fix the parser', truncated: false, chars: 14 }
    });
    // Pre-canonical-store recordings could append the same stable ChatGPT message more than
    // once. Both rows can be final (for example after a remount/replay), and Goal must see the
    // latest snapshot as one answer rather than two assistant turns.
    await appendEvent(session.id, {
      time: 1_100,
      source: 'extension',
      kind: 'assistant_message',
      messageId: 'assistant-1',
      final: true,
      message: { text: 'parser fixed, tests still running', truncated: false, chars: 32 }
    });
    await appendEvent(session.id, {
      time: 1_200,
      source: 'extension',
      kind: 'assistant_message',
      messageId: 'assistant-1',
      final: true,
      message: { text: 'parser fixed, tests are green', truncated: false, chars: 29 }
    });

    expect(await goal.conversationMessages(session.id)).toEqual([
      { role: 'user', content: 'fix the parser' },
      { role: 'assistant', content: 'parser fixed, tests are green' }
    ]);
  });

  it('sends the whole conversation with the instruction in front of it', async () => {
    const customPrompt = 'CUSTOM GOAL PROMPT: stop with NO_REPLY; otherwise name the missing requested item.';
    await saveConfig({
      ...defaultConfig(),
      goal: {
        ...defaultConfig().goal,
        enabled: true,
        model: 'deepseek/deepseek-v4-flash',
        prompt: customPrompt
      }
    });
    const session = await createSession({ title: 'goal', conversationId: 'c-goal-2' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'build the parser', truncated: false, chars: 16 }
    });
    await appendEvent(session.id, {
      time: 1_100,
      source: 'extension',
      kind: 'assistant_message',
      final: true,
      message: { text: 'parser written, tests pending', truncated: false, chars: 28 }
    });

    let sent: any = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent = { url, headers: init.headers, body: JSON.parse(String(init.body)) };
      return decision('continue', 'what about the tests');
    }) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-goal-2', turnId: 'g-1' });
    const view = await settled('c-goal-2');

    expect(view.stage).toBe('ready');
    // The streamed text, typed: see `humanReply` and the block at the bottom of this file.
    expect(view.reply).toBe(goal.humanReply('what about the tests'));
    expect(sent.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((sent.headers as Record<string, string>).authorization).toBe('Bearer sk-or-test');
    expect(sent.body.model).toBe('deepseek/deepseek-v4-flash');
    expect(sent.body.messages[0].role).toBe('system');
    expect(sent.body.messages[0].content).toBe(customPrompt);
    expect(sent.body.messages[1]).toMatchObject({ role: 'system' });
    expect(sent.body.messages[1].content).toContain('response schema');
    expect(sent.body.messages.slice(2, -1)).toEqual([
      { role: 'user', content: 'build the parser' },
      { role: 'assistant', content: 'parser written, tests pending' }
    ]);
    // The closing reminder sits after the transcript, not with the instruction: a long chat
    // pushes everything above it out of the model's effective attention, and what it read
    // last is what it obeys. Placement is app-owned; the policy it restates is not.
    const trailer = sent.body.messages.at(-1);
    expect(trailer.role).toBe('system');
    expect(trailer.content).toContain('That was the conversation.');
    expect(trailer.content).toContain('NO_REPLY');
    expect(sent.body.stream).toBe(false);
    expect(sent.body.reasoning).toEqual({ exclude: true });
    expect(sent.body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'goal_decision', strict: true }
    });
    expect(sent.body.response_format.json_schema.schema.properties.action.description).toContain(
      'continue while concrete requested work or questions are not yet clearly completed or answered'
    );
    expect(sent.body.plugins).toEqual([{ id: 'response-healing' }]);
    expect(sent.body.provider).toEqual({ require_parameters: true });
  });

  it('does not ask OpenRouter to invent a continuation when no user goal was recorded', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-goal-no-user' });
    await appendEvent(session.id, {
      time: 1_100,
      source: 'extension',
      kind: 'assistant_message',
      final: true,
      message: { text: 'an answer survived but its user prompt did not', truncated: false, chars: 42 }
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return stream([delta('invent more work'), 'data: [DONE]\n']);
    }) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-goal-no-user', turnId: 'g-no-user' });
    const view = await settled('c-goal-no-user');
    expect(view.stage).toBe('failed');
    expect(view.error).toBe('no_conversation');
    expect(calls).toBe(0);
  });

  it('keeps the conclusion of an over-long message instead of clipping away the newest result', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-goal-long' });
    const conclusion = 'FINAL RESULT: the regression is fixed and every focused test is green';
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'fix the race and verify it', truncated: false, chars: 26 }
    });
    await appendEvent(session.id, {
      time: 1_100,
      source: 'extension',
      kind: 'assistant_message',
      final: true,
      message: {
        text: `analysis starts here\n${'x'.repeat(14_000)}\n${conclusion}`,
        truncated: false,
        chars: 14_100
      }
    });

    const messages = await goal.conversationMessages(session.id);
    const answer = messages.at(-1)?.content ?? '';
    expect(answer).toContain('analysis starts here');
    // The goal model decides whether work is finished. Long ChatGPT answers commonly put that
    // verdict at the end, so a per-message budget that keeps only the prefix removes the exact
    // evidence this loop exists to inspect.
    expect(answer).toContain(conclusion);
    expect(answer).toContain('cut');
    expect(answer.length).toBeLessThanOrEqual(12_000);
  });

  it('keeps the original user goal when recent history alone exceeds the total context budget', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-goal-anchor' });
    const original = 'ORIGINAL GOAL: fix the durability race, prove it with a crash regression, then stop';
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: original, truncated: false, chars: original.length }
    });

    // Twelve clipped-size answers plus their follow-ups push the recent tail well past 120k.
    // The old newest-first trimmer therefore discarded the first user message even though the
    // Goal prompt tells the model to decide whether precisely that original request is done.
    for (let index = 0; index < 12; index++) {
      const answer = `work chunk ${index}\n${String(index).repeat(12_500)}`;
      await appendEvent(session.id, {
        time: 2_000 + index * 2,
        source: 'extension',
        kind: 'assistant_message',
        final: true,
        message: { text: answer, truncated: false, chars: answer.length }
      });
      await appendEvent(session.id, {
        time: 2_001 + index * 2,
        source: 'extension',
        kind: 'user_message',
        message: { text: `continue with chunk ${index}`, truncated: false, chars: 22 }
      });
    }

    const messages = await goal.conversationMessages(session.id);
    expect(messages[0]).toEqual({ role: 'user', content: original });
    expect(messages.at(-1)?.content).toBe('continue with chunk 11');
    expect(messages.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(120_000);
  });

  it('keeps the actual first user goal when the recent-reader row window itself is saturated', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-goal-anchor-beyond-tail' });
    const original = 'ORIGINAL GOAL OUTSIDE THE RECENT WINDOW: finish the migration and stop';
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: original, truncated: false, chars: original.length }
    });

    // conversationMessages asks readRecentEvents for 240 logical rows. More than that used to
    // make its "first user" anchor merely the oldest follow-up left in the tail, while the
    // system prompt still told the model it had been given what the user originally asked for.
    for (let index = 0; index < 130; index++) {
      const answer = `assistant result ${index}`;
      const followup = `follow-up ${index}`;
      await appendEvent(session.id, {
        time: 2_000 + index * 2,
        source: 'extension',
        kind: 'assistant_message',
        final: true,
        message: { text: answer, truncated: false, chars: answer.length }
      });
      await appendEvent(session.id, {
        time: 2_001 + index * 2,
        source: 'extension',
        kind: 'user_message',
        message: { text: followup, truncated: false, chars: followup.length }
      });
    }

    const messages = await goal.conversationMessages(session.id);
    expect(messages[0]).toEqual({ role: 'user', content: original });
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'follow-up 129' });
    expect(messages.length).toBeLessThanOrEqual(120);
  });

  it('asks for a reasoning effort only when one was chosen', async () => {
    await saveConfig({
      ...defaultConfig(),
      goal: { ...defaultConfig().goal, enabled: true, model: 'deepseek/deepseek-v4-flash', reasoning: 'high' }
    });
    const session = await createSession({ title: 'goal', conversationId: 'c-goal-3' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'go', truncated: false, chars: 2 }
    });

    let body: any = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return decision('continue', 'next bit please');
    }) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-goal-3', turnId: 'g-1' });
    await settled('c-goal-3');
    expect(body.reasoning).toEqual({ effort: 'high', exclude: true });
  });
});

describe('the reply', () => {
  const seed = async (conversationId: string): Promise<string> => {
    const session = await createSession({ title: 'goal', conversationId });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'ship it', truncated: false, chars: 7 }
    });
    return session.id;
  };

  /**
   * A chunk can split an SSE line anywhere. The version that assumed chunk boundaries were
   * line boundaries dropped whichever token happened to straddle one — which is invisible
   * until a message arrives with a word missing out of the middle of it.
   */
  it('survives a chunk that splits a line in half', async () => {
    const sessionId = await seed('c-split');
    globalThis.fetch = (async () =>
      stream([
        'data: {"choices":[{"delta":{"content":"can you ',
        'also"}}]}\n' + delta(' add the flag'),
        'data: [DONE]\n'
      ])) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-split', turnId: 'g-1' });
    expect((await settled('c-split')).reply).toBe('can you also add the flag');
  });

  it('keeps the final SSE record when the stream closes without a trailing newline', async () => {
    const sessionId = await seed('c-eof');
    const lastRecord = `data: ${JSON.stringify({ choices: [{ delta: { content: 'last token survives' } }] })}`;
    globalThis.fetch = (async () => stream([lastRecord])) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-eof', turnId: 'g-1' });
    const view = await settled('c-eof');
    expect(view.stage).toBe('ready');
    expect(view.reply).toBe(goal.humanReply('last token survives'));
  });

  it('treats the SSE DONE marker as terminal and ignores records after it', async () => {
    const sessionId = await seed('c-done-terminal');
    globalThis.fetch = (async () =>
      stream([
        delta('keep this reply'),
        'data: [DONE]\n',
        // A provider/proxy bug or buffered junk after the terminal record is not another part
        // of this completion. Accepting it means the app can type text the model emitted after
        // OpenAI-compatible streaming already declared the response complete.
        delta(' and never append this')
      ])) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-done-terminal', turnId: 'g-1' });
    const view = await settled('c-done-terminal');
    expect(view.stage).toBe('ready');
    expect(view.reply).toBe(goal.humanReply('keep this reply'));
  });

  it('fails a partial completion when the provider emits a streamed error', async () => {
    const sessionId = await seed('c-stream-error');
    globalThis.fetch = (async () =>
      stream([
        delta('this is only a partial instruction'),
        `data: ${JSON.stringify({ error: { message: 'upstream provider failed' } })}\n`,
        'data: [DONE]\n'
      ])) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-stream-error', turnId: 'g-1' });
    const view = await settled('c-stream-error');
    expect(view.stage).toBe('failed');
    expect(view.reply).toBe('');
    expect(view.error).toMatch(/stream|provider|request_failed/i);
  });

  /**
   * One draft is one request, and a failure is not an answer.
   *
   * The two answers that end a Goal run are `[no reply]` and words to type. A dead socket, a
   * try-later status, a stream that breaks and a reply this app cannot read are all the same
   * event — no answer — so none of them may spend the turn: the draft settles `failed` and
   * `retryable`, which is the page loop being told the turn is still owed one. Asking again is
   * that loop's job, because only it can still see whether this is the turn being answered.
   */
  it('asks once per draft, and leaves an unanswered turn still owed an answer', async () => {
    const cases: Array<[string, () => unknown]> = [
      ['socket', () => { throw new TypeError('fetch failed'); }],
      ['408', () => new Response('{}', { status: 408 })],
      ['429', () => new Response('{}', { status: 429 })],
      ['503', () => new Response('{}', { status: 503 })],
      ['broken-stream', () => stream([delta('half an instruction'), `data: ${JSON.stringify({ error: { message: 'upstream provider failed' } })}\n`, 'data: [DONE]\n'])],
      ['malformed', () => stream([delta('unfinished thought'), 'data: {not-json}\n'])],
      ['oversize', () => stream([delta('x'.repeat(12_001)), 'data: [DONE]\n'])]
    ];
    for (const [name, fail] of cases) {
      const id = `c-unanswered-${name}`;
      const sessionId = await seed(id);
      let attempts = 0;
      globalThis.fetch = (async () => {
        attempts += 1;
        return fail();
      }) as never;

      goal.startGoalDraft({ sessionId, conversationId: id, turnId: 'g-1' });
      const view = await settled(id);
      expect(attempts, name).toBe(1);
      expect(view.stage, name).toBe('failed');
      expect(view.retryable, name).toBe(true);
      // Whatever arrived before the failure was never an answer, and never becomes one.
      expect(view.reply, name).toBe('');
    }
  });

  /** A refused key, an empty account or a model id nobody knows answers the same way twice. */
  it('asks once about a failure the same request would only repeat', async () => {
    const cases: Array<[string, () => unknown]> = [
      ['auth', () => new Response('{}', { status: 401 })],
      ['credit', () => new Response('{}', { status: 402 })],
      ['unknown-model', () => new Response('{}', { status: 404 })]
    ];
    for (const [name, fail] of cases) {
      const id = `c-terminal-${name}`;
      const sessionId = await seed(id);
      let attempts = 0;
      globalThis.fetch = (async () => {
        attempts += 1;
        return fail();
      }) as never;

      goal.startGoalDraft({ sessionId, conversationId: id, turnId: 'g-1' });
      const view = await settled(id);
      expect(attempts, name).toBe(1);
      expect(view.stage, name).toBe('failed');
      expect(view.retryable, name).toBe(false);
    }
  });

  /**
   * The one retry authority, exercised end to end: ack the failure, ask again, same turn.
   *
   * This is exactly what the page's Goal loop does, and the idempotency that stops a second
   * message has to keep letting it through — nothing was typed, so this is still the first
   * message for that turn rather than a second one.
   */
  it('draws a new draft for the same turn once the page has retired the failed one', async () => {
    const sessionId = await seed('c-again');
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('{}', { status: 503 })
        : stream([delta('the real instruction'), 'data: [DONE]\n']);
    }) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-again', turnId: 'g-1' });
    const failure = await settled('c-again');
    expect(failure.stage).toBe('failed');
    expect(failure.retryable).toBe(true);

    // Unread, the failure is still the page's to see: asking again hands back the same one.
    expect(goal.startGoalDraft({ sessionId, conversationId: 'c-again', turnId: 'g-1' }).stage).toBe('failed');
    expect(attempts).toBe(1);

    expect(goal.ackGoalDraft('c-again', failure.token)).toBe(true);
    goal.startGoalDraft({ sessionId, conversationId: 'c-again', turnId: 'g-1' });
    const view = await settled('c-again');
    expect(attempts).toBe(2);
    expect(view.stage).toBe('ready');
    expect(view.reply).toBe(goal.humanReply('the real instruction'));
  });

  /** …and never for a failure that would only be paid for again. */
  it('refuses a fresh attempt at a turn whose failure was settings, not weather', async () => {
    const sessionId = await seed('c-again-settled');
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response('{}', { status: 402 });
    }) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-again-settled', turnId: 'g-1' });
    const failure = await settled('c-again-settled');
    expect(failure.retryable).toBe(false);
    expect(goal.ackGoalDraft('c-again-settled', failure.token)).toBe(true);

    const again = goal.startGoalDraft({ sessionId, conversationId: 'c-again-settled', turnId: 'g-1' });
    expect(again.stage).toBe('failed');
    expect(attempts).toBe(1);
  });

  /** The loop's stopping condition, and the whole reason it can be left running. */
  it('sends nothing when the model says the goal is met', async () => {
    const sessionId = await seed('c-done');
    globalThis.fetch = (async () => stream([delta('NO_REPLY'), 'data: [DONE]\n'])) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-done', turnId: 'g-1' });
    const view = await settled('c-done');
    expect(view.stage).toBe('no-reply');
    expect(view.reply).toBe('');
  });

  /** Protocol words are never safe composer prose; ambiguity stops instead of self-prompting. */
  it('fails closed when legacy output wraps NO_REPLY in scratchpad prose', async () => {
    const sessionId = await seed('c-mentions');
    globalThis.fetch = (async () =>
      stream([delta('⑥ Counting flush: ~50 NO_REPLY'), 'data: [DONE]\n'])) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-mentions', turnId: 'g-1' });
    const view = await settled('c-mentions');
    expect(view.stage).toBe('no-reply');
    expect(view.reply).toBe('');
  });

  it('accepts a strict structured continuation and strips tokenizer wrappers', async () => {
    const sessionId = await seed('c-structured-continue');
    globalThis.fetch = (async () => decision('continue', '<|begin_of_sentence|>what about the tests')) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-structured-continue', turnId: 'g-1' });
    const view = await settled('c-structured-continue');
    expect(view.stage).toBe('ready');
    expect(view.reply).toBe(goal.humanReply('what about the tests'));
    expect(view.reply).not.toContain('<|');
  });

  it('accepts a strict structured stop decision', async () => {
    const sessionId = await seed('c-structured-stop');
    globalThis.fetch = (async () => decision('stop')) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-structured-stop', turnId: 'g-1' });
    const view = await settled('c-structured-stop');
    expect(view.stage).toBe('no-reply');
    expect(view.reply).toBe('');
  });

  it('never types a structured reply made only of tokenizer control markers', async () => {
    const sessionId = await seed('c-control-only');
    globalThis.fetch = (async () => decision('continue', '<|begin_of_sentence|>')) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-control-only', turnId: 'g-1' });
    const view = await settled('c-control-only');
    expect(view.stage).toBe('failed');
    expect(view.error).toBe('control_tokens_only');
    expect(view.reply).toBe('');
  });

  it('rejects non-schema content in a normal OpenRouter completion envelope', async () => {
    const sessionId = await seed('c-non-schema');
    globalThis.fetch = (async () =>
      Response.json({ choices: [{ message: { content: 'random provider scratchpad' } }] })) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-non-schema', turnId: 'g-1' });
    const view = await settled('c-non-schema');
    expect(view.stage).toBe('failed');
    expect(view.error).toBe('invalid_goal_decision_json');
    expect(view.reply).toBe('');
  });

  it('accepts the stopping word however the model punctuated it', async () => {
    for (const [index, spelling] of ['no_reply', 'No Reply.', 'NO-REPLY!'].entries()) {
      const id = `c-stop-${index}`;
      const sessionId = await seed(id);
      globalThis.fetch = (async () => stream([delta(spelling), 'data: [DONE]\n'])) as never;
      goal.startGoalDraft({ sessionId, conversationId: id, turnId: 'g-1' });
      expect((await settled(id)).stage, spelling).toBe('no-reply');
    }
  });
});

describe('one draft per generation', () => {
  /**
   * The idempotency that keeps a retried POST, a reloaded tab or two observers of one
   * settle from putting two messages into one conversation.
   */
  it('answers a repeated request for the same turn with the draft that exists', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-once' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'carry on', truncated: false, chars: 8 }
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return stream([delta('and the docs'), 'data: [DONE]\n']);
    }) as never;

    const first = goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-once', turnId: 'g-1' });
    const second = goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-once', turnId: 'g-1' });
    expect(second.token).toBe(first.token);
    await settled('c-once');
    expect(calls).toBe(1);

    // A *different* generation supersedes it: the answer the old one was about is no longer
    // the last thing said.
    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-once', turnId: 'g-2' });
    expect(goal.goalViewFor('c-once')!.turnId).toBe('g-2');
  });

  it('gives one browser tab exclusive authority to type an unspent draft', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-tab-owner' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'finish this once', truncated: false, chars: 16 }
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return stream([delta('one follow-up only'), 'data: [DONE]\n']);
    }) as never;

    const first = goal.startGoalDraft({
      sessionId: session.id,
      conversationId: 'c-tab-owner',
      turnId: 'tab-a-generation',
      clientId: 'tab-a'
    } as any);
    await settled('c-tab-owner');

    expect(goal.goalViewFor('c-tab-owner', 'tab-a' as any)?.token).toBe(first.token);
    // A second tab polling the same conversation must not receive the ready payload. The old
    // conversation-only view returned it to both tabs, while each tab's sessionStorage receipt
    // was private, so both could cross ChatGPT's irreversible send boundary independently.
    expect(goal.goalViewFor('c-tab-owner', 'tab-b' as any)).toBeNull();
    // Its page-local generation id must not supersede/abort the owner's draft either.
    expect(() =>
      goal.startGoalDraft({
        sessionId: session.id,
        conversationId: 'c-tab-owner',
        turnId: 'tab-b-generation',
        clientId: 'tab-b'
      } as any)
    ).toThrow('goal_owned_elsewhere');
    expect(goal.ackGoalDraft('c-tab-owner', first.token, 'tab-b' as any)).toBe(false);
    expect(calls).toBe(1);
  });

  /**
   * The reply is handed over only while it is still the thing to do. Once the page has said
   * it acted on it, polling again must not find a message to type a second time.
   */
  it('stops offering a draft the page has acknowledged', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-ack' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'again', truncated: false, chars: 5 }
    });
    globalThis.fetch = (async () => stream([delta('one more thing'), 'data: [DONE]\n'])) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-ack', turnId: 'g-1' });
    const view = await settled('c-ack');
    expect(view.reply).toBe(goal.humanReply('one more thing'));

    expect(goal.ackGoalDraft('c-ack', view.token)).toBe(true);
    expect(goal.goalViewFor('c-ack')).toBeNull();
    // A wrong token is not an acknowledgement of anything.
    expect(goal.ackGoalDraft('c-ack', 'not-the-token')).toBe(false);
    // …and the turn is still spent, so nothing re-drafts it.
    expect(goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-ack', turnId: 'g-1' }).token).toBe(
      view.token
    );
  });

  it('stops an in-flight OpenRouter request when the browser retires the draft', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-ack-running' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'keep going', truncated: false, chars: 10 }
    });

    // Held on an object rather than in a plain `let`: the only assignment is inside a
    // callback, so control-flow analysis narrows the variable to `null` at every read below
    // and `signal?.aborted` stops compiling. A property is not narrowed that way.
    const opened: { signal: AbortSignal | null } = { signal: null };
    let fetchStarted!: () => void;
    const entered = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      opened.signal = init?.signal ?? null;
      fetchStarted();
      return await new Promise<Response>((_resolve, reject) => {
        opened.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }) as never;

    const started = goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-ack-running', turnId: 'g-1' });
    await entered;
    expect(opened.signal?.aborted).toBe(false);

    expect(goal.ackGoalDraft('c-ack-running', started.token)).toBe(true);
    expect(opened.signal?.aborted).toBe(true);
    expect(goal.goalViewFor('c-ack-running')).toBeNull();
  });

  it('stops every in-flight request when Goal authority is revoked and keeps the generation spent', async () => {
    const session = await createSession({ title: 'goal revoke', conversationId: 'c-goal-revoke' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'keep going', truncated: false, chars: 10 }
    });

    let calls = 0;
    const opened: { signal: AbortSignal | null } = { signal: null };
    let fetchStarted!: () => void;
    const entered = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      calls += 1;
      opened.signal = init?.signal ?? null;
      fetchStarted();
      return await new Promise<Response>((_resolve, reject) => {
        opened.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }) as never;

    const first = goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-goal-revoke', turnId: 'g-revoke' });
    await entered;
    expect(opened.signal?.aborted).toBe(false);
    expect(goal.retireGoalDrafts()).toBe(1);
    expect(opened.signal?.aborted).toBe(true);
    expect(goal.goalViewFor('c-goal-revoke')).toBeNull();

    const retried = goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-goal-revoke', turnId: 'g-revoke' });
    expect(retried.token).toBe(first.token);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
  });

  it('keeps a retired generation spent instead of drafting the same turn a second time', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-cancel-once' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'keep going', truncated: false, chars: 10 }
    });

    let calls = 0;
    const opened: { signal: AbortSignal | null } = { signal: null };
    let fetchStarted!: () => void;
    const entered = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      calls += 1;
      opened.signal = init?.signal ?? null;
      fetchStarted();
      return await new Promise<Response>((_resolve, reject) => {
        opened.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }) as never;

    const first = goal.startGoalDraft({
      sessionId: session.id,
      conversationId: 'c-cancel-once',
      turnId: 'g-cancelled'
    });
    await entered;
    expect(calls).toBe(1);

    expect(goal.ackGoalDraft('c-cancel-once', first.token)).toBe(true);
    expect(opened.signal?.aborted).toBe(true);
    expect(goal.goalViewFor('c-cancel-once')).toBeNull();

    // Cancellation means this generation was deliberately retired. A retry/reload that asks
    // for the same turn must get the same spent identity back, not spend the OpenRouter key on
    // a second request for work the page explicitly abandoned.
    const retried = goal.startGoalDraft({
      sessionId: session.id,
      conversationId: 'c-cancel-once',
      turnId: 'g-cancelled'
    });
    expect(retried.token).toBe(first.token);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
  });

  it('does not forget a spent generation when its visible draft ages past the ten-minute TTL', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-expired-once' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'keep going', truncated: false, chars: 10 }
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return stream([delta('one last correction'), 'data: [DONE]\n']);
    }) as never;

    const first = goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-expired-once', turnId: 'g-expired' });
    const ready = await settled('c-expired-once');
    expect(ready.stage).toBe('ready');
    expect(calls).toBe(1);

    // This is the dangerous lost-ACK shape: ChatGPT may already have accepted the user message,
    // while the app still holds the ready draft as unacknowledged. The browser receipt is keyed
    // by this token. Expiring the *payload* must not expire the generation identity and mint a
    // different token that the browser cannot recognise as already sent.
    const afterTtl = Date.now() + 11 * 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(afterTtl);
    try {
      expect(goal.goalViewFor('c-expired-once')).toBeNull();
      const retried = goal.startGoalDraft({
        sessionId: session.id,
        conversationId: 'c-expired-once',
        turnId: 'g-expired'
      });
      expect(retried.token).toBe(first.token);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });
});

describe('when OpenRouter refuses', () => {
  const seed = async (conversationId: string): Promise<string> => {
    const session = await createSession({ title: 'goal', conversationId });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'go on', truncated: false, chars: 5 }
    });
    return session.id;
  };

  /** The status codes a person can act on, said in words rather than as a number. */
  it('names the reason, and never quotes the key back', async () => {
    const cases: Array<[number, string, string]> = [
      [401, 'no', 'auth_rejected'],
      [402, 'no', 'out_of_credit'],
      [404, 'no', 'unknown_model'],
      [429, 'no', 'rate_limited'],
      [503, 'no', 'http_503']
    ];
    for (const [index, [status, _body, expected]] of cases.entries()) {
      const id = `c-fail-${index}`;
      const sessionId = await seed(id);
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: { message: 'upstream said no' } }), { status })) as never;
      goal.startGoalDraft({ sessionId, conversationId: id, turnId: 'g-1' });
      const view = await settled(id);
      expect(view.stage, String(status)).toBe('failed');
      expect(view.error, String(status)).toContain(expected);
      expect(view.error).not.toContain('sk-or-test');
    }
  });

  it('does not read an arbitrarily large OpenRouter error body just to produce a short status', async () => {
    const sessionId = await seed('c-huge-error');
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'small visible detail' } }), {
        status: 503,
        headers: { 'content-length': String(64 * 1024 + 1) }
      })) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-huge-error', turnId: 'g-1' });
    const view = await settled('c-huge-error');
    expect(view.stage).toBe('failed');
    expect(view.error).toContain('http_503');
    expect(view.error).toMatch(/body.*too large/i);
  });

  it('refuses before spending anything when there is no key', async () => {
    const sessionId = await seed('c-nokey');
    await setSecret('openRouterApiKey', '');
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return stream(['data: [DONE]\n']);
    }) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-nokey', turnId: 'g-1' });
    const view = await settled('c-nokey');
    expect(view.stage).toBe('failed');
    expect(view.error).toBe('no_api_key');
    expect(called).toBe(false);
    expect(await goal.goalKeyPresent()).toBe(false);
  });

  /**
   * An empty answer is a failure, not a message. Typing nothing into a chat would send the
   * turn on with no content at all, which is worse than saying the request failed.
   */
  it('treats an empty answer as a failure rather than as a message', async () => {
    const sessionId = await seed('c-empty');
    globalThis.fetch = (async () => stream([delta('   '), 'data: [DONE]\n'])) as never;
    goal.startGoalDraft({ sessionId, conversationId: 'c-empty', turnId: 'g-1' });
    const view = await settled('c-empty');
    expect(view.stage).toBe('failed');
    expect(view.error).toBe('empty_reply');
  });

  it('does not promote a partial reply when a later SSE record is malformed', async () => {
    const sessionId = await seed('c-malformed-stream');
    globalThis.fetch = (async () => stream([delta('unfinished thought'), 'data: {not-json}\n'])) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-malformed-stream', turnId: 'g-1' });
    const view = await settled('c-malformed-stream');
    expect(view.stage).toBe('failed');
    expect(view.error).toBe('request_failed: malformed_stream_record');
    expect(view.reply).toBe('');
  });

  it('refuses an over-long generated user reply instead of streaming an unbounded composer payload', async () => {
    const sessionId = await seed('c-too-long');
    globalThis.fetch = (async () => stream([delta('x'.repeat(12_001)), 'data: [DONE]\n'])) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-too-long', turnId: 'g-1' });
    const view = await settled('c-too-long');
    expect(view.stage).toBe('failed');
    expect(view.error).toBe('reply_too_long');
    expect(view.reply).toBe('');
  });

  /** A chat with no local recording has no conversation to reason about. */
  it('says so when there is nothing recorded to continue from', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-silent' });
    globalThis.fetch = (async () => stream(['data: [DONE]\n'])) as never;
    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-silent', turnId: 'g-1' });
    const view = await settled('c-silent');
    expect(view.stage).toBe('failed');
    expect(view.error).toBe('no_conversation');
  });
});

describe('the model catalogue', () => {
  const listing = {
    data: [
      { id: 'old/model', name: 'Old', created: 1_000, context_length: 8_000 },
      { id: 'new/model', name: 'New', created: 9_000, context_length: 200_000 },
      { id: 'middle/model', name: 'Middle', created: 5_000 },
      { id: 42, name: 'nonsense' }
    ]
  };

  /**
   * Sorted by release date rather than alphabetically or by popularity, because the question
   * the picker answers is "what is new" — the reason to open it is that a better model exists
   * than the one already chosen.
   */
  it('is newest first, twenty at a time, and skips entries it cannot read', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify(listing), { status: 200 });
    }) as never;

    const page = await goal.listGoalModels(0, 2);
    expect(page.total).toBe(3);
    expect(page.models.map((model) => model.id)).toEqual(['new/model', 'middle/model']);
    expect(page.models[0]!.contextLength).toBe(200_000);
    // A listing that did not say when a model was released still lists it.
    expect(page.models[1]!.contextLength).toBe(0);

    const next = await goal.listGoalModels(2, 2);
    expect(next.models.map((model) => model.id)).toEqual(['old/model']);
    // The listing is small and changes daily, not by the second: the second page came out
    // of the cache rather than off the network.
    expect(calls).toBe(1);
    expect(goal.MODEL_PAGE_SIZE).toBe(20);
  });

  it('does not reuse a restricted model catalogue after the OpenRouter key is replaced', async () => {
    const seenAuth: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const authorization = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
      seenAuth.push(authorization);
      const id = authorization.endsWith('key-b') ? 'only-for-b' : 'only-for-a';
      return new Response(JSON.stringify({ data: [{ id, name: id, created: 1 }] }), { status: 200 });
    }) as never;

    await setSecret('openRouterApiKey', 'key-a');
    expect((await goal.listGoalModels()).models.map((model) => model.id)).toEqual(['only-for-a']);
    await setSecret('openRouterApiKey', 'key-b');
    expect((await goal.listGoalModels()).models.map((model) => model.id)).toEqual(['only-for-b']);
    expect(seenAuth).toEqual(['Bearer key-a', 'Bearer key-b']);
  });

  it('says the listing failed rather than pretending the catalogue is empty', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as never;
    await expect(goal.listGoalModels(0, 20)).rejects.toThrow('HTTP 500');
  });

  it('times out a model catalogue request whose provider never answers', async () => {
    vi.useFakeTimers();
    try {
      const opened: { signal: AbortSignal | null } = { signal: null };
      let markFetchStarted: () => void = () => {};
      const fetchStarted = new Promise<void>((resolve) => {
        markFetchStarted = resolve;
      });
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        opened.signal = init?.signal ?? null;
        markFetchStarted();
        return await new Promise<Response>((_resolve, reject) => {
          opened.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }) as never;

      // Attach the rejection observer before advancing fake time; otherwise Node correctly
      // reports the timeout rejection as temporarily unhandled before the assertion below.
      const pending = goal.listGoalModels().then(
        () => null,
        (error: Error) => error
      );
      // Secret lookup now initializes Electron's non-blocking async safeStorage provider before
      // the network request. Wait for the observable fetch boundary instead of assuming an exact
      // number of internal promise turns between the API call and provider I/O.
      await fetchStarted;
      expect(opened.signal).not.toBeNull();
      await vi.advanceTimersByTimeAsync(31_000);
      const failure = await pending;
      expect(failure).toBeInstanceOf(Error);
      expect(failure?.message).toMatch(/timed out/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a model catalogue whose declared body exceeds the bounded provider response', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(listing), {
        status: 200,
        headers: { 'content-length': String(8 * 1024 * 1024 + 1) }
      })) as never;

    await expect(goal.listGoalModels()).rejects.toThrow(/body.*too large/i);
  });

  it('bounds untrusted model fields and catalogue cardinality before caching them', async () => {
    const hugeName = 'n'.repeat(2_000);
    const entries = Array.from({ length: 5_100 }, (_, index) => ({
      id: `provider/model-${index}`,
      name: index === 0 ? hugeName : `Model ${index}`,
      created: index
    }));
    // An identifier too large to be a sane provider id is not safe to persist into config or
    // send back as a selection, so it should be skipped rather than truncated into a different
    // id. Display names may be truncated because they are presentation only.
    entries.push({ id: `provider/${'x'.repeat(1_000)}`, name: 'bad id', created: 99_999 });
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: entries }), { status: 200 })) as never;

    const page = await goal.listGoalModels(0, 100);
    expect(page.total).toBeLessThanOrEqual(5_000);
    expect(page.models.some((model) => model.id.length > 500)).toBe(false);
    expect(page.models.every((model) => model.name.length <= 500)).toBe(true);
  });
});

/**
 * The draft as it would have been typed, not as a model writes.
 *
 * Two separate claims, and the second one is the load-bearing one: the em dash goes, and a
 * couple of the mistakes a person leaves behind go in — but the whole thing has to be a pure
 * function of the draft, because a retried request has to be handed back the same message.
 */
describe('the message a person would have typed', () => {
  it('leaves no em dash anywhere in the reply', () => {
    const written =
      'the picker stops at twenty — scrolling loads nothing. page a screenful before the end ' +
      '— the button below the list is not where anyone looks.';
    const typed = goal.humanReply(written);
    expect(typed).not.toMatch(/[—–]/);
    // A comma is that sentence typed, so the shape of the sentence survives.
    expect(typed).toContain('at twenty, scrolling loads nothing');
  });

  it('keeps a line that opens with a dash a line, and a range a range', () => {
    // Two lines in, two lines out: a dash opening a line is a bullet, and the horizontal-only
    // whitespace class is what keeps the newline from being swallowed with it.
    const lines = goal.humanReply('— check the tests\n— then ship it').split('\n');
    expect(lines.length).toBe(2);
    expect(lines.every((line) => /^[a-z]/.test(line))).toBe(true);
    expect(goal.humanReply('it took 10—20 seconds')).toContain('10-20');
  });

  it('never leaves a doubled comma where the dash already had one', () => {
    expect(goal.humanReply('two things, — the tests and the build')).not.toMatch(/,\s*,/);
  });

  it('puts a mistake in, and not many', () => {
    const written = 'that does not fix it. the answer still renders twice, look at the id-less sections';
    const typed = goal.humanReply(written);
    expect(typed).not.toBe(written);
    const differing = [...written].filter((letter, at) => letter !== typed[at]).length;
    // A slip, not a rewrite. Every mutation here is one character long.
    expect(differing).toBeGreaterThan(0);
    expect(typed.length).toBeGreaterThanOrEqual(written.length - 3);
  });

  it('hands back the identical message every time it is asked', () => {
    const written =
      'the settings sheet still overflows on the right, can you cap the column and check the ' +
      'select as well. i really do not want another guess about it.';
    const once = goal.humanReply(written);
    expect(goal.humanReply(written)).toBe(once);
    expect(goal.humanReply(written)).toBe(once);
    // And a different draft is not the same draft: the seed is the text, not a constant.
    expect(goal.humanReply(`${written} also the picker.`)).not.toBe(once);
  });

  /**
   * The one thing a typo here could actually break. This message is about to be acted on by
   * ChatGPT, and a mistake inside a path or a command is a different instruction rather than
   * a slip — so prose is the only place they are allowed.
   */
  it('never touches a path, a command or anything in backticks', () => {
    const written =
      'run `npm run verify` first and then look at src/renderer/chat.ts, the guard is in ' +
      'maybeSendGoalReply and the report is at https://example.com/build/latest please';
    const typed = goal.humanReply(written);
    expect(typed).toContain('`npm run verify`');
    expect(typed).toContain('src/renderer/chat.ts');
    expect(typed).toContain('https://example.com/build/latest');
  });

  it('leaves a message with nothing to spoil exactly as it was', () => {
    expect(goal.humanReply('ok cool')).toBe('ok cool');
  });

  it('is what the page is actually handed', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-typed' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'keep going', truncated: false, chars: 10 }
    });
    globalThis.fetch = (async () =>
      stream([delta('the tests still fail — look at the id-less sections'), 'data: [DONE]\n'])) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-typed', turnId: 'g-typed' });
    const view = await settled('c-typed');

    expect(view.stage).toBe('ready');
    expect(view.reply).not.toMatch(/[—–]/);
    expect(view.reply).toBe(goal.humanReply('the tests still fail — look at the id-less sections'));
  });
});

/**
 * A chat with a specific goal is the same engine pointed the other way.
 *
 * The ordinary loop defaults to silence, because in a normal chat the request is whatever
 * the user last typed and inventing more of it is the failure mode. A goal inverts that: the
 * user named the finish line up front and handed the wheel over, so the loop keeps talking
 * until the line is crossed — including, uniquely, when nothing has been said yet at all.
 */
describe('a chat driven towards a specific goal', () => {
  /** The system messages one request was actually built from, in order. */
  function capture(): { seen: { role: string; content: string }[] } {
    const box = { seen: [] as { role: string; content: string }[] };
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
      box.seen = body.messages;
      return decision('continue', 'the migration is still missing. add it and run the suite');
    }) as never;
    return box;
  }

  it('swaps the continuation gate for the goal, and puts the goal itself in the prompt', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-obj-1' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'start on the port', truncated: false, chars: 17 }
    });
    goal.setGoalObjective('c-obj-1', 'port the whole module to typescript and make the suite green');
    const box = capture();

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-obj-1', turnId: 'g-obj-1' });
    const view = await settled('c-obj-1');

    expect(view.stage).toBe('ready');
    const system = box.seen.filter((message) => message.role === 'system').map((message) => message.content);
    expect(system[0]).toContain('they have handed you the wheel');
    expect(system[1]).toContain('port the whole module to typescript and make the suite green');
    // The standing instruction is the *other* mode's, and sending both would give the model
    // one prompt telling it where to read the goal from and another telling it there is none.
    expect(system.join('\n')).not.toContain('Nobody handed you a separate goal');
    // The conversation is still last among the non-system messages, with the goal-flavoured
    // closing reminder after it rather than the gate's.
    expect(box.seen.filter((message) => message.role !== 'system')).toEqual([
      { role: 'user', content: 'start on the port' }
    ]);
    expect(box.seen.at(-1)!.content).toContain('name the parts of the goal that are still not done');
  });

  /**
   * The one case the gate refuses outright. `no_conversation` exists because a half-recovered
   * recording can hold assistant prose with no user row behind it, and asking a model to
   * continue that is asking it to invent the request. A goal *is* the request, written down
   * before the chat existed, so the same emptiness means the opposite thing.
   */
  it('writes the first message of a chat that has said nothing yet', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-obj-empty' });
    goal.setGoalObjective('c-obj-empty', 'get the release out');
    const box = capture();

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-obj-empty', turnId: 'g-obj-empty' });
    const view = await settled('c-obj-empty');

    expect(view.stage).toBe('ready');
    expect(view.error).toBeNull();
    expect(box.seen.filter((message) => message.role !== 'system')).toEqual([
      { role: 'user', content: 'The conversation has not started yet. Write its opening message.' }
    ]);
  });

  it('refuses the same empty conversation when there is no goal to supply the request', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-obj-none' });
    globalThis.fetch = (async () => decision('continue', 'should never be asked')) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-obj-none', turnId: 'g-obj-none' });
    const view = await settled('c-obj-none');

    expect(view.stage).toBe('failed');
    expect(view.error).toBe('no_conversation');
  });

  it('keeps the saved objective when one Goal run says it is reached', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-obj-done' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'ship it', truncated: false, chars: 7 }
    });
    goal.setGoalObjective('c-obj-done', 'get the release out');
    globalThis.fetch = (async () => decision('stop')) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-obj-done', turnId: 'g-obj-done' });
    const view = await settled('c-obj-done');

    expect(view.stage).toBe('no-reply');
    expect(goal.goalObjectiveFor('c-obj-done')).toBe('get the release out');
  });

  it('restores chat-specific objectives after restart without creating a draft', () => {
    goal.setGoalObjective('c-obj-restored', 'keep the overnight build green');
    const saved = goal.snapshotGoalObjectives();
    goal.resetGoalStateForTests();

    goal.restoreGoalObjectives(saved);

    expect(goal.goalObjectiveFor('c-obj-restored')).toBe('keep the overnight build green');
    expect(goal.goalViewFor('c-obj-restored')).toBeNull();
  });

  it('moves the same objective to the replacement chat on resume', () => {
    goal.setGoalObjective('c-obj-parent', 'finish the release unattended');

    expect(goal.moveGoalObjective('c-obj-parent', 'c-obj-child')).toBe(true);
    expect(goal.goalObjectiveFor('c-obj-parent')).toBe('');
    expect(goal.goalObjectiveFor('c-obj-child')).toBe('finish the release unattended');
  });

  it('trims and bounds what it stores, and reports back what it stored', () => {
    expect(goal.setGoalObjective('c-obj-trim', '   finish the docs   ')).toBe('finish the docs');
    expect(goal.goalObjectiveFor('c-obj-trim')).toBe('finish the docs');
    expect(goal.setGoalObjective('c-obj-trim', 'x'.repeat(9_000))).toHaveLength(4_000);
    expect(goal.setGoalObjective('c-obj-trim', '  ')).toBe('');
    expect(goal.goalObjectiveFor('c-obj-trim')).toBe('');
  });

  /**
   * A draft is frozen with the goal it was started under, so replacing the goal has to reach
   * the request already in flight — otherwise the last thing typed into the chat is a message
   * written against the goal the user just replaced.
   */
  it('retires the draft in flight when the goal changes', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-obj-swap' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'go', truncated: false, chars: 2 }
    });
    globalThis.fetch = (async () => new Promise<Response>(() => undefined)) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-obj-swap', turnId: 'g-obj-swap' });
    expect(goal.goalViewFor('c-obj-swap')).not.toBeNull();
    expect(goal.retireGoalDraftsFor('c-obj-swap')).toBe(true);
    expect(goal.goalViewFor('c-obj-swap')).toBeNull();
    // …and only that chat's, and only once.
    expect(goal.retireGoalDraftsFor('c-obj-swap')).toBe(false);
  });
});

/**
 * The opening message of a chat ChatGPT has not named yet.
 *
 * No conversation id exists to key a draft to, because sending this very message is what
 * makes ChatGPT issue one. It therefore runs outside the draft map entirely — and still has
 * to go through the same protocol guard, the same caps and the same typing pass as every
 * other message this app puts into somebody's chat.
 */
describe('opening a chat on a goal', () => {
  it('writes the first message from the goal alone', async () => {
    let seen: { role: string; content: string }[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen = (JSON.parse(String(init.body)) as { messages: typeof seen }).messages;
      return decision('continue', 'rewrite the parser in rust — start with the lexer');
    }) as never;

    const drafted = await goal.draftOpeningMessage('  rewrite the parser in rust  ');

    expect(drafted).toEqual({
      reply: goal.humanReply('rewrite the parser in rust — start with the lexer'),
      model: 'deepseek/deepseek-v4-flash'
    });
    expect(seen[0]!.content).toContain('they have handed you the wheel');
    expect(seen[1]!.content).toContain('rewrite the parser in rust');
    // Trimmed on the way in, so stray whitespace is not part of the goal it prompts against.
    expect(seen[1]!.content).not.toContain('  rewrite');
    expect(seen.filter((message) => message.role !== 'system')).toEqual([
      { role: 'user', content: 'The conversation has not started yet. Write its opening message.' }
    ]);
    // The opening message runs outside the draft map but through the same assembly, closing
    // reminder included — that sameness is the point of sharing one request builder.
    expect(seen.at(-1)!.content).toContain('That was the conversation.');
  });

  /**
   * Stopping before a word has been said is the model refusing the goal, not meeting it.
   * An empty opening message would leave somebody looking at a chat that never started.
   */
  it('refuses to open with nothing', async () => {
    globalThis.fetch = (async () => decision('stop')) as never;
    expect(await goal.draftOpeningMessage('finish it')).toEqual({ error: 'nothing_to_open_with' });
    expect(await goal.draftOpeningMessage('   ')).toEqual({ error: 'no_objective' });
  });
});
