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
type Stage = [StageState, string?];

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
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
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
  $('connectionAdvancedAge').textContent = host?.ready
    ? diagnostics
      ? t('Internal Chromium · companion {0} ago', [ageToken(diagnostics.capturedAt)])
      : t('Internal Chromium · companion pending')
    : diagnostics
      ? t('Companion · updated {0} ago', [ageToken(diagnostics.capturedAt)])
      : t('No runtime diagnostics yet');
}

function captureRow(id: string, state: CaptureState, meta: string, copyValue: string | null = null): void {
  const row = $(id);
  row.className = `connection-advanced-row is-${state}`;
  const value = row.querySelector<HTMLElement>('.meta')!;
  ui(value, 'textContent', () => t(meta));
  ui(row, 'title', () => copyValue ?? t(meta));
  const copy = row.querySelector<HTMLButtonElement>('button.copy');
  if (copy) {
    copy.disabled = !copyValue;
    copy.dataset.copyValue = copyValue ?? '';
  }
}

function stage(id: string, value: Stage): void {
  const row = $(id);
  row.className = `connection-pipeline-stage is-${value[0]}`;
  row.querySelector('em')!.textContent = value[1] ?? '';
}

function pipeline(diagnostics: CompanionDiagnostics): {
  read: Stage;
  sent: Stage;
  owner: Stage;
  why: string;
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
    return { read: ['failed'], sent: ['off'], owner: ['off'], why: t('No recorder in this tab. Reload the page.'), bad: true };
  }
  if (read === 0) {
    return { read: ['running'], sent: ['off'], owner: ['off'], why: t('Waiting for the first message.'), bad: false };
  }

  const readStage: Stage = calls.length ? ['done', String(calls.length)] : ['running'];
  if (!ready) {
    return {
      read: readStage,
      sent: ['failed', pending ? `${pending} held` : ''],
      owner: ['off'],
      why: t('Delivery is blocked until the app is connected and protocol compatibility is confirmed.'),
      bad: true
    };
  }
  if (sent?.ok === false) {
    return {
      read: readStage,
      sent: ['failed', sent.error || 'failed'],
      owner: ['off'],
      why: t('The app rejected the last delivery ({0}).', [sent.error || t('failed')]),
      bad: true
    };
  }
  if (page.blocked) {
    return {
      read: readStage,
      sent: ['failed', page.queued ? `${page.queued} held in page` : page.blocked],
      owner: ['off'],
      why: t('The extension is not accepting this tab’s observations ({0}). Reload the ChatGPT tab.', [page.blocked]),
      bad: true
    };
  }
  if (pending > 0) {
    return {
      read: readStage,
      sent: ['running', `${pending} queued`],
      owner: ['off'],
      why: t('Queued here. Retrying delivery to the app.'),
      bad: false
    };
  }
  if (!page.session) {
    return {
      read: readStage,
      sent: ['running'],
      owner: ['running'],
      why: t('App reachable. Waiting for this chat’s session receipt.'),
      bad: false
    };
  }
  if (!calls.length) {
    return {
      read: ['running'],
      sent: ['off'],
      owner: ['off'],
      why: t('Chat recorded. Waiting for a request ID from the latest turn.'),
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
      why: t('{0} calls could not be assigned by request ID ({1}).', [missed.length, t(ATTRIBUTION[missed[0]!.app!] || missed[0]!.app!)]),
      bad: true
    };
  }
  return {
    read: ['done', String(calls.length)],
    sent: sentStage,
    owner: [confirmed === calls.length ? 'done' : 'running', `${confirmed}/${calls.length}`],
    why: placed > 0
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
      tool.textContent = entry.tool || 'request ID';
      const request = document.createElement('code');
      request.textContent = shorten(entry.requestId, 5);
      row.title = `${entry.requestId} — found ${entry.read ? 'yes' : 'no'} · app receipt ${entry.sent || entry.app === 'request_id' ? 'confirmed' : 'pending'} · owner ${entry.confirmed ? 'confirmed' : 'pending'} · tool activity ${entry.app ? ATTRIBUTION[entry.app] || entry.app : 'no record'}`;
      row.append(pips, tool, request);
      return row;
    })
  );
}

