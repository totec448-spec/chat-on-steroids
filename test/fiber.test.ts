/**
 * The MAIN-world Fiber reader, running against Fiber trees shaped like the live page.
 *
 * Until now nothing executed extension/fiber.js at all: the extension tests asserted
 * things about its *source*, and the content-script tests faked its replies. So the one
 * file whose entire job is to read a shape this repo does not control had no test that
 * could notice the shape moving — and it had moved. On the live page the node carrying a
 * row's messages sits at climb depth 30, and the file stopped at 29, so every row of every
 * chat produced no descriptor at all. That is invisible from outside: a helper that finds
 * nothing and a browser with no helper look exactly the same.
 *
 * Every fixture below is transcribed from shapes read out of a real conversation
 * (2026-08-16): the depth, the group array whose `messages[0]` is the row's own request,
 * the `parent_id` link from a result back to it, the truncated request payloads, and the
 * `invoked_resource` on the answer.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';

let source = '';

beforeAll(async () => {
  source = await fs.readFile(path.join(process.cwd(), 'extension', 'fiber.js'), 'utf8');
});

interface Descriptor {
  v: number;
  index: number;
  tool: string | null;
  path: string | null;
  app: string | null;
  resource: string | null;
  messageId: string | null;
  turnId: string | null;
  conversationId: string | null;
  createTime: number | null;
  hidden: number;
  localCount: number | null;
  answered: boolean;
}

// ------------------------------------------------------------------ fixtures

const THREAD = '6a81871f-bbec-83eb-8595-4a292446b686';
/**
 * The connector name the live page actually holds, taken from a real conversation.
 *
 * Spaces and all — this is `resource_name` out of this app's own protected-resource
 * metadata, and the fixture spells it exactly because the whole evidence pipeline once
 * matched a single hardcoded name that no longer existed.
 */
const APP = 'Chat On Steroids Core';
const DESKTOP_APP = 'Chat On Steroids Desktop';
/** What the connector was called before 1.7.1 split it. Older chats still hold it. */
const LEGACY_APP = 'TobisComputer';
/** The connector's link id, as it appears in a request path. */
const LINK = 'link_6a7f78baf7e881918261b0731fac4c35';
/** A result's resource uri names the app instance rather than the connector. */
const ASDK = 'asdk_app_6a7f78b22adc8191b61ddd83beba7da5';
/** The depth the live page put the group node at. The old limit was 30 exclusive. */
const LIVE_DEPTH = 30;

