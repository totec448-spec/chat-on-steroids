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

const THREAD = 'f0f00004-1111-4111-8111-111111111111';
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
const LINK = 'link_11111111222233334444555555555555';
/** A result's resource uri names the app instance rather than the connector. */
const ASDK = 'asdk_app_22222222333344445555666666666666';
/** The depth the live page put the group node at. The old limit was 30 exclusive. */
const LIVE_DEPTH = 30;

interface Message {
  id: string;
  author: { role: string; name?: string };
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
  codeModeCalls?: Array<{ messageId: string; requestId: string | null; answered: boolean }>;
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
  thoughtNotifications?: Array<{ messageId: string; kind: 'thought_notification' }>;
  images?: Array<{
    messageId: string;
    assetId: string;
    providerRole: 'tool' | 'assistant';
    order: number;
    partOrder: number;
    createTime?: number | null;
    width?: number;
    height?: number;
  }>;
}

/** One assistant turn section, carrying its own message model the way the page does. */
interface TurnFixture {
  id: string;
  messages: Message[];
  /** A visible `.markdown` block: its text, or markup when the test is about the markup. */
  rendered?: Array<string | { html: string; nativeId?: string; fiberProps?: Record<string, unknown>; fiber?: Fiber; staleMessageStamp?: string }>;
  activities?: Array<{ label: string; fiber: Fiber; staleThoughtStamp?: string; v5?: boolean }>;
  images?: Array<{ assetId: string; clones?: number }>;
  staleStamp?: string;
  conversationProps?: Record<string, unknown>;
  rect?: { top: number; bottom: number; left: number; right: number } | 'throw';
}

async function scan(
  fibers: Fiber[],
  turnSections: TurnFixture[] = [],
  repeatStableScan = false
): Promise<{
  rows: Descriptor[];
  version: number;
  scanToken: string;
  stamps: Array<string | null>;
  turnStamps: Array<string | null>;
  messageStamps: Array<string | null>;
  thoughtStamps: Array<string | null>;
  imageStamps: Array<string | null>;
  repeatedStampMutations: number;
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
    if (turn.rect) section.getBoundingClientRect = () => {
      if (turn.rect === 'throw') throw new Error('unavailable geometry');
      return turn.rect as DOMRect;
    };
    (section as unknown as Record<string, unknown>)['__reactFiber$qlrmvxwbkkq'] = turnNode(
      turn.messages,
      turn.conversationProps
    );
    for (const entry of turn.rendered ?? []) {
      const block = document.createElement('div');
      block.className = 'markdown';
      if (typeof entry === 'string') block.textContent = entry;
      else {
        block.innerHTML = entry.html;
        if (entry.nativeId) block.setAttribute('data-message-id', entry.nativeId);
        if (entry.fiberProps) (block as unknown as Record<string, unknown>)['__reactFiber$qlrmvxwbkkq'] = chain(entry.fiberProps);
        if (entry.fiber) (block as unknown as Record<string, unknown>)['__reactFiber$qlrmvxwbkkq'] = entry.fiber;
        if (entry.staleMessageStamp) block.setAttribute('data-clf-fiber-message', entry.staleMessageStamp);
      }
      section.append(block);
    }
    for (const entry of turn.activities ?? []) {
      const row = document.createElement(entry.v5 ? 'div' : 'span');
      if (entry.v5) row.innerHTML = '<span data-testid="cot-v5-tool-icon-pile"><span data-testid="cot-v5-native-tool-icon"><svg></svg></span></span>';
      else row.className = 'group/tool-message';
      row.append(entry.label);
      if (entry.staleThoughtStamp) row.setAttribute('data-clf-fiber-thought', entry.staleThoughtStamp);
      (row as unknown as Record<string, unknown>)['__reactFiber$qlrmvxwbkkq'] = entry.fiber;
      section.append(row);
    }
    for (const entry of turn.images ?? []) {
      const add = () => {
        const wrapper = document.createElement('div');
        wrapper.className = 'group/imagegen-image';
        const image = document.createElement('img');
        image.src = `https://chatgpt.com/backend-api/estuary/content?id=${encodeURIComponent(entry.assetId)}&sig=private`;
        wrapper.append(image);
        section.append(wrapper);
      };
      for (let clone = 0; clone < Math.max(1, entry.clones ?? 1); clone++) add();
    }
    document.body.append(section);
  }

  const elements = fibers.map((fiber) => {
    const row = document.createElement('span');
    row.className = 'group/tool-message';
    row.setAttribute('aria-label', '工具呼び出し一覧');
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
  let repeatedStampMutations = 0;
  if (repeatStableScan) {
    const observer = new window.MutationObserver(() => {});
    observer.observe(document.body, { subtree: true, attributes: true,
      attributeFilter: ['data-clf-fiber-turn', 'data-clf-fiber-message', 'data-clf-fiber-thought'] });
    window.dispatchEvent(new window.MessageEvent('message', { data: { source: 'clf-fiber-ask', nonce }, source: window }));
    repeatedStampMutations = observer.takeRecords().length;
    observer.disconnect();
  }
  const stamps = elements.map((row) => row.getAttribute('data-clf-fiber'));
  const messageStamps = [...document.querySelectorAll('.markdown')].map(node => node.getAttribute('data-clf-fiber-message'));
  const thoughtStamps = [...document.querySelectorAll('[data-clf-fiber-thought], .group\\/tool-message, div:has(> [data-testid="cot-v5-tool-icon-pile"])')]
    .filter(node => node.closest('[data-testid^="conversation-turn-"]'))
    .map(node => node.getAttribute('data-clf-fiber-thought'));
  const imageStamps = [...document.querySelectorAll('.group\\/imagegen-image img')]
    .map(node => node.getAttribute('data-clf-fiber-image'));
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
    messageStamps,
    thoughtStamps,
    imageStamps,
    repeatedStampMutations,
    turns: (data.turns ?? []) as TurnEvidence[]
  };
}

