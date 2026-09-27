import type { CompanionDiagnostics, CompanionTraceEntry } from '../shared/types.js';
import { $, toast } from './dom.js';
import { t, ui } from './i18n.js';

interface InternalBrowserTabState {
  id: number;
  active: boolean;
  status: 'loading' | 'complete';
  title: string;
  url: string;
}

interface InternalBrowserDockState {
  open: boolean;
  ready: boolean;
  tabId: number | null;
  tabs: InternalBrowserTabState[];
}

type InternalBrowserReply =
  | { ok: true; data: InternalBrowserDockState | null }
  | { ok: false; error: string };

function queryInternalBrowser(): Promise<InternalBrowserReply> {
  const optional = window.api as typeof window.api & {
    internalBrowser?: (request: { action: 'query' }) => Promise<InternalBrowserReply>;
  };
  return typeof optional.internalBrowser === 'function'
    ? optional.internalBrowser({ action: 'query' })
    : Promise.resolve({ ok: true, data: null });
}

type CaptureState = 'ok' | 'bad' | 'wait' | 'off';
type StageState = 'done' | 'failed' | 'running' | 'off';
type TextValue = string | (() => string);
type Stage = [StageState, TextValue?];

const ATTRIBUTION: Record<string, string> = {
  request_id: 'exact request id',
  unattributed: 'request id not resolved',
  agent: 'agent key',
  turn: 'tool block on the page',
  generation: 'the only chat generating',
  inferred: 'not placed in a chat'
};

function shorten(value: string | null, keep = 6): string {
  const text = value ?? '';
  if (text.length <= keep + 5) return text;
  return `${text.slice(0, keep)}…${text.slice(-4)}`;
}

function ageToken(at: number): string {
  if (!at) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return t('{0}s', [seconds]);
  if (seconds < 3600) return t('{0}m', [Math.round(seconds / 60)]);
  return t('{0}h', [Math.round(seconds / 3600)]);
}

function isChatGptUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://chatgpt.com' || url.origin === 'https://chat.openai.com';
  } catch { return false; }
}

function conversationFromUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const match = /^\/c\/([^/?#]+)/.exec(new URL(value).pathname);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch { return null; }
}

function activeInternalTab(host: InternalBrowserDockState | null): InternalBrowserTabState | null {
  if (!host) return null;
  return host.tabs.find((tab) => tab.id === host.tabId) ?? host.tabs.find((tab) => tab.active) ?? null;
}

function paintDiagnosticAge(host: InternalBrowserDockState | null, diagnostics: CompanionDiagnostics | null): void {
  ui($('connectionAdvancedAge'), 'textContent', () => host?.ready
    ? diagnostics
      ? t('Internal Chromium · companion {0} ago', [ageToken(diagnostics.capturedAt)])
      : t('Internal Chromium · companion pending')
    : diagnostics
      ? t('Companion · updated {0} ago', [ageToken(diagnostics.capturedAt)])
      : t('No runtime diagnostics yet'));
}

function captureRow(id: string, state: CaptureState, meta: TextValue, copyValue: string | null = null): void {
  const row = $(id);
  row.className = `connection-advanced-row is-${state}`;
  const value = row.querySelector<HTMLElement>('.meta')!;
  const readMeta = () => typeof meta === 'function' ? meta() : t(meta);
  ui(value, 'textContent', readMeta);
  ui(row, 'title', () => copyValue ?? readMeta());
  const copy = row.querySelector<HTMLButtonElement>('button.copy');
  if (copy) {
    copy.disabled = !copyValue;
    copy.dataset.copyValue = copyValue ?? '';
  }
}

function stage(id: string, value: Stage): void {
  const row = $(id);
  row.className = `connection-pipeline-stage is-${value[0]}`;
  ui(row.querySelector('em')!, 'textContent', () => {
    const meta = value[1];
    return meta === undefined ? '' : typeof meta === 'function' ? meta() : meta;
  });
}

function pipeline(diagnostics: CompanionDiagnostics): {
  read: Stage;
  sent: Stage;
  owner: Stage;
  why: TextValue;
  bad: boolean;
} {
  const info = diagnostics.tab;
  const page = info?.page;
  const sent = info?.delivery;
  const pending = info?.pending ?? 0;
  const read = page?.events ?? 0;
  const calls = page?.trace ?? [];
  const ready = diagnostics.status.connected && diagnostics.status.paired && diagnostics.status.compatible === true;

  if (!info?.isChat) return { read: ['off'], sent: ['off'], owner: ['off'], why: '', bad: false };
  if (!info.recorder || !page) {
    return { read: ['failed'], sent: ['off'], owner: ['off'], why: () => t('No recorder in this tab. Reload the page.'), bad: true };
  }
  if (read === 0) {
    return { read: ['running'], sent: ['off'], owner: ['off'], why: () => t('Waiting for the first message.'), bad: false };
  }

  const readStage: Stage = calls.length ? ['done', String(calls.length)] : ['running'];
  if (!ready) {
    return {
      read: readStage,
      sent: ['failed', pending ? () => t('{0} held', [pending]) : ''],
      owner: ['off'],
      why: () => t('Delivery is blocked until the app is connected and protocol compatibility is confirmed.'),
      bad: true
    };
  }
  if (sent?.ok === false) {
    return {
      read: readStage,
      sent: ['failed', sent.error || (() => t('failed'))],
      owner: ['off'],
      why: () => t('The app rejected the last delivery ({0}).', [sent.error || t('failed')]),
      bad: true
    };
  }
  if (page.blocked) {
    return {
      read: readStage,
      sent: ['failed', page.queued ? () => t('{0} held in page', [page.queued]) : page.blocked],
      owner: ['off'],
      why: () => t('The extension is not accepting this tab’s observations ({0}). Reload the ChatGPT tab.', [page.blocked]),
      bad: true
    };
  }
  if (pending > 0) {
    return {
      read: readStage,
      sent: ['running', () => t('{0} queued', [pending])],
      owner: ['off'],
      why: () => t('Queued here. Retrying delivery to the app.'),
      bad: false
    };
  }
  if (!page.session) {
    return {
      read: readStage,
      sent: ['running'],
      owner: ['running'],
      why: () => t('App reachable. Waiting for this chat’s session receipt.'),
      bad: false
    };
  }
  if (!calls.length) {
    return {
      read: ['running'],
      sent: ['off'],
      owner: ['off'],
      why: () => t('Chat recorded. Waiting for a request ID from the latest turn.'),
      bad: false
    };
  }

  const received = calls.filter((call) => call.sent || call.app === 'request_id').length;
  const confirmed = calls.filter((call) => call.confirmed || call.app === 'request_id').length;
  const sentStage: Stage = [received === calls.length ? 'done' : 'running', `${received}/${calls.length}`];
  const placed = calls.filter((call) => call.app === 'request_id').length;
  const missed = calls.filter((call) => call.app && call.app !== 'request_id');
  if (missed.length > 0) {
    return {
      read: readStage,
      sent: sentStage,
      owner: ['failed', `${placed}/${calls.length}`],
      why: () => t('{0} calls could not be assigned by request ID ({1}).', [missed.length, t(ATTRIBUTION[missed[0]!.app!] || missed[0]!.app!)]),
      bad: true
    };
  }
  return {
    read: ['done', String(calls.length)],
    sent: sentStage,
    owner: [confirmed === calls.length ? 'done' : 'running', `${confirmed}/${calls.length}`],
    why: () => placed > 0
      ? t('{0} request IDs matched to recorded tool activity.', [placed])
      : confirmed > 0
        ? t('Request owner confirmed. No matching tool activity recorded yet.')
        : received > 0
          ? t('App received the ID. Waiting for owner confirmation.')
          : t('ID found in the latest turn. Waiting for the app to confirm receipt.'),
    bad: false
  };
}

function paintCalls(calls: CompanionTraceEntry[]): void {
  const box = $('connectionPipelineCalls');
  box.replaceChildren(
    ...calls.slice(0, 5).map((entry) => {
      const row = document.createElement('div');
      row.className = 'connection-pipeline-call';
      const pips = document.createElement('span');
      pips.className = 'connection-pipeline-pips';
      for (const state of [
        entry.read ? 'is-on' : '',
        entry.sent || entry.app === 'request_id' ? 'is-on' : '',
        entry.confirmed || entry.app === 'request_id' ? 'is-on' : entry.app ? 'is-bad' : ''
      ]) {
        const pip = document.createElement('i');
        pip.className = state;
        pips.append(pip);
      }
      const tool = document.createElement('span');
      if (entry.tool) tool.textContent = entry.tool;
      else ui(tool, 'textContent', () => t('request ID'));
      const request = document.createElement('code');
      request.textContent = shorten(entry.requestId, 5);
      ui(row, 'title', () => t('{0} — found {1} · app receipt {2} · owner {3} · tool activity {4}', [
        entry.requestId,
        t(entry.read ? 'yes' : 'no'),
        t(entry.sent || entry.app === 'request_id' ? 'confirmed' : 'pending'),
        t(entry.confirmed ? 'confirmed' : 'pending'),
        entry.app ? t(ATTRIBUTION[entry.app] || entry.app) : t('no record')
      ]));
      row.append(pips, tool, request);
      return row;
    })
  );
}

function detail(list: HTMLElement, term: string, value: string | number | null | (() => string | number | null), bad = false): void {
  const dt = document.createElement('dt');
  ui(dt, 'textContent', () => t(term));
  const dd = document.createElement('dd');
  const read = () => typeof value === 'function' ? value() : value;
  ui(dd, 'textContent', () => {
    const current = read();
    return current === null || current === '' ? '—' : String(current);
  });
  ui(dd, 'title', () => {
    const current = read();
    return current === null || current === '' ? '—' : String(current);
  });
  if (bad) dd.className = 'is-bad';
  list.append(dt, dd);
}

function paintDiagnostics(
  host: InternalBrowserDockState | null,
  diagnostics: CompanionDiagnostics | null
): void {
  const hostTab = activeInternalTab(host);
  const internal = host?.ready === true;
  const hostIsChat = isChatGptUrl(hostTab?.url);
  const companionTab = diagnostics?.tab ?? null;
  const companionMatchesHost = !hostTab || companionTab?.tab === hostTab.id;
  const info = companionMatchesHost ? companionTab : null;
  const page = info?.page;
  const sent = info?.delivery;
  const isChat = internal ? hostIsChat : info?.isChat === true;
  const chatId = info?.conversationId ?? conversationFromUrl(hostTab?.url);
  const requestId = page?.requestId ?? null;

  paintDiagnosticAge(host, diagnostics);

  const status = diagnostics?.status ?? null;
  const incompatible = Boolean(status?.connected && status.compatible === false);
  const recentPageError = page?.lastError && Date.now() - page.lastError.at < 10 * 60 * 1000 ? page.lastError.text : '';
  const alert = () => incompatible
    ? t('App v{0} (protocol {1}); companion v{2} (protocol {3}).', [status?.appVersion || '?', status?.appProtocol ?? '?', status?.extensionVersion || '?', status?.extensionProtocol ?? '?'])
    : status?.pairError?.message || status?.pairError?.error || recentPageError || '';
  const alertNode = $('connectionAdvancedAlert');
  ui(alertNode, 'textContent', alert);
  alertNode.hidden = !alert();

  captureRow(
    'connectionAdvancedTab',
    isChat ? 'ok' : 'off',
    () => !isChat ? t('none open') : hostTab ? `#${hostTab.id} · ${t(hostTab.status)}` : ''
  );
  captureRow(
    'connectionAdvancedRecording',
    !isChat ? 'off' : info?.recorder ? 'ok' : internal ? 'wait' : 'bad',
    !isChat
      ? ''
      : info?.recorder
        ? (page?.generating ? 'answering' : '')
        : internal
          ? companionTab && !companionMatchesHost ? 'syncing tab' : 'companion pending'
          : 'reload'
  );
  captureRow('connectionAdvancedChat', !isChat ? 'off' : chatId ? 'ok' : 'wait', !isChat ? '' : chatId ? shorten(chatId, 8) : 'new chat', chatId);
  captureRow('connectionAdvancedRequest', !isChat ? 'off' : requestId ? 'ok' : 'wait', !isChat ? '' : requestId ? shorten(requestId, 9) : 'none yet', requestId);

  const scopedDiagnostics = diagnostics && companionMatchesHost ? diagnostics : null;
  const flow = scopedDiagnostics
    ? pipeline(scopedDiagnostics)
    : isChat
      ? {
          read: ['running'] as Stage,
          sent: ['off'] as Stage,
          owner: ['off'] as Stage,
          why: () => internal
            ? t('Internal Chromium is live. Waiting for the companion recorder snapshot for this tab.')
            : t('Waiting for companion diagnostics.'),
          bad: false
        }
      : { read: ['off'] as Stage, sent: ['off'] as Stage, owner: ['off'] as Stage, why: '', bad: false };
  const flowing = Boolean(page?.trace.some((call) => call.app === 'request_id'));
  captureRow(
    'connectionAdvancedApp',
    !isChat ? 'off' : flow.bad ? 'bad' : flowing ? 'ok' : 'wait',
    !isChat ? '' : flow.bad ? 'blocked' : flowing ? 'tool matched' : flow.owner[0] === 'done' ? 'ID confirmed' : internal && !info ? 'companion pending' : 'waiting'
  );
  stage('connectionPipelineRead', flow.read);
  stage('connectionPipelineSent', flow.sent);
  stage('connectionPipelineOwner', flow.owner);
  ui($('connectionPipelineWhy'), 'textContent', () => typeof flow.why === 'function' ? flow.why() : flow.why);
  $('connectionPipelineWhy').className = flow.bad ? 'is-bad' : '';
  paintCalls(page?.trace ?? []);

  const grid = $('connectionAdvancedGrid');
  grid.replaceChildren();
  detail(grid, 'browser host', () => internal ? t('Internal Chromium · ready') : t('companion browser'));
  detail(grid, 'active tab', () => hostTab ? `#${hostTab.id} · ${t(hostTab.status)}` : info?.tab ?? null);
  detail(grid, 'browser tabs', () => host ? t('{0} open · dock {1}', [host.tabs.length, t(host.open ? 'shown' : 'hidden')]) : info ? t('{0} ChatGPT', [info.chatTabs]) : null);
  detail(grid, 'app', () => status ? t('v{0} · port {1}', [status.appVersion || '?', status.port || '—']) : null);
  detail(grid, 'extension', () => status ? t('v{0} · protocol {1}', [status.extensionVersion || '?', status.extensionProtocol ?? '—']) : null, status?.compatible === false);
  detail(grid, 'chat id', chatId);
  detail(grid, 'app session', page?.session ?? null, Boolean(page && !page.session));
  detail(grid, 'companion tab', () => info ? t('{0} · epoch {1}', [info.tab ?? '—', info.epoch ?? '—']) : companionTab ? t('{0} · syncing', [companionTab.tab ?? '—']) : null);
  detail(grid, 'ownership', () => info ? t(info.terminal ? 'retired' : info.bound ? 'bound' : 'unbound') : null, Boolean(info?.terminal));
  detail(grid, 'recorder', () => page ? t('fiber v{0} · run {1}', [page.recorderVersion ?? '—', page.runId ?? '—']) : internal && isChat ? t('waiting for companion') : t('not attached'), Boolean(!internal && isChat && !page));
  detail(grid, 'turn', () => page ? (page.generating ? t('{0} · live', [shorten(page.turnId, 8)]) : t('idle')) : null);
  detail(grid, 'observed', () => page ? t('{0} events · {1} calls', [page.events, page.calls]) : null);
  detail(grid, 'in this browser', () => info ? t('{0} held · {1} total', [info.pending, info.pendingAll]) : null, Boolean(info?.pendingAll));
  detail(
    grid,
    'last delivery',
    () => sent?.at ? t('{0} · {1} · {2} ago', [sent.ok ? t('ok') : sent.error || t('failed'), sent.events, ageToken(sent.at)]) : null,
    sent?.ok === false
  );
  detail(grid, 'delivered', sent ? sent.total : null);
  detail(grid, 'page sends', () => page ? t('{0} · {1} failed', [page.sends, page.failures]) : null, Boolean(page?.failures));
}

export interface ConnectionAdvancedController {
  refreshIfOpen(): void;
}

export function initConnectionAdvanced(): ConnectionAdvancedController {
  const details = $<HTMLDetailsElement>('connectionAdvanced');
  const refresh = $<HTMLButtonElement>('connectionAdvancedRefresh');
  const copy = $<HTMLButtonElement>('connectionAdvancedCopy');
  let current: CompanionDiagnostics | null = null;
  let host: InternalBrowserDockState | null = null;
  let busy = false;

  const paintControls = (): void => {
    refresh.disabled = busy;
  };

  const request = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    ui($('connectionAdvancedAge'), 'textContent', () => t('refreshing…'));
    paintControls();
    try {
      const [hostResponse, diagnosticsResponse] = await Promise.all([
        queryInternalBrowser(),
        window.api.companionDiagnostics()
      ]);
      host = hostResponse.ok ? hostResponse.data : null;
      current = diagnosticsResponse.ok ? diagnosticsResponse.data : null;
      if (!host && !current) {
        paintDiagnostics(null, null);
        if (!hostResponse.ok) $('connectionAdvancedAge').textContent = hostResponse.error;
        else if (!diagnosticsResponse.ok) $('connectionAdvancedAge').textContent = diagnosticsResponse.error;
        else ui($('connectionAdvancedAge'), 'textContent', () => t('No runtime diagnostics yet'));
        $('connectionAdvancedGrid').replaceChildren();
        return;
      }
      paintDiagnostics(host, current);
    } finally {
      busy = false;
      paintControls();
    }
  };

  for (const id of ['connectionAdvancedChat', 'connectionAdvancedRequest']) {
    const button = $(id).querySelector<HTMLButtonElement>('button.copy')!;
    button.addEventListener('click', () => {
      const value = button.dataset.copyValue;
      if (!value) return;
      void window.api.writeClipboard(value).then((response) => {
        if (response.ok && response.data) toast(t('Copied'));
      });
    });
  }
  refresh.addEventListener('click', () => void request());
  copy.addEventListener('click', () => {
    const lines = [$('connectionPipelineWhy').textContent ?? ''];
    const cells = [...$('connectionAdvancedGrid').children].map((node) => node.textContent ?? '');
    for (let index = 0; index < cells.length; index += 2) lines.push(`${cells[index]}: ${cells[index + 1]}`);
    void window.api.writeClipboard(lines.filter(Boolean).join('\n')).then((response) => {
      if (response.ok && response.data) toast(t('Diagnostics copied'));
    });
  });
  details.addEventListener('toggle', () => { if (details.open) void request(); });
  window.setInterval(() => {
    if (details.open && (host || current) && !busy) paintDiagnosticAge(host, current);
  }, 1000);
  paintControls();

  return {
    refreshIfOpen(): void {
      if (details.open) void request();
    }
  };
}