interface Message {
  id: string;
  author: { role: string };
  recipient: string;
  channel?: string;
  create_time?: number;
  status?: string;
  end_turn?: boolean;
  content?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * An assistant connector request, the way the live page stores one.
 *
 * `text` is the payload as ChatGPT holds it, which is why `truncate` exists: on the live
 * page most of these are cut mid-argument and `JSON.parse` throws on them.
 */
function request(
  id: string,
  tool: string | null,
  options: { truncate?: number; parent?: string; app?: string } = {}
): Message {
  const app = options.app ?? APP;
  const head = tool === null ? '{"path":"/' : `{"path":"/${app}/${LINK}/${tool}"`;
  const body = tool === null ? head : `${head},"args":{"note":"${'x'.repeat(80)}","path":"C:/Users/example/secret.txt"}}`;
  return {
    id,
    author: { role: 'assistant' },
    recipient: 'api_tool.call_tool',
    create_time: 1786873658.125,
    content: {
      content_type: 'code',
      language: 'json',
      response_format_name: null,
      text: options.truncate === undefined ? body : body.slice(0, options.truncate)
    },
    metadata: {
      parent_id: options.parent ?? '699e6497-0000-4000-8000-000000000001',
      request_id: 'wfr_01a009',
      turn_exchange_id: '82f67b26',
      tool_icons: ['api_tool']
    }
  };
}

/** A tool result, chained to whatever message it actually answered. */
function answer(id: string, parent: string, tool: string, app: string = APP): Message {
  return {
    id,
    author: { role: 'tool' },
    recipient: 'all',
    channel: 'commentary',
    create_time: 1786873669.5,
    content: { content_type: 'code', language: 'json', response_format_name: null, text: '' },
    metadata: {
      parent_id: parent,
      request_id: 'wfr_01a009',
      invoked_plugin: { type: 'remote', namespace: 'api_tool' },
      invoked_resource: { app_name: app, resource_uri: `/${ASDK}/${LINK}/${tool}` }
    }
  };
}

/** Public assistant prose in the current page model. */
function authored(
  id: string,
  text: string,
  options: {
    status?: string;
    endTurn?: boolean;
    parent?: string;
    workingTurnId?: string;
    turnExchangeId?: string;
    createTime?: number;
    channel?: string;
  } = {}
): Message {
  return {
    id,
    author: { role: 'assistant' },
    recipient: 'all',
    ...(options.channel ? { channel: options.channel } : {}),
    ...(options.status ? { status: options.status } : {}),
    ...(options.endTurn !== undefined ? { end_turn: options.endTurn } : {}),
    ...(options.createTime ? { create_time: options.createTime } : {}),
    content: { content_type: 'text', parts: [text] },
    metadata: {
      message_type: 'next',
      ...(options.parent ? { parent_id: options.parent } : {}),
      ...(options.workingTurnId ? { working_turn_id: options.workingTurnId } : {}),
      ...(options.turnExchangeId ? { turn_exchange_id: options.turnExchangeId } : {})
    }
  };
}

/** Internal assistant reasoning/tool-summary state. It is not public authored prose. */
function thought(id: string): Message {
  return {
    id,
    author: { role: 'assistant' },
    recipient: 'all',
    content: { content_type: 'thoughts', parts: null, text: null },
    metadata: {
      message_type: 'next',
      reasoning_status: 'is_reasoning',
      tool_summary_type: 'chatgpt_local_files_core'
    }
  };
}

interface Group {
  messages: Message[];
  collapsedSameToolCallCount?: number;
  clientThreadId?: string;
  turnIndex?: number;
  isLastMessageInTurn?: boolean;
}

/** The props the live page hands the component that renders one row's group. */
function group(messages: Message[], collapsed = 0): Group {
  return {
    messages,
    collapsedSameToolCallCount: collapsed,
    clientThreadId: THREAD,
    turnIndex: 2,
    isLastMessageInTurn: false
  };
}

interface Fiber {
  memoizedProps: Record<string, unknown> | null;
  return: Fiber | null;
}

/**
 * A Fiber chain with `props` `depth` levels above the row.
 *
 * The filler nodes are the tooltip, popper and layout wrappers the real tree is padded
 * with — a dozen of them carry no props worth reading, which is the whole reason the
 * distance from the row to its data is as long as it is.
 */
function chain(props: Record<string, unknown> | null, depth = LIVE_DEPTH, above: Fiber | null = null): Fiber {
  let node: Fiber = { memoizedProps: props, return: above };
  for (let up = 0; up < depth; up++) {
    node = { memoizedProps: { className: 'flex items-center', children: null }, return: node };
  }
  return node;
}

/** The turn-level node, which carries every message of the turn and must never be read. */
function turnNode(messages: Message[], conversationProps: Record<string, unknown> = {}): Fiber {
  return {
    memoizedProps: {
      allMessages: messages,
      allGroupedMessages: [messages],
      conversation: { id: THREAD },
      turn: { id: 'turn-1', messages },
      turnIndex: 2,
      ...conversationProps
    },
    return: null
  };
}

// ------------------------------------------------------------------- harness

/**
 * Runs the shipped helper against a page whose rows carry the given Fiber chains, and
 * returns what it posted back.
 */
interface TurnCall {
  messageId: string;
  tool: string;
  order: number;
  answered: boolean;
}

interface TurnEvidence {
  index: number;
  turnId: string | null;
  conversationId?: string | null;
  conversationConflict?: boolean;
  endMessageId?: string | null;
  calls: TurnCall[];
  requests?: Array<{ requestId: string; messageId: string | null; createTime: number | null }>;
  messages: Array<{
    messageId: string;
    rawMessageId: string;
    role?: 'user' | 'assistant';
    stable: boolean;
    order: number;
    createTime?: number | null;
    rawText: string;
    renderedHtml: string;
  }>;
  activities?: Array<{ messageId: string; label: string; order: number }>;
}

/** One assistant turn section, carrying its own message model the way the page does. */
interface TurnFixture {
  id: string;
  messages: Message[];
  /** A visible `.markdown` block: its text, or markup when the test is about the markup. */
  rendered?: Array<string | { html: string }>;
  staleStamp?: string;
  conversationProps?: Record<string, unknown>;
}

async function scan(
  fibers: Fiber[],
  turnSections: TurnFixture[] = []
): Promise<{
  rows: Descriptor[];
  version: number;
  scanToken: string;
  stamps: Array<string | null>;
  turnStamps: Array<string | null>;
  turns: TurnEvidence[];
}> {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: `https://chatgpt.com/c/${THREAD}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const window = dom.window as unknown as Window & typeof globalThis & Record<string, any>;
  const document = window.document;

  for (const turn of turnSections) {
    const section = document.createElement('section');
    section.setAttribute('data-testid', 'conversation-turn-2');
    if (turn.id) section.setAttribute('data-turn-id', turn.id);
    if (turn.staleStamp !== undefined) section.setAttribute('data-clf-fiber-turn', turn.staleStamp);
    (section as unknown as Record<string, unknown>)['__reactFiber$qlrmvxwbkkq'] = turnNode(
      turn.messages,
      turn.conversationProps
    );
    for (const entry of turn.rendered ?? []) {
      const block = document.createElement('div');
      block.className = 'markdown';
      if (typeof entry === 'string') block.textContent = entry;
      else block.innerHTML = entry.html;
      section.append(block);
    }
    document.body.append(section);
  }

  const elements = fibers.map((fiber) => {
    const row = document.createElement('button');
    row.setAttribute('aria-label', 'Open tool call list');
    // React hangs the Fiber off a key with a per-build random suffix.
    (row as unknown as Record<string, unknown>)['__reactFiber$qlrmvxwbkkq'] = fiber;
    document.body.append(row);
    return row;
  });

  window.eval(source);

  const nonce = 'test-nonce';
  const reply = new Promise<Record<string, any>>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error('the helper never answered')), 2000);
    window.addEventListener('message', (event: any) => {
      if (!event.data || event.data.source !== 'clf-fiber-reply' || event.data.nonce !== nonce) return;
      globalThis.clearTimeout(timer);
      resolve(event.data);
    });
  });

  // Dispatched rather than posted: jsdom's own postMessage does not set `source`, and the
  // helper refuses any message that did not come from this window.
  window.dispatchEvent(
    new window.MessageEvent('message', { data: { source: 'clf-fiber-ask', nonce }, source: window })
  );

  const data = await reply;
  const stamps = elements.map((row) => row.getAttribute('data-clf-fiber'));
  const turnStamps = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')].map((section) =>
    section.getAttribute('data-clf-fiber-turn')
  );
  dom.window.close();
  return {
    rows: data.rows as Descriptor[],
    version: data.v as number,
    scanToken: data.scanToken as string,
    stamps,
    turnStamps,
    turns: (data.turns ?? []) as TurnEvidence[]
  };
}

/** One row whose group sits where the live page puts it. */
const row = (messages: Message[], collapsed = 0) => chain(group(messages, collapsed) as unknown as Record<string, unknown>);
const rowInTurn = (messages: Message[], turnMessages: Message[], collapsed = 0) =>
  chain(group(messages, collapsed) as unknown as Record<string, unknown>, LIVE_DEPTH, turnNode(turnMessages));

// --------------------------------------------------------------------- tests

describe('reading a row out of the page', () => {
  /**
   * The regression the whole batch exists for. The group node is exactly `MAX_CLIMB`
   * levels up, which the old `up < MAX_CLIMB` stopped one short of, so this row — and
   * every row of every chat — came back undescribed while looking like a browser that
   * simply had no helper.
   */
  it('reaches the group node at the depth the live page puts it', async () => {
    const ask = request('req-1', 'search_files');
    const { rows } = await scan([row([ask, answer('res-1', 'req-1', 'search_files')])]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ index: 0, tool: 'search_files', app: APP, answered: true });
  });

  it('names six sequential calls in the same chat, each as itself', async () => {
    const tools = ['search_files', 'search_files', 'read_file', 'list_directory', 'run_command', 'agent_status'];
    const { rows, stamps, scanToken } = await scan(
      tools.map((tool, at) => row([request(`req-${at}`, tool), answer(`res-${at}`, `req-${at}`, tool)]))
    );

    expect(rows.map((entry) => entry.tool)).toEqual(tools);
    expect(rows.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4, 5]);
    // Both worlds agree on which row each descriptor belongs to through the stamp, not
    // through querying the DOM twice and hoping React did not re-render in between.
    expect(scanToken).toBe('test-nonce');
    expect(stamps).toEqual(tools.map((_tool, index) => `test-nonce:${index}`));
  });

  it('keeps the version it was built for on the reply', async () => {
    const { version, rows } = await scan([row([request('req-1', 'read_file')])]);
    expect(version).toBe(10);
    expect(rows[0]!.v).toBe(10);
  });
  it('counts only TobisComputer requests in the complete turn, not api_tool metadata calls', async () => {
    const mine1 = request('req-1', 'read_file');
    const mine2 = request('req-2', 'search_files');
    const meta: Message = {
      id: 'meta-1',
      author: { role: 'assistant' },
      recipient: 'api_tool.list_resources',
      content: { text: '{"query":"TobisComputer"}' }
    };
    const other: Message = {
      id: 'other-1',
      author: { role: 'assistant' },
      recipient: 'api_tool.call_tool',
      content: { text: '{"path":"/Gmail/link_x/search","args":{}}' }
    };
    const turnMessages = [
      meta,
      mine1,
      answer('res-1', 'req-1', 'read_file'),
      other,
      mine2,
      answer('res-2', 'req-2', 'search_files')
    ];
    const { rows } = await scan([rowInTurn([mine2, answer('res-2', 'req-2', 'search_files')], turnMessages, 4)]);

    expect(rows[0]).toMatchObject({ tool: 'search_files', hidden: 4, localCount: 2 });
  });
});

/**
 * The v4 addition, and the reason attribution stopped depending on what ChatGPT drew.
 *
 * A count told the app "this turn made four calls"; it could not say *which*. Attribution
 * therefore still needed a visible row per call, and ChatGPT groups rows and sometimes
 * draws none at all — so a real chat's calls were filed under `Unattributed activity`
 * while the chat that made them sat beside it. Naming each request fixes that at the
 * source: a turn that rendered nothing still says exactly what it asked for.
 */
describe('the calls a turn says it made', () => {
  /**
   * The live regression: 1.7.1 renamed the connector and split it in two, and this test
   * spelled only the old name. Every request on every page stopped being recognised as
   * ours, so no turn produced evidence and one chat's whole run of calls was filed under
   * `Unattributed activity`. Both current connectors and the old name must read.
   */
  it('recognises both 1.7.1 connectors and the pre-1.7.1 name', async () => {
    const messages = [
      request('req-core', 'read'),
      answer('res-core', 'req-core', 'read'),
      request('req-desk', 'computer', { app: DESKTOP_APP }),
      answer('res-desk', 'req-desk', 'computer', DESKTOP_APP),
      request('req-old', 'read_file', { app: LEGACY_APP }),
      answer('res-old', 'req-old', 'read_file', LEGACY_APP)
    ];
    const { turns } = await scan([], [{ id: 'turn-renamed', messages }]);

    expect(turns[0]!.calls).toEqual([
      { messageId: 'req-core', tool: 'read', order: 0, answered: true, requestId: 'wfr_01a009', createTime: 1786873658.125 },
      { messageId: 'req-desk', tool: 'computer', order: 1, answered: true, requestId: 'wfr_01a009', createTime: 1786873658.125 },
      { messageId: 'req-old', tool: 'read_file', order: 2, answered: true, requestId: 'wfr_01a009', createTime: 1786873658.125 }
    ]);
  });

  /**
   * A name is not a prefix game. `Chat On Steroids Backup` shares every character of the
   * brand and is still a different integration; matching on the brand rather than on the
   * exact connector names would make this app vouch for its calls and file a stranger's
   * traffic into this chat's session.
   */
  it('refuses a connector whose name merely starts with this app’s brand', async () => {
    const messages = [
      request('req-fake', 'read', { app: 'Chat On Steroids Backup' }),
      answer('res-fake', 'req-fake', 'read', 'Chat On Steroids Backup'),
      request('req-mine', 'read')
    ];
    const { turns } = await scan([], [{ id: 'turn-lookalike', messages }]);

    expect(turns[0]!.calls.map((call) => call.messageId)).toEqual(['req-mine']);
  });

  it('names every request in the turn, in order, with its result state', async () => {
    const messages = [
      request('req-a', 'search_files'),
      answer('res-a', 'req-a', 'search_files'),
      request('req-b', 'read_file'),
      answer('res-b', 'req-b', 'read_file'),
      // Issued but not answered yet: the turn is still running.
      request('req-c', 'run_powershell')
    ];
    const { turns } = await scan([], [{ id: 'turn-evidence', messages }]);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.turnId).toBe('turn-evidence');
    expect(turns[0]!.calls).toEqual([
      { messageId: 'req-a', tool: 'search_files', order: 0, answered: true, requestId: 'wfr_01a009', createTime: 1786873658.125 },
      { messageId: 'req-b', tool: 'read_file', order: 1, answered: true, requestId: 'wfr_01a009', createTime: 1786873658.125 },
      { messageId: 'req-c', tool: 'run_powershell', order: 2, answered: false, requestId: 'wfr_01a009', createTime: 1786873658.125 }
    ]);
  });

  /** The blocker itself: no connector row anywhere, and the calls are still accounted for. */
  it('reports a turn’s calls even when the page drew no tool row at all', async () => {
    const messages = [
      request('req-1', 'read_files'),
      answer('res-1', 'req-1', 'read_files'),
      request('req-2', 'screenshot'),
      answer('res-2', 'req-2', 'screenshot')
    ];
    const { rows, turns } = await scan([], [{ id: 'turn-rowless', messages }]);

    expect(rows).toHaveLength(0);
    expect(turns[0]!.calls.map((call) => call.tool)).toEqual(['read_files', 'screenshot']);
  });

  it('refuses to vouch for another connector’s traffic', async () => {
    const gmail: Message = {
      id: 'gmail-1',
      author: { role: 'assistant' },
      recipient: 'api_tool.call_tool',
      content: { text: '{"path":"/Gmail/link_x/search","args":{}}' }
    };
    const meta: Message = {
      id: 'meta-1',
      author: { role: 'assistant' },
      recipient: 'api_tool.list_resources',
      content: { text: '{"query":"TobisComputer"}' }
    };
    const messages = [gmail, meta, request('req-mine', 'read_file'), answer('res-mine', 'req-mine', 'read_file')];
    const { turns } = await scan([], [{ id: 'turn-mixed', messages }]);

    expect(turns[0]!.calls).toEqual([{ messageId: 'req-mine', tool: 'read_file', order: 0, answered: true, requestId: 'wfr_01a009', createTime: 1786873658.125 }]);
  });

  it('drops a message id the turn reports twice rather than spending it on two records', async () => {
    const messages = [
      request('req-dup', 'read_file'),
      request('req-dup', 'run_command'),
      request('req-ok', 'search_files')
    ];
    const { turns } = await scan([], [{ id: 'turn-dup', messages }]);

    expect(turns[0]!.calls.map((call) => call.messageId)).toEqual(['req-ok']);
  });

  it('carries no argument value, no result body and no path', async () => {
    // `request()` puts a real file path and an 80-character note in the payload. Neither
    // may appear anywhere in what crosses back into the isolated world.
    const messages = [request('req-secret', 'read_file'), answer('res-secret', 'req-secret', 'read_file')];
    const { turns } = await scan([], [{ id: 'turn-secret', messages }]);

    const wire = JSON.stringify(turns);
    expect(wire).not.toContain('secret.txt');
    expect(wire).not.toContain('xxxx');
    expect(wire).not.toContain(LINK);
    // The allowlist, and the whole of it. `requestId` and `createTime` are ChatGPT's own
    // identifiers for the request — an opaque id and a timestamp — carried because they are
    // the only candidates for joining a call to the conversation that issued it without
    // guessing. Neither is derived from `args`, and this list is what keeps that true.
    expect(Object.keys(turns[0]!.calls[0]!).sort()).toEqual([
      'answered',
      'createTime',
      'messageId',
      'order',
      'requestId',
      'tool'
    ]);
  });

  it('distinguishes contradictory conversation metadata from missing conversation metadata', async () => {
    const other = '11111111-2222-3333-4444-555555555555';
    const messages = [authored('assistant-conflicted-chat', 'Stale mounted answer.')];
    const { turns } = await scan([], [{
      id: 'turn-conflicted-chat',
      messages,
      rendered: ['Stale mounted answer.'],
      conversationProps: { clientThreadId: THREAD, conversationId: other }
    }]);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      conversationId: null,
      conversationConflict: true
    });
  });

  it('reads each visible turn separately rather than merging them', async () => {
    const first = [request('req-1', 'read_file'), answer('res-1', 'req-1', 'read_file')];
    const second = [request('req-2', 'run_command')];
    const { turns } = await scan([], [
      { id: 'turn-one', messages: first },
      { id: 'turn-two', messages: second }
    ]);

    expect(turns.map((turn) => turn.turnId)).toEqual(['turn-one', 'turn-two']);
    expect(turns[1]!.calls.map((call) => call.tool)).toEqual(['run_command']);
  });

  it('takes canonical assistant identity and raw Markdown from the public text message model, not Markdown-node cardinality', async () => {
    const publicText = '**One** canonical update with `code`.';
    const messages = [
      thought('internal-thought-1'),
      request('req-1', 'read_file'),
      thought('internal-thought-2'),
      authored('assistant-public-1', publicText),
      answer('res-1', 'req-1', 'read_file')
    ];
    const { turns } = await scan([], [
      {
        id: 'turn-prose',
        messages,
        // Deliberately unlike the raw Markdown and deliberately more numerous. This is the
        // live 1.8.1 failure shape: activity/tool internals also render `.markdown`, so DOM
        // cardinality is not message cardinality and must never gate capture.
        rendered: ['One canonical update with code.', 'Inspected a file', 'Internal activity caption']
      }
    ]);

    expect(turns[0]!.messages).toEqual([
      {
        messageId: 'assistant-public-1',
        rawMessageId: 'assistant-public-1',
        role: 'assistant',
        stable: false,
        order: 3,
        createTime: null,
        rawText: publicText,
        renderedHtml: ''
      }
    ]);
  });

  it('attaches rendered HTML only when a public message has one unique exact visible-text match', async () => {
    const messages = [authored('assistant-public-1', 'A plain live update.')];
    const { turns } = await scan([], [
      { id: 'turn-html', messages, rendered: ['Unrelated activity', 'A plain live update.'] }
    ]);

    expect(turns[0]!.messages).toEqual([
      {
        messageId: 'assistant-public-1',
        rawMessageId: 'assistant-public-1',
        role: 'assistant',
        stable: false,
        order: 0,
        createTime: null,
        rawText: 'A plain live update.',
        renderedHtml: 'A plain live update.',
        sectionIndex: 0
      }
    ]);
  });

  /**
   * Markup is carried whole or not at all.
   *
   * Cutting it at a character count cuts it mid-tag, and the cut lands inside ChatGPT's
   * code-block chrome far more often than its size suggests, because that chrome is several
   * hundred characters of toolbar and layout around a few lines of code. What arrived then
   * was a presentation that stopped inside an unclosed box: the prose after the block gone,
   * and the remainder of the message drawn as code. The canonical text below is unaffected,
   * so refusing the capture costs presentation and never content.
   */
  it('drops a rendered capture too large to carry whole rather than cutting it mid-tag', async () => {
    const text = 'x'.repeat(121_000);
    const { turns } = await scan([], [
      {
        id: 'turn-oversized-html',
        messages: [authored('assistant-oversized', text)],
        rendered: [{ html: `<p>${text}</p>` }]
      }
    ]);

    expect(turns[0]!.messages[0]!.rawText).toBe(text);
    expect(turns[0]!.messages[0]!.renderedHtml).toBe('');
    // No rendered join was made either, so nothing downstream reads this block as evidence.
    expect(turns[0]!.messages[0]).not.toHaveProperty('sectionIndex');
  });

  it('keeps one exact logical id when ChatGPT rotates the raw UUID before the thought parent mounts', async () => {
    const relation = {
      parent: 'thought-stream-owner',
      workingTurnId: 'working-stream-owner',
      turnExchangeId: 'exchange-stream-owner'
    };
    const first = await scan([], [{
      id: 'turn-rotating-child',
      messages: [authored('raw-child-one', 'First partial.', relation)]
    }]);
    const second = await scan([], [{
      id: 'turn-rotating-child',
      messages: [authored('raw-child-two', 'First partial. More text.', relation)]
    }]);

    expect(first.turns[0]!.messages[0]!.rawMessageId).toBe('raw-child-one');
    expect(second.turns[0]!.messages[0]!.rawMessageId).toBe('raw-child-two');
    expect(first.turns[0]!.messages[0]!.messageId).toBe(second.turns[0]!.messages[0]!.messageId);
    expect(first.turns[0]!.messages[0]!.messageId).toBe(
      'assistant:thought-stream-owner:working-stream-owner:exchange-stream-owner'
    );
    expect(first.turns[0]!.messages[0]!.stable).toBe(false);
    expect(second.turns[0]!.messages[0]!.stable).toBe(false);
  });

  it('keeps one exact logical id when a reload re-parents the same server message', async () => {
    // The live shape from 2026-08-20: reloading a chat rehydrates it from the server, which
    // hands the same authored message a different `parent_id` while `working_turn_id`,
    // `turn_exchange_id` and `create_time` all stay put. Keyed on the parent, every message
    // already recorded came back as a second row and the transcript showed each one twice.
    const branch = { workingTurnId: 'working-43a30177', turnExchangeId: 'exchange-43a30177', createTime: 1_787_211_141.137 };
    const live = await scan([], [{
      id: 'turn-reloaded',
      messages: [authored('raw-live', 'I am auditing the MCP-visible contract first.', { ...branch, parent: 'thought-e97025b0' })]
    }]);
    const reloaded = await scan([], [{
      id: 'turn-reloaded',
      messages: [authored('raw-rehydrated', 'I am auditing the MCP-visible contract first.', { ...branch, parent: 'thought-3ecd4ef3' })]
    }]);

    expect(live.turns[0]!.messages[0]!.messageId).toBe(
      'assistant:working-43a30177:exchange-43a30177:1787211141137'
    );
    expect(reloaded.turns[0]!.messages[0]!.messageId).toBe(live.turns[0]!.messages[0]!.messageId);
    expect(live.turns[0]!.messages[0]!.stable).toBe(true);
    expect(reloaded.turns[0]!.messages[0]!.stable).toBe(true);
  });

  it('falls back to the parent tuple when two messages of one branch share a creation stamp', async () => {
    const branch = { workingTurnId: 'working-same', turnExchangeId: 'exchange-same', createTime: 1_787_211_141.137 };
    const { turns } = await scan([], [{
      id: 'turn-collision',
      messages: [
        authored('raw-first', 'First.', { ...branch, parent: 'thought-first' }),
        authored('raw-second', 'Second.', { ...branch, parent: 'thought-second' })
      ]
    }]);

    expect(turns[0]!.messages.map((message) => message.messageId)).toEqual([
      'assistant:working-same:exchange-same:1787211141137',
      'assistant:thought-second:working-same:exchange-same'
    ]);
  });

  it('keeps two messages when both the creation stamp and parent tuple collide', async () => {
    const relation = { parent: 'thought-same', workingTurnId: 'working-same', turnExchangeId: 'exchange-same' };
    const { turns } = await scan([], [{
      id: 'turn-double-collision',
      messages: [
        authored('raw-first', 'First.', relation),
        authored('raw-second', 'Second.', relation)
      ]
    }]);

    expect(turns[0]!.messages.map((message) => message.messageId)).toEqual([
      'assistant:thought-same:working-same:exchange-same',
      'raw-second'
    ]);
    expect(turns[0]!.messages[1]!.stable).toBe(false);
  });

  it('captures the opening user message from the page model before the DOM exposes a message id', async () => {
    const opening: Message = {
      id: 'user-opening-model-id',
      author: { role: 'user' },
      recipient: 'all',
      create_time: 1_787_165_000.125,
      content: { content_type: 'text', parts: ['first prompt before DOM identity'] }
    };
    const { turns } = await scan([], [{ id: 'turn-opening-user', messages: [opening] }]);

    expect(turns[0]!.messages).toEqual([
      {
        messageId: 'user-opening-model-id',
        rawMessageId: 'user-opening-model-id',
        role: 'user',
        stable: true,
        order: 0,
        createTime: 1_787_165_000_125,
        rawText: 'first prompt before DOM identity',
        renderedHtml: ''
      }
    ]);
  });

  it('keeps exact transcript evidence when a virtualized assistant section has no data-turn-id', async () => {
    const publicText = authored('assistant-idless-page-turn', 'Visible historical answer.');
    const { turns, turnStamps } = await scan([], [{ id: '', messages: [publicText], rendered: ['Visible historical answer.'] }]);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.turnId).toBeNull();
    expect(turns[0]!.messages[0]).toMatchObject({
      messageId: 'assistant-idless-page-turn',
      rawText: 'Visible historical answer.'
    });
    expect(turnStamps).toEqual(['test-nonce:0']);
  });

  it('keeps a long public assistant answer beyond the old 32k transcript cap', async () => {
    const long = 'handoff detail '.repeat(14000);
    expect(long.length).toBeGreaterThan(180_000);
    expect(long.length).toBeLessThan(256_000);
    const { turns } = await scan([], [{ id: 'turn-long-answer', messages: [authored('assistant-long', long)] }]);

    expect(turns[0]!.messages[0]!.rawText).toBe(long);
  });

  it('marks completion only from the finished public text message whose website object says end_turn', async () => {
    const internal = thought('thought-terminal-looking');
    internal.status = 'finished_successfully';
    internal.end_turn = true;
    const messages = [
      internal,
      authored('interim-public', 'Still working.', { status: 'finished_successfully', endTurn: false }),
      authored('final-public', 'Finished.', { status: 'finished_successfully', endTurn: true })
    ];
    const { turns } = await scan([], [{ id: 'turn-terminal', messages, rendered: ['Still working.', 'Finished.'] }]);

    expect(turns[0]!.endMessageId).toBe('final-public');
  });

  it('reads through the trailing analysis ghost the page leaves after a finished answer', async () => {
    // Measured live 2026-08-31 on a finished tool-heavy turn: the answer sits on `final` with
    // `end_turn`, and behind it the page keeps an empty `analysis` message at `in_progress`
    // forever. Reading the tail as "the last public text decides" hid the answer for good.
    const ghost = authored('analysis-ghost', '', { status: 'in_progress', channel: 'analysis' });
    const messages = [
      authored('final-public', 'Finished.', { status: 'finished_successfully', endTurn: true, channel: 'final' }),
      ghost
    ];
    const { turns } = await scan([], [{ id: 'turn-ghost', messages, rendered: ['Finished.'] }]);

    expect(turns[0]!.endMessageId).toBe('final-public');
    expect(turns[0]!.messages.map((message) => message.messageId)).toEqual(['final-public']);
  });

  it('reads through a trailing commentary message that never carries the answer', async () => {
    const messages = [
      authored('final-public', 'Finished.', { status: 'finished_successfully', endTurn: true, channel: 'final' }),
      authored('narration', 'Wrapping up.', { status: 'finished_successfully', endTurn: false, channel: 'commentary' })
    ];
    const { turns } = await scan([], [{ id: 'turn-narration', messages, rendered: ['Finished.', 'Wrapping up.'] }]);

    expect(turns[0]!.endMessageId).toBe('final-public');
  });

  it('still lets a newer answer-capable message hold the turn open after an earlier answer ended', async () => {
    const messages = [
      authored('old-final', 'Old completed attempt.', { status: 'finished_successfully', endTurn: true, channel: 'final' }),
      authored('retry-active', 'Trying again.', { status: 'finished_successfully', endTurn: false, channel: 'final' })
    ];
    const { turns } = await scan([], [{ id: 'turn-channel-retry', messages, rendered: ['Old completed attempt.', 'Trying again.'] }]);

    expect(turns[0]!.endMessageId ?? null).toBeNull();
  });

  it('does not call an active turn finished merely because prior messages are finished successfully', async () => {
    const messages = [
      authored('prior-public', 'Checkpoint.', { status: 'finished_successfully', endTurn: false }),
      authored('active-public', 'Continuing.', { status: 'finished_successfully', endTurn: false })
    ];
    const { turns } = await scan([], [{ id: 'turn-active', messages, rendered: ['Checkpoint.', 'Continuing.'] }]);

    expect(turns[0]!.endMessageId ?? null).toBeNull();
  });

  it('treats a newer retry message as active even when the previous attempt ended successfully', async () => {
    const messages = [
      authored('old-final', 'Old completed attempt.', { status: 'finished_successfully', endTurn: true }),
      authored('retry-active', 'Trying again.', { status: 'finished_successfully', endTurn: false })
    ];
    const { turns } = await scan([], [{ id: 'turn-retry', messages, rendered: ['Old completed attempt.', 'Trying again.'] }]);

    expect(turns[0]!.endMessageId ?? null).toBeNull();
  });

  it('says nothing about a turn that made no connector call', async () => {
    const chatter: Message = { id: 'm-1', author: { role: 'assistant' }, recipient: 'all', content: { text: 'hello' } };
    const { turns } = await scan([], [{ id: 'turn-quiet', messages: [chatter] }]);

    expect(turns).toEqual([]);
  });

  it('reports a request id ChatGPT has published before the api_tool message exists', async () => {
    // The live 2026-08-21 shape. ChatGPT stamps `metadata.request_id` on the plain public
    // message the moment the turn issues a connector request, and holds the `api_tool`
    // message behind its safety check — measured on this machine at around forty seconds,
    // where the app gives up after fifteen. `calls` cannot see this id: there is no
    // recipient and no tool path to read yet. `requests` is the view that can.
    const pending = authored('m-pending', 'Working on it.', { createTime: 1786873650.5 });
    pending.metadata!['request_id'] = 'wfr_safety_held';
    const { turns } = await scan([], [{ id: 'turn-safety-held', messages: [pending], rendered: ['Working on it.'] }]);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.calls).toEqual([]);
    expect(turns[0]!.requests).toEqual([
      { requestId: 'wfr_safety_held', messageId: 'm-pending', createTime: 1786873650.5 }
    ]);
  });

  it('reports a turn that has nothing but a request id', async () => {
    // Nothing rendered, no row, no result — the turn used to be dropped whole, taking the
    // one fact the app actually needs with it.
    const bare: Message = {
      id: 'm-bare',
      author: { role: 'assistant' },
      recipient: 'all',
      metadata: { request_id: 'wfr_bare' }
    };
    const { turns } = await scan([], [{ id: 'turn-bare', messages: [bare] }]);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.requests).toEqual([{ requestId: 'wfr_bare', messageId: 'm-bare', createTime: null }]);
  });

  it('reports one request id once however many messages of the turn carry it', async () => {
    // ChatGPT reuses a single request id across a turn's request, its result and its public
    // message. The correlation join is a set, not a count.
    const { turns } = await scan([], [{
      id: 'turn-repeated-id',
      messages: [request('req-1', 'read_file'), answer('res-1', 'req-1', 'read_file')]
    }]);

    expect(turns[0]!.requests).toEqual([
      { requestId: 'wfr_01a009', messageId: 'req-1', createTime: 1786873658.125 }
    ]);
  });

  it('carries nothing but the id, the message it sat on and its stamp', async () => {
    const pending = authored('m-allowlist', 'Working.', { createTime: 1786873650.5 });
    pending.metadata!['request_id'] = 'wfr_allowlist';
    // Everything else on a real message's metadata, none of which may leave the page.
    pending.metadata!['parent_id'] = 'must-not-leak';
    pending.metadata!['turn_exchange_id'] = 'must-not-leak';
    const { turns } = await scan([], [{ id: 'turn-allowlist', messages: [pending], rendered: ['Working.'] }]);

    expect(Object.keys(turns[0]!.requests![0]!).sort()).toEqual(['createTime', 'messageId', 'requestId']);
  });

  it('clears a stale turn stamp when that section has no descriptor in this scan', async () => {
    const { turns, turnStamps } = await scan([], [
      { id: 'turn-stale-stamp', messages: [], staleStamp: '0' }
    ]);

    expect(turns).toEqual([]);
    expect(turnStamps).toEqual([null]);
  });
});

describe('which call a row stands for', () => {
  /**
   * ChatGPT's own "Open tool call list" for the turn behind this fixture read
   * `1: list_resources, 2: create_agents` under a single row, and the row showed
   * `create_agents`. So the representative is the group's own request, and the folded call
   * is a count — of a *different* tool, which is why the count can never be read as
   * "another call to the same tool as this one".
   */
  it('takes the group its own request, with the folded call counted and not named', async () => {
    const ask = request('req-agents', 'create_agents');
    const { rows } = await scan([
      row(
        [
          ask,
          answer('res-agents', 'req-agents', 'create_agents'),
          // The folded call's result. It is in this array, but it is chained to a request
          // that is not — reading it as this row's identity is the mislabelling bug.
          answer('res-resources', 'req-elsewhere', 'list_resources')
        ],
        1
      )
    ]);

    expect(rows[0]).toMatchObject({ tool: 'create_agents', hidden: 1, answered: true });
    expect(rows[0]!.resource).toContain('create_agents');
  });

  it('pairs the result by parent_id rather than by whatever came back next', async () => {
    const { rows } = await scan([
      row([
        request('req-mine', 'read_file'),
        // A neighbour's result, sitting where a forward scan would take it as ours.
        answer('res-theirs', 'req-theirs', 'run_command'),
        answer('res-mine', 'req-mine', 'read_file')
      ])
    ]);

    expect(rows[0]!.tool).toBe('read_file');
    expect(rows[0]!.resource).toContain('read_file');
    expect(rows[0]!.resource).not.toContain('run_command');
  });

  it('reports a call with no result of its own as unanswered rather than borrowing one', async () => {
    const { rows } = await scan([
      row([request('req-mine', 'search_files'), answer('res-theirs', 'req-theirs', 'run_command')])
    ]);

    expect(rows[0]).toMatchObject({ tool: 'search_files', answered: false, app: null, resource: null });
  });

  /**
   * The turn-level node carries every message of the turn. Picking a request out of it is
   * picking one of many by position, which is how a row ends up wearing a neighbour's
   * name — so reaching it means the group was not found, not "use this instead".
   */
  it('refuses the turn-level messages rather than guessing from them', async () => {
    const messages = [
      request('req-1', 'search_files'),
      answer('res-1', 'req-1', 'search_files'),
      request('req-2', 'read_file'),
      answer('res-2', 'req-2', 'read_file')
    ];
    const { rows } = await scan([chain(null, 4, turnNode(messages))]);

    expect(rows).toEqual([]);
  });

  it('gives up on a row whose group starts with something other than a connector request', async () => {
    const { rows } = await scan([row([answer('res-1', 'req-1', 'read_file'), request('req-2', 'search_files')])]);
    expect(rows).toEqual([]);
  });
});

describe('a payload the page stored truncated', () => {
  /**
   * `JSON.parse` throws `Unterminated string in JSON at position 741` on most live
   * requests. The old reader caught that and fell back to the recipient,
   * `api_tool.call_tool`, so the row was confidently labelled `call_tool` — a tool this
   * connector does not have and never ran.
   */
  it('still names the tool, and never falls back to the connector bridge', async () => {
    const { rows } = await scan([
      row([request('req-1', 'create_file', { truncate: 90 }), answer('res-1', 'req-1', 'create_file')])
    ]);

    expect(rows[0]!.tool).toBe('create_file');
    expect(rows[0]!.tool).not.toBe('call_tool');
  });

  it('falls back to the result when the cut lands inside the path itself', async () => {
    const { rows } = await scan([
      row([request('req-1', 'create_file', { truncate: 40 }), answer('res-1', 'req-1', 'create_file')])
    ]);

    expect(rows[0]).toMatchObject({ tool: 'create_file', path: null, answered: true });
  });

  it('says nothing at all when neither source can be read', async () => {
    const { rows } = await scan([row([request('req-1', 'create_file', { truncate: 40 })])]);

    // The descriptor still exists — it carries the fold count — but it names no tool, so
    // applyPageLabel leaves the row exactly as ChatGPT drew it.
    expect(rows[0]).toMatchObject({ tool: null, path: null, answered: false });
  });

  it('fails closed when the request and the result name different tools', async () => {
    const { rows } = await scan([
      row([request('req-1', 'search_files'), answer('res-1', 'req-1', 'read_file')])
    ]);

    // Two sources disagreeing means the pairing is wrong. A row left saying "Called tool"
    // is a smaller failure than a row saying "Search files" over a file read.
    expect(rows[0]!.tool).toBeNull();
  });
});

describe('what may leave the page', () => {
  /**
   * The payload carries the user's own text and this app's own secrets. The tool path is
   * the first field of it; a file tool's own `path` argument is a second `"path"` later in
   * the same string, and reading that one would put a user's filename on a row and ship it
   * out of the page context.
   */
  it('reads the tool path and never the path argument beside it', async () => {
    const { rows } = await scan([row([request('req-1', 'create_file')])]);

    expect(rows[0]!.path).toBe(`/${APP}/${LINK}/create_file`);
    expect(JSON.stringify(rows[0])).not.toContain('secret.txt');
  });

  it('emits the allowlisted fields and nothing else', async () => {
    const { rows } = await scan([row([request('req-1', 'read_file'), answer('res-1', 'req-1', 'read_file')])]);

    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        'answered',
        'app',
        'conversationId',
        'createTime',
        'hidden',
        'index',
        'localCount',
        'messageId',
        'path',
        'resource',
        'tool',
        'turnId',
        'v'
      ].sort()
    );
  });

  it('does not let one unreadable row cost the others their labels', async () => {
    const { rows } = await scan([
      row([request('req-1', 'read_file')]),
      chain(null, 4, turnNode([request('req-2', 'search_files')])),
      row([request('req-3', 'run_command')])
    ]);

    expect(rows.map((entry) => [entry.index, entry.tool])).toEqual([
      [0, 'read_file'],
      [2, 'run_command']
    ]);
  });
});