function detail(list: HTMLElement, term: string, value: string | number | null, bad = false): void {
  const dt = document.createElement('dt');
  ui(dt, 'textContent', () => t(term));
  const dd = document.createElement('dd');
  dd.textContent = value === null || value === '' ? '—' : String(value);
  dd.title = dd.textContent;
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
  const alert = incompatible
    ? `App v${status?.appVersion || '?'} (protocol ${status?.appProtocol ?? '?'}); companion v${status?.extensionVersion || '?'} (protocol ${status?.extensionProtocol ?? '?'}).`
    : status?.pairError?.message || status?.pairError?.error || recentPageError || '';
  const alertNode = $('connectionAdvancedAlert');
  alertNode.textContent = alert;
  alertNode.hidden = !alert;

  captureRow(
    'connectionAdvancedTab',
    isChat ? 'ok' : 'off',
    !isChat ? 'none open' : hostTab ? `#${hostTab.id} · ${hostTab.status}` : ''
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
          why: internal
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
  $('connectionPipelineWhy').textContent = flow.why;
  $('connectionPipelineWhy').className = flow.bad ? 'is-bad' : '';
  paintCalls(page?.trace ?? []);

  const grid = $('connectionAdvancedGrid');
  grid.replaceChildren();
  detail(grid, 'browser host', internal ? 'Internal Chromium · ready' : 'companion browser');
  detail(grid, 'active tab', hostTab ? `#${hostTab.id} · ${hostTab.status}` : info?.tab ?? null);
  detail(grid, 'browser tabs', host ? `${host.tabs.length} open · dock ${host.open ? 'shown' : 'hidden'}` : info ? `${info.chatTabs} ChatGPT` : null);
  detail(grid, 'app', status ? `v${status.appVersion || '?'} · port ${status.port || '—'}` : null);
  detail(grid, 'extension', status ? `v${status.extensionVersion || '?'} · protocol ${status.extensionProtocol ?? '—'}` : null, status?.compatible === false);
  detail(grid, 'chat id', chatId);
  detail(grid, 'app session', page?.session ?? null, Boolean(page && !page.session));
  detail(grid, 'companion tab', info ? `${info.tab ?? '—'} · epoch ${info.epoch ?? '—'}` : companionTab ? `${companionTab.tab ?? '—'} · syncing` : null);
  detail(grid, 'ownership', info ? (info.terminal ? 'retired' : info.bound ? 'bound' : 'unbound') : null, Boolean(info?.terminal));
  detail(grid, 'recorder', page ? `fiber v${page.recorderVersion ?? '—'} · run ${page.runId ?? '—'}` : internal && isChat ? 'waiting for companion' : 'not attached', Boolean(!internal && isChat && !page));
  detail(grid, 'turn', page ? (page.generating ? `${shorten(page.turnId, 8)} · live` : 'idle') : null);
  detail(grid, 'observed', page ? `${page.events} events · ${page.calls} calls` : null);
  detail(grid, 'in this browser', info ? `${info.pending} held · ${info.pendingAll} total` : null, Boolean(info?.pendingAll));
  detail(
    grid,
    'last delivery',
    sent?.at ? `${sent.ok ? 'ok' : sent.error || 'failed'} · ${sent.events} · ${ageToken(sent.at)} ago` : null,
    sent?.ok === false
  );
  detail(grid, 'delivered', sent ? sent.total : null);
  detail(grid, 'page sends', page ? `${page.sends} · ${page.failures} failed` : null, Boolean(page?.failures));
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
    $('connectionAdvancedAge').textContent = t('refreshing…');
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
        $('connectionAdvancedAge').textContent = !hostResponse.ok
          ? hostResponse.error
          : !diagnosticsResponse.ok
            ? diagnosticsResponse.error
            : t('No runtime diagnostics yet');
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