/** One row whose group sits where the live page puts it. */
const row = (messages: Message[], collapsed = 0) => chain(group(messages, collapsed) as unknown as Record<string, unknown>);
const rowInTurn = (messages: Message[], turnMessages: Message[], collapsed = 0) =>
  chain(group(messages, collapsed) as unknown as Record<string, unknown>, LIVE_DEPTH, turnNode(turnMessages));

// --------------------------------------------------------------------- tests

describe('reading a row out of the page', () => {
  it.each(['exact', 'missing', 'duplicate', 'cycle', 'different-request', 'tool-boundary', 'foreign-tool'])(
    'follows an exact result parent through the native intermediate message (%s)', async mode => {
      const asked = request('linked-request', 'read');
      const intermediate = authored('linked-intermediate', '', { parent: asked.id, status: 'finished_successfully' });
      const result = answer('linked-result', intermediate.id, mode === 'foreign-tool' ? 'exec_command' : 'read');
      result.author.name = 'api_tool.call_tool';
      Object.defineProperty(result.content!, 'text', { get() { throw new Error('Result bytes must remain unread'); } });
      if (mode === 'cycle') intermediate.metadata!.parent_id = intermediate.id;
      if (mode === 'different-request') intermediate.metadata!.request_id = 'another-response';
      if (mode === 'tool-boundary') intermediate.recipient = 'functions.exec';
      const messages = [asked, ...(mode === 'missing' ? [] : [intermediate]), result,
        ...(mode === 'duplicate' ? [intermediate] : [])];
      const { rows, turns } = await scan([rowInTurn([asked, result], messages)], [{ id: 'linked-turn', messages }]);
      expect(rows[0]).toMatchObject({ messageId: asked.id, tool: 'read', answered: mode === 'exact' });
      expect(turns[0]!.calls).toEqual([expect.objectContaining({ messageId: asked.id, tool: 'read', answered: mode === 'exact' })]);
      if (mode === 'exact') expect(rows[0]!.localCount).toBe(1);
    });

  it.each(['settled', 'running', 'unknown-state', 'unfinished-result', 'different-request', 'different-exchange', 'different-tool', 'foreign-app', 'multiple-results'])(
    'uses the displayed parentless result identity without completing its stale request (%s)', async mode => {
      const asked = request('detached-request', 'read'); asked.status = 'finished_successfully';
      const result = answer('detached-result', 'unused', mode === 'different-tool' ? 'exec_command' : 'read', mode === 'foreign-app' ? 'Gmail' : APP);
      result.author.name = 'api_tool.call_tool'; delete result.metadata!.parent_id;
      result.status = mode === 'unfinished-result' ? 'in_progress' : 'finished_successfully';
      if (mode === 'different-request') result.metadata!.request_id = 'another-response';
      if (mode === 'different-exchange') result.metadata!.turn_exchange_id = 'another-exchange';
      Object.defineProperty(result.content!, 'text', { get() { throw new Error('Result bytes must remain unread'); } });
      const messages = [asked, result, ...(mode === 'multiple-results' ? [{ ...result, id: 'second-result' }] : [])];
      const props = { ...group(messages), ...(mode === 'unknown-state' ? {} : { isCompletionRequestInProgress: mode === 'running' }) };
      const { rows, turns } = await scan([chain(props, LIVE_DEPTH, turnNode(messages))], [{ id: 'detached-turn', messages }]);
      const accepted = mode === 'settled';
      expect(rows[0]).toMatchObject({ messageId: accepted ? result.id : asked.id, tool: 'read', answered: accepted });
      expect(turns[0]!.calls.find(call => call.messageId === asked.id)?.answered).toBe(false);
      if (accepted) expect(turns[0]!.calls.find(call => call.messageId === result.id)?.answered).toBe(true);
    });

  it('recognises a native result-only call without inventing its missing request parent', async () => {
    // Observed provider shape: tool/api_tool.call_tool with invoked_resource,
    // but no request message or metadata.parent_id in the rehydrated turn.
    const result = answer('result-only', 'unused', 'read');
    result.author.name = 'api_tool.call_tool';
    delete result.metadata!.parent_id;
    Object.defineProperty(result.content!, 'text', { get() { throw new Error('Result bytes must remain unread'); } });
    const { rows, turns } = await scan([rowInTurn([result], [result])], [{ id: 'result-only-turn', messages: [result] }]);
    expect(rows[0]).toMatchObject({ messageId: 'result-only', tool: 'read', app: APP, path: null, answered: true, localCount: 1 });
    expect(turns[0]!.calls).toEqual([{ messageId: 'result-only', tool: 'read', order: 0,
      answered: true, requestId: 'wfr_01a009', createTime: 1786873669.5 }]);
  });

  it.each(['Chat On Steroids Core', 'Chat On Steroids Desktop', 'Chat On Steroids Plugins', 'Chat On Steroids Backup', 'Gmail'])(
    'keeps result-only metadata scoped to the exact supported connector %s', async app => {
      const result = answer('result-scope', 'unused', 'read', app);
      result.author.name = 'api_tool.call_tool';
      delete result.metadata!.parent_id;
      const { turns } = await scan([], [{ id: 'result-scope-turn', messages: [result, result] }]);
      // Duplicate provider objects are ambiguous, including result-only shapes.
      expect(turns[0]!.calls).toEqual([]);
      const single = await scan([], [{ id: 'result-scope-turn', messages: [result] }]);
      expect(single.turns[0]!.calls).toHaveLength(['Chat On Steroids Backup', 'Gmail'].includes(app) ? 0 : 1);
    });

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
    expect(version).toBe(21);
    expect(rows[0]!.v).toBe(21);
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
  it.each(['pending', 'complete', 'wrong-request', 'missing-parent', 'duplicate-result', 'wrong-tool'])(
    'waits for the exact enclosing native Code Mode result (%s)', async mode => {
      const root: Message = { id: 'code-root', author: { role: 'assistant' }, recipient: 'functions.exec',
        status: 'finished_successfully', metadata: { request_id: 'wfr_01a009', turn_exchange_id: 'batch', working_turn_id: 'work' } };
      const first = request('batch-first', 'read', { parent: root.id });
      const second = request('batch-second', 'read', { parent: first.id });
      const firstResult = answer('batch-result-first', second.id, 'read');
      const secondResult = answer('batch-result-second', firstResult.id, 'read');
      firstResult.author.name = secondResult.author.name = 'api_tool.call_tool';
      const result: Message = { id: 'code-result', author: { role: 'tool', name: 'functions.exec' },
        recipient: 'all', status: 'finished_successfully', metadata: { parent_id: secondResult.id } };
      for (const message of [first, second, firstResult, secondResult, result]) {
        message.metadata = { ...message.metadata, request_id: 'wfr_01a009', turn_exchange_id: 'batch', working_turn_id: 'work' };
      }
      if (mode === 'wrong-request') result.metadata!.request_id = 'another-request';
      if (mode === 'missing-parent') result.metadata!.parent_id = 'unseen-parent';
      if (mode === 'wrong-tool') result.author.name = 'some_other.exec';
      const following = request('ordinary-after-code', 'read', { parent: result.id });
      const messages = [root, first, second, firstResult, secondResult,
        ...(mode === 'pending' ? [] : [result]), ...(mode === 'duplicate-result' ? [result] : []),
        ...(mode === 'complete' ? [following] : [])];
      const { turns } = await scan([], [{ id: 'native-code-batch', messages }]);
      expect(turns[0]!.calls.map(call => call.answered)).toEqual(mode === 'complete' ? [true, true, false] : [false, false]);
      expect(turns[0]!.codeModeCalls).toEqual([{ messageId: root.id, requestId: 'wfr_01a009', answered: mode === 'complete' }]);
    });

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

  it('reads the mounted conversation object identity used by helper answers', async () => {
    const { turns } = await scan([], [{
      id: 'helper-final', messages: [authored('helper-message', 'Complete.')],
      rendered: ['Complete.'], conversationProps: { conversation: { id: THREAD } }
    }]);
    expect(turns[0]).toMatchObject({ conversationId: THREAD, conversationConflict: false });
  });

  it('reads the durable server identity instead of the mounted WEB identity', async () => {
    const conversation = { id: 'WEB:11111111-2222-4333-8444-555555555555', serverId$: () => THREAD };
    const { turns } = await scan([], [{
      id: 'server-bound-user', messages: [{ ...authored('native-user', 'Keep `literal` text.'), author: { role: 'user' } }],
      conversationProps: { conversation }
    }]);
    expect(turns[0]).toMatchObject({ conversationId: THREAD, conversationConflict: false });
    expect(turns[0]!.messages[0]).toMatchObject({ role: 'user', rawText: 'Keep `literal` text.' });
    expect(JSON.stringify(turns)).not.toContain('WEB:');
  });

  it.each([undefined, () => null, () => { throw new Error('unresolved'); }])('does not promote a local WEB identity when the durable signal is unavailable (%s)', async (serverId$) => {
    const { turns } = await scan([], [{
      id: 'unresolved-server-owner', messages: [authored('native-answer', 'Answer.')],
      conversationProps: { conversation: { id: 'WEB:11111111-2222-4333-8444-555555555555', serverId$ } }
    }]);
    expect(turns[0]).toMatchObject({ conversationId: null, conversationConflict: false });
  });

  it('keeps a contradictory durable server identity conflicted', async () => {
    const { turns } = await scan([], [{
      id: 'conflicting-server-owner', messages: [authored('native-answer', 'Answer.')],
      conversationProps: { conversationId: THREAD,
        conversation: { id: 'WEB:11111111-2222-4333-8444-555555555555', serverId$: () => '22222222-3333-4444-8555-666666666666' } }
    }]);
    expect(turns[0]).toMatchObject({ conversationId: null, conversationConflict: true });
  });

  it.each([{ clientThreadId: THREAD }, { conversation: { id: THREAD } }])('distinguishes contradictory conversation metadata from missing conversation metadata: %j', async (identity) => {
    const other = '11111111-2222-3333-4444-555555555555';
    const messages = [authored('assistant-conflicted-chat', 'Stale mounted answer.')];
    const { turns } = await scan([], [{
      id: 'turn-conflicted-chat',
      messages,
      rendered: ['Stale mounted answer.'],
      conversationProps: { ...identity, conversationId: other }
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

  it('keeps public preambles complete when ChatGPT visually hides them during streaming and reload', async () => {
    const branch = { workingTurnId: 'preamble-working', turnExchangeId: 'preamble-exchange', channel: 'commentary' };
    const first = authored('preamble-first', 'The verification is', { ...branch, createTime: 1_787_165_000 });
    first.metadata!.is_thinking_preamble_message = true;
    const before = await scan([], [{ id: 'preamble-response', messages: [first] }]);

    // Live page shape: this flag flips before the public paragraph is complete,
    // and later public preambles carry it from their first observation.
    first.metadata!.is_visually_hidden_from_conversation = true;
    first.content!.parts = ['The verification is still running.'];
    const later = authored('preamble-later', 'Verification passed.', { ...branch, createTime: 1_787_165_010 });
    later.metadata = { ...later.metadata, is_thinking_preamble_message: true, is_visually_hidden_from_conversation: true };
    const final = authored('preamble-final', 'Ready.', { status: 'finished_successfully', endTurn: true, channel: 'final' });
    const messages = [first, request('preamble-tool', 'read'), later, final];
    const after = await scan([], [{ id: 'preamble-response', messages }]);
    const reloaded = await scan([], [{ id: 'preamble-response', messages }]);

    expect(after.turns[0]!.messages.map(message => message.rawText)).toEqual([
      'The verification is still running.', 'Verification passed.', 'Ready.'
    ]);
    expect(after.turns[0]!.messages.map(message => message.order)).toEqual([0, 2, 3]);
    expect(after.turns[0]!.messages[0]!.messageId).toBe(before.turns[0]!.messages[0]!.messageId);
    expect(after.turns[0]!.endMessageId).toBe(final.id);
    expect(reloaded.turns[0]!.messages).toEqual(after.turns[0]!.messages);
  });

  it.each(['missing-marker', 'false-marker', 'analysis', 'final', 'tool-role', 'tool-recipient', 'thoughts', 'other-hidden'])
    ('does not expose other hidden messages as public preambles (%s)', async mode => {
      const message = authored('excluded-preamble', 'Must stay excluded.', { channel: 'commentary' });
      message.metadata = { ...message.metadata, is_thinking_preamble_message: true, is_visually_hidden_from_conversation: true };
      if (mode === 'missing-marker') delete message.metadata.is_thinking_preamble_message;
      if (mode === 'false-marker') message.metadata.is_thinking_preamble_message = false;
      if (mode === 'analysis' || mode === 'final') message.channel = mode;
      if (mode === 'tool-role') message.author.role = 'tool';
      if (mode === 'tool-recipient') message.recipient = 'functions.exec';
      if (mode === 'thoughts') message.content!.content_type = 'thoughts';
      if (mode === 'other-hidden') message.metadata.is_visually_hidden = true;
      const { turns } = await scan([], [{ id: 'excluded-response', messages: [message] }]);
      expect(turns.flatMap(turn => turn.messages)).toEqual([]);
    });

  it.each(['native', 'scoped', 'foreign', 'unknown', 'text-only', 'duplicate'])('stamps only exact current native message anchors (%s)', async mode => {
    const message = authored('anchor-message', 'Public prose');
    const block = { html: 'Public prose', staleMessageStamp: 'old-scan:0:old-message',
      ...(mode === 'native' || mode === 'duplicate' ? { nativeId: message.id } : {}),
      ...(mode === 'scoped' || mode === 'foreign' || mode === 'unknown' ? { fiberProps: {
        messageId: mode === 'unknown' ? 'not-in-this-turn' : message.id,
        conversation: { id: mode === 'foreign' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : THREAD }
      } } : {}) };
    const result = await scan([], [{ id: 'anchor-turn', messages: [message], conversationProps: { conversationId: THREAD },
      rendered: mode === 'duplicate' ? [block, block] : [block] }]);
    const expected = mode === 'native' || mode === 'scoped' ? `${result.scanToken}:0:anchor-message` : null;
    expect(result.messageStamps).toEqual(mode === 'duplicate' ? [null, null] : [expected]);
    expect(result.turns[0]!.messages[0]!.rawText).toBe('Public prose');
  });

  it.each(['exact', 'missing-scope', 'foreign', 'conflicting-scope', 'unknown', 'wrong-type', 'wrong-prefix', 'conflicting-id', 'private', 'tool', 'duplicate'])('joins typed preambles at native Fiber depths (%s)', async mode => {
    const a = authored('public-a', 'Same public prose');
    const b = authored('public-b', 'Same public prose');
    const final = authored('public-final', 'Final');
    const privateMessage = { ...authored('private', 'Hidden'), channel: 'analysis' };
    const tool = request('tool', 'read');
    const messages = [a, tool, privateMessage, b, final];
    const branch = (id: string, conversationDepth: number) => {
      let fiber: Fiber | null = null;
      const key = mode === 'unknown' ? 'unknown' : mode === 'private' ? 'private' : mode === 'tool' ? 'tool' : id;
      for (let depth = 57; depth >= 0; depth--) {
        let props: Record<string, unknown> = {};
        if (depth === 57) props = { turn: { messages } };
        if (depth === conversationDepth && mode !== 'missing-scope') props = { conversation: { id: mode === 'foreign' ? 'other-chat' : THREAD } };
        if (depth === 40 && mode === 'conflicting-scope') props = { conversationId: 'other-chat' };
        if (depth === 11 || depth === 25) props = { item: { type: mode === 'wrong-type' ? 'thought' : 'preamble', key: `${mode === 'wrong-prefix' ? 'other-' : 'preamble-'}${key}` } };
        if (depth === 4) props = { messageId: undefined, conversation: undefined, ...(mode === 'conflicting-id' ? { message: final } : {}) };
        fiber = { memoizedProps: props, return: fiber };
      }
      return fiber!;
    };
    const blocks = [{ html: 'Same public prose', fiber: branch(a.id, 26) }, { html: 'Same public prose', fiber: branch(b.id, 35) }, { html: 'Final', nativeId: final.id }];
    if (mode === 'duplicate') blocks.splice(1, 0, blocks[0]!);
    const result = await scan([], [{ id: 'preamble-turn', messages, rendered: blocks }]);
    const stamp = (id: string) => `${result.scanToken}:0:${id}`;
    expect(result.messageStamps).toEqual(mode === 'exact' ? [stamp(a.id), stamp(b.id), stamp(final.id)]
      : mode === 'duplicate' ? [null, null, stamp(b.id), stamp(final.id)] : [null, null, stamp(final.id)]);
  });

  it.each(['exact', 'empty-label', 'duplicate', 'conflicting-label', 'wrong-type', 'unknown-owner'].flatMap(mode =>
    [false, true].map(v5 => ({ mode, v5 }))))('stamps only exact typed thought notifications and retains duplicate DOM copies ($mode, v5=$v5)', async ({ mode, v5 }) => {
    const owner = '11111111-2222-4333-8444-555555555555';
    const key = `thought-${mode === 'unknown-owner' ? 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' : owner}-7`;
    const fiber = chain({ item: { type: mode === 'wrong-type' ? 'preamble' : 'thought', key } });
    const activities = [
      { label: mode === 'empty-label' ? '' : '任意の実行通知', fiber, v5, staleThoughtStamp: 'old-scan:0:stale' },
      ...(['duplicate', 'conflicting-label'].includes(mode)
        ? [{ label: mode === 'conflicting-label' ? '別の表示' : '任意の実行通知', fiber, v5 }]
        : [])
    ];
    const result = await scan([], [{ id: 'typed-thought-turn', messages: [thought(owner)], activities }], true);
    const accepted = ['exact', 'empty-label', 'duplicate', 'conflicting-label'].includes(mode);
    expect(result.turns[0]?.thoughtNotifications).toEqual(accepted
      ? [{ messageId: `thought-${owner}-7`, kind: 'thought_notification' }]
      : undefined);
    expect(result.turns[0]?.activities ?? []).toEqual(mode === 'exact' || mode === 'duplicate'
      ? [{ messageId: `thought-${owner}-7`, label: '任意の実行通知', order: 0 }]
      : []);
    expect(result.thoughtStamps).toEqual(accepted
      ? activities.map(() => `${result.scanToken}:0:${encodeURIComponent(`thought-${owner}-7`)}`)
      : activities.map(() => null));
    expect(result.repeatedStampMutations).toBe(0);
  });

  it.each(['visible', 'overflow', 'zero', 'nonfinite', 'throw', 'offscreen'])('bounds viewport selection and reserves latest terminal/user boundary (%s)', async mode => {
    const fixtures: TurnFixture[] = Array.from({ length: 10 }, (_, at) => ({ id: `turn-${at}`, messages: [authored(`message-${at}`, `Prose ${at}`)], staleStamp: 'stale:0' }));
    fixtures[8]!.messages[0]!.end_turn = true;
    fixtures[8]!.messages[0]!.status = 'finished_successfully';
    fixtures[9]!.messages[0]!.author.role = 'user';
    const visible = { top: 10, bottom: 100, left: 0, right: 300 };
    for (let at = 0; at < (mode === 'overflow' ? 8 : 4); at++) fixtures[at]!.rect = mode === 'throw' ? 'throw'
      : mode === 'zero' ? { ...visible, bottom: 10 } : mode === 'nonfinite' ? { ...visible, top: NaN }
      : mode === 'offscreen' ? { ...visible, bottom: -10, top: -100 } : visible;
    const result = await scan([], fixtures);
    const selected = mode === 'visible' ? [0, 1, 2, 3, 8, 9] : [4, 5, 6, 7, 8, 9];
    expect(result.turns.map(turn => turn.turnId)).toEqual(selected.map(at => `turn-${at}`));
    expect(result.turns.find(turn => turn.turnId === 'turn-8')!.endMessageId).toBe('message-8');
    expect(result.turnStamps).toEqual(fixtures.map((_, at) => selected.includes(at) ? `${result.scanToken}:${selected.indexOf(at)}` : null));
  });

  it('counts split visible groups once, preserves latest text budget and stable stamps', async () => {
    const visible = { top: 10, bottom: 100, left: 0, right: 300 };
    const long = 'Public text '.repeat(30_000);
    const fixtures: TurnFixture[] = Array.from({ length: 8 }, (_, at) => ({ id: `budget-${at}`,
      messages: [authored(`large-${at}`, long)], rendered: [{ html: 'Public text', nativeId: `large-${at}` }],
      ...(at < 4 ? { rect: visible } : {}) }));
    fixtures.splice(1, 0, { ...fixtures[0]!, rendered: [] });
    const result = await scan([], fixtures, true);
    expect(result.turns.map(turn => turn.turnId)).toEqual([0, 1, 2, 3, 6, 7].map(at => `budget-${at}`));
    expect(result.turnStamps[0]).toBe(result.turnStamps[1]);
    expect(result.turns[5]!.messages[0]!.rawText.length).toBeGreaterThan(200_000);
    expect(result.turns.reduce((sum, turn) => sum + turn.messages.reduce((n, m) => n + m.rawText.length + m.renderedHtml.length, 0), 0)).toBeLessThanOrEqual(6 * 512 * 1024);
    expect(result.repeatedStampMutations).toBe(0);
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

  it('preserves distinct authored segments even when raw, working and exchange UUIDs all repeat', async () => {
    const id = 'b7d6231f-1174-42f0-8ee0-e828d132020c';
    const times = [1788644947400, 1788644965847, 1788645029019, 1788645099694];
    const ids: string[] = [];
    for (const [index, time] of times.entries()) {
      const result = await scan([], [{ id: `segment-${index}`, messages: [authored(id, `Distinct segment ${index}`, {
        workingTurnId: id, turnExchangeId: id, createTime: time
      })] }]);
      ids.push(result.turns[0]!.messages[0]!.messageId);
    }
    expect(new Set(ids).size).toBe(4);
    expect(ids).toEqual(times.map(time => `assistant:${id}:${id}:${time}`));
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

  it.each(['', 'Inspect this image.'])('captures native image metadata without inventing user prose (%s)', async text => {
    const message: Message = { id: 'native-image-user', author: { role: 'user' }, recipient: 'all',
      content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'must-not-cross-worlds' }, text] },
      metadata: { attachments: [{ id: 'native-file-id', name: 'example.avif', size: 123, mime_type: 'image/avif',
        library_file_id: 'private-library-id', source: 'private-source' }] } };
    const { turns } = await scan([], [{ id: 'image-turn', messages: [message] }]);
    expect(turns[0]!.messages).toEqual([expect.objectContaining({ messageId: message.id, rawText: text,
      attachments: [{ id: 'native-file-id', name: 'example.avif', size: 123, mimeType: 'image/avif' }] })]);
    expect(JSON.stringify(turns)).not.toMatch(/must-not-cross-worlds|private-library-id|private-source/);
    const assistant = await scan([], [{ id: 'not-user', messages: [{ ...message, author: { role: 'assistant' } }] }]);
    expect(assistant.turns).toEqual([]);
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

  it('retains an image-only terminal turn without requiring public text', async () => {
    const image = authored('image-final', '', { status: 'finished_successfully', endTurn: true, channel: 'final' });
    image.content = { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'image-test' }] };
    const { turns } = await scan([], [{ id: 'turn-image', messages: [image] }]);
    expect(turns[0]?.endMessageId).toBe('image-final');
    expect(turns[0]?.messages).toEqual([expect.objectContaining({ rawMessageId: 'image-final', rawText: '', role: 'assistant' })]);
  });

  it('owns multiple generated images by exact provider message and sediment asset identity', async () => {
    const generated: Message = {
      id: '3150f756-bf2d-45fa-ac0f-45010b2239fb',
      author: { role: 'tool' },
      recipient: 'all',
      channel: 'final',
      create_time: 1789552000.25,
      status: 'finished_successfully',
      end_turn: false,
      content: {
        content_type: 'multimodal_text',
        parts: [
          { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_00000000000000000000000000000001', width: 1254, height: 1254 },
          { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_00000000000000000000000000000002', width: 1024, height: 768 }
        ]
      }
    };
    const result = await scan([], [{
      id: generated.id,
      messages: [generated],
      images: [
        { assetId: 'file_00000000000000000000000000000001', clones: 6 },
        { assetId: 'file_00000000000000000000000000000002', clones: 3 }
      ]
    }]);

    expect(result.turns[0]?.messages).toEqual([]);
    expect(result.turns[0]?.endMessageId ?? null).toBeNull();
    expect(result.turns[0]?.images).toEqual([
      expect.objectContaining({ messageId: generated.id, assetId: 'file_00000000000000000000000000000001', providerRole: 'tool', providerStatus: 'finished_successfully', order: 0, partOrder: 0, width: 1254, height: 1254 }),
      expect.objectContaining({ messageId: generated.id, assetId: 'file_00000000000000000000000000000002', providerRole: 'tool', providerStatus: 'finished_successfully', order: 0, partOrder: 1, width: 1024, height: 768 })
    ]);
    expect(result.imageStamps).toHaveLength(9);
    expect(result.imageStamps.every(stamp => stamp?.startsWith(`${result.scanToken}:0:`))).toBe(true);
    expect(result.imageStamps[0]).toContain(encodeURIComponent('file_00000000000000000000000000000001'));
    expect(result.imageStamps[6]).toContain(encodeURIComponent('file_00000000000000000000000000000002'));
  });

  it('keeps generated-image metadata but refuses an ambiguous pixel node and private messages', async () => {
    const visible: Message = {
      id: '4150f756-bf2d-45fa-ac0f-45010b2239fb', author: { role: 'tool' }, recipient: 'all', channel: 'final',
      content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_00000000000000000000000000000003' }] }
    };
    const conflicting = { ...visible, id: '7150f756-bf2d-45fa-ac0f-45010b2239fb' };
    const hidden = { ...visible, id: '5150f756-bf2d-45fa-ac0f-45010b2239fb', metadata: { is_visually_hidden_from_conversation: true } };
    const analysis = { ...visible, id: '6150f756-bf2d-45fa-ac0f-45010b2239fb', author: { role: 'assistant' }, channel: 'analysis' };
    const result = await scan([], [{ id: visible.id, messages: [visible, conflicting, hidden, analysis], images: [
      { assetId: 'file_00000000000000000000000000000003', clones: 2 }
    ] }]);

    expect(result.turns[0]?.images).toHaveLength(2);
    expect(result.turns[0]?.images?.map(image => image.messageId)).toEqual([visible.id, conflicting.id]);
    expect(result.imageStamps).toEqual([null, null]);
  });

  it('does not reuse an old text completion while a newer image answer is still running', async () => {
    const image = authored('image-running', '', { status: 'in_progress', endTurn: false, channel: 'final' });
    image.content = { content_type: 'multimodal_text', parts: [] };
    const { turns } = await scan([], [{ id: 'turn-image-retry', messages: [authored('old-answer', 'Old', { status: 'finished_successfully', endTurn: true }), image] }]);
    expect(turns[0]?.endMessageId ?? null).toBeNull();
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
