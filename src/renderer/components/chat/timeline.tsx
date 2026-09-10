import { useEffect, useMemo, useState } from 'react';
import type { AssetRef, SessionEvent } from '../../../shared/session.js';
import { ATTRIBUTION_LABELS, TURN_OUTCOME_LABELS, foldProgress } from '../../../shared/session.js';
import { chronological } from '../../../shared/chronology.js';
import { api, unwrap } from '../../state/app-store.js';
import { communicationTitle, foldAgentCommunication } from '../../agent-communication.js';
import { toolResultText } from '../../tool-result.js';
import { Icon } from '../ui/icon.js';
import { Badge } from '../ui/card.js';
import { FileDiff } from './file-diff.js';
import { RenderedMessage } from './rendered-message.js';

const kindIcon = {
  edit: 'i-pencil', create: 'i-plus', delete: 'i-trash', move: 'i-out', read: 'i-eye', search: 'i-search',
  browse: 'i-folder', run: 'i-terminal', process: 'i-terminal', screen: 'i-monitor', input: 'i-monitor',
  clipboard: 'i-copy', session: 'i-steps', agent: 'i-bolt', other: 'i-bolt',
} as const;

function time(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function RecordedAsset({ sessionId, asset }: { sessionId: string; asset: AssetRef }) {
  const [source, setSource] = useState<string | null>(null);
  const image = asset.mimeType.startsWith('image/');
  useEffect(() => {
    if (!image) return;
    let current = true;
    void unwrap(api.getSessionImage(sessionId, asset.id)).then((next) => { if (current) setSource(next); }).catch(() => undefined);
    return () => { current = false; };
  }, [asset.id, image, sessionId]);
  if (image && source) return <img src={source} alt="Attached image" className="max-h-72 max-w-full rounded-lg border border-border object-contain" />;
  return <Badge>{image ? 'Image attachment' : `${asset.mimeType || 'File'} attachment`}</Badge>;
}

function EventRow({ event, developerMode, sessionId }: { event: SessionEvent; developerMode: boolean; sessionId: string | null }) {
  if (event.kind === 'session_start') return null;
  if (event.kind === 'user_message') {
    const text = event.authoredText ?? event.message.text;
    return (
      <article className="group ml-auto max-w-[min(760px,88%)] rounded-2xl bg-muted px-4 py-3 text-[14px] leading-6 text-foreground" data-event-kind="user_message">
        <RenderedMessage source={text} />
        {!!event.attachments?.length && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {event.attachments.map((file) => <Badge key={file.id}>{file.name}</Badge>)}
          </div>
        )}
        {sessionId && !!event.assets?.length && <div className="mt-2 flex flex-wrap gap-2">{event.assets.map((asset) => <RecordedAsset key={asset.id} sessionId={sessionId} asset={asset} />)}</div>}
      </article>
    );
  }
  if (event.kind === 'assistant_message') {
    return (
      <article className="max-w-[780px] py-2 text-[14px] leading-6 text-foreground" data-event-kind="assistant_message">
        <RenderedMessage source={event.message.text} rendered={event.renderedHtml} />
      </article>
    );
  }
  if (event.kind === 'progress') {
    return (
      <div className="flex max-w-[780px] items-start gap-2 py-1.5 text-[12px] leading-5 text-muted-foreground" data-event-kind="progress">
        <span className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
        <span dir="auto">{event.message.text}</span>
      </div>
    );
  }
  if (event.kind === 'page_tool') {
    return <div className="py-1 text-xs text-muted-foreground">{event.label}</div>;
  }
  if (event.kind === 'tool_call') {
    const call = event.call;
    const result = toolResultText(call.result.text, call.result.truncated, call.assets?.some((asset) => asset.mimeType.startsWith('image/')) === true);
    return (
      <details className="group max-w-[780px] rounded-lg border border-border bg-card" data-event-kind="tool_call" data-call-id={call.callId}>
        <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-3 text-[12px] text-muted-foreground marker:hidden hover:text-foreground">
          <Icon name={kindIcon[call.summary.kind]} className="size-3.5" />
          <span className="min-w-0 flex-1 truncate">{call.summary.title}</span>
          {call.summary.detail && <span className="hidden truncate text-muted-foreground/80 sm:inline">{call.summary.detail}</span>}
          {call.summary.metric && <span className={call.summary.tone === 'bad' ? 'text-destructive' : ''}>{call.summary.metric}</span>}
          <Icon name="i-chev" className="size-3 transition-transform group-open:rotate-90" />
        </summary>
        <div className="border-t border-border px-3 py-3 text-xs">
          <div className="mb-2 flex flex-wrap gap-2 text-muted-foreground">
            <span>{call.tool}</span><span>·</span><span>{call.durationMs} ms</span><span>·</span><span>{ATTRIBUTION_LABELS[call.attribution]}</span>
          </div>
          {!!call.changes?.length && <div className="mb-2"><FileDiff changes={call.changes} /></div>}
          <div className="grid gap-2 lg:grid-cols-2">
            <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2.5 whitespace-pre-wrap break-words">{call.args.text}</pre>
            <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2.5 whitespace-pre-wrap break-words">{result || 'Binary result retained in the recording.'}</pre>
          </div>
        </div>
      </details>
    );
  }
  if (event.kind === 'agent_message') {
    return (
      <div className="flex max-w-[780px] items-start gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs">
        <Icon name="i-bolt" className="mt-0.5 size-3.5" />
        <div className="min-w-0"><strong>{communicationTitle(event)}</strong><div className="mt-1 text-muted-foreground" dir="auto">{event.message.text}</div></div>
      </div>
    );
  }
  if (event.kind === 'chat_error') {
    return <div className="max-w-[780px] rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive">{event.message.text}</div>;
  }
  if (event.kind === 'handoff') {
    return <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground"><Icon name="i-copy" className="size-3.5" />Compact &amp; Resume handoff saved</div>;
  }
  if (event.kind === 'note') {
    return <div className="py-1 text-xs text-muted-foreground" dir="auto">{event.message.text}</div>;
  }
  if ((event.kind === 'turn_start' || event.kind === 'turn_end') && developerMode) {
    return (
      <div className="flex items-center gap-2 py-1 text-[11px] text-muted-foreground/75">
        <span>{time(event.time)}</span>
        <span>{event.kind === 'turn_start' ? 'Turn started' : `Turn ${TURN_OUTCOME_LABELS[event.outcome]}`}</span>
      </div>
    );
  }
  return null;
}

export function Timeline({ sessionId, events, loading, developerMode }: { sessionId: string | null; events: SessionEvent[]; loading: boolean; developerMode: boolean }) {
  const folded = useMemo(() => foldAgentCommunication(chronological(foldProgress(events))).slice(-160), [events]);
  if (loading && !folded.length) return <div className="grid flex-1 place-items-center text-sm text-muted-foreground">Loading conversation…</div>;
  if (!folded.length) {
    return (
      <div id="timelineEmpty" className="grid flex-1 place-items-center py-24 text-center text-muted-foreground">
        <div><Icon name="i-mark" className="mx-auto mb-3 size-7" /><p className="text-sm">What would you like to build?</p></div>
      </div>
    );
  }
  return (
    <div id="timeline" className="mx-auto flex w-full max-w-[900px] flex-col gap-3 px-6 py-8">
      {folded.map((event) => <EventRow key={`${event.seq}:${event.kind}`} event={event} developerMode={developerMode} sessionId={sessionId} />)}
    </div>
  );
}
