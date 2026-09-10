import type { LocalProject } from '../../../shared/projects.js';
import type { SessionSummary } from '../../../shared/session.js';
import type { AppState } from '../../../shared/types.js';
import { Timeline } from './timeline.js';
import { Composer } from './composer.js';
import { Icon } from '../ui/icon.js';
import { Button } from '../ui/button.js';
import { api, unwrap } from '../../state/app-store.js';
import { AgentPanel } from './agent-panel.js';
import { useEffect, useRef, useState } from 'react';
import type { InputEntry, SessionControlsView } from '../../../preload/index.js';
import { useSessionControls, useSessionQueue } from '../../state/conversation-store.js';
import { TaskDock } from './task-dock.js';
import { ContextMeter } from './context-meter.js';

export function ConversationWorkspace({
  appState,
  session,
  events,
  loading,
  projects,
  draftProjectId,
  onProjectSelected,
  onRefresh,
  onSent,
  onDraftChanged,
  onCustomize,
  workers,
  onSelectSession,
  history,
  blocked,
  draftIdentity,
}: {
  appState: AppState | null;
  session: SessionSummary | null;
  events: Parameters<typeof Timeline>[0]['events'];
  loading: boolean;
  projects: LocalProject[];
  draftProjectId: string | null;
  onProjectSelected: (id: string | null) => void;
  onRefresh: () => void;
  onSent: (entry: InputEntry, followFreshSession: boolean) => void;
  onDraftChanged: () => void;
  onCustomize: () => void;
  workers: SessionSummary[];
  onSelectSession: (id: string) => void;
  history: {
    loadOlder: () => Promise<boolean>;
    loadNewer: () => Promise<boolean>;
    loadingOlder: boolean;
    loadingNewer: boolean;
    atLatest: boolean;
    canLoadOlder: boolean;
  };
  blocked: boolean;
  draftIdentity: number;
}) {
  const [agentsOpen, setAgentsOpen] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const firstPaint = useRef<string | null>(null);
  const projectId = session?.projectId ?? draftProjectId;
  const project = projects.find((item) => item.id === projectId) ?? null;
  const connection = appState?.status.state ?? 'disconnected';
  const online = connection === 'connected' || connection === 'offline';
  const controlState = useSessionControls(session?.id ?? null);
  const queueState = useSessionQueue(session?.id ?? null);
  useEffect(() => {
    const node = transcript.current;
    if (!node || loading) return;
    const identity = session?.id ?? 'new';
    if (firstPaint.current !== identity) {
      firstPaint.current = identity;
      node.scrollTop = node.scrollHeight;
    }
  }, [events.length, loading, session?.id]);

  async function maybeLoadHistory() {
    const node = transcript.current;
    if (!node) return;
    if (node.scrollTop <= 72 && history.canLoadOlder && !history.loadingOlder) {
      const height = node.scrollHeight;
      const top = node.scrollTop;
      if (await history.loadOlder()) requestAnimationFrame(() => {
        if (transcript.current === node) node.scrollTop = top + (node.scrollHeight - height);
      });
      return;
    }
    const distance = node.scrollHeight - node.clientHeight - node.scrollTop;
    if (distance <= 72 && !history.atLatest && !history.loadingNewer) {
      const follow = distance <= 24;
      if (await history.loadNewer() && follow) requestAnimationFrame(() => {
        if (transcript.current === node) node.scrollTop = node.scrollHeight;
      });
    }
  }
  async function controlsChanged(next?: SessionControlsView): Promise<void> {
    if (next) controlState.accept(next);
    else await controlState.refresh();
    await queueState.refresh();
    onRefresh();
  }

  async function setBlocked(): Promise<void> {
    if (!session) return;
    try {
      await unwrap(api.setSessionBlocked(session.id, !blocked));
      onRefresh();
      await controlState.refresh();
    } catch {
      // Main returns the authoritative block set on success; failures are surfaced by the
      // unchanged control state rather than creating a renderer-side second authority.
    }
  }
  // min-h-0 on this section is load-bearing: without it the section floors at its
  // content height and #chatBody grows instead of scrolling.
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" data-panel="chat">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <div className="min-w-0 flex-1">
          <div id="chatTitle" className="truncate text-[13px] font-medium">{session?.title ?? 'New Chat'}</div>
        </div>
        {project && <span className="hidden max-w-[240px] items-center gap-1.5 truncate rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground sm:inline-flex"><Icon name="i-folder" className="size-3.5" />{project.name}</span>}
        <span
          id="live"
          className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium ${online ? 'bg-success text-success-foreground' : 'bg-muted text-muted-foreground'}`}
        >
          <span id="liveState">{online ? 'Connected' : 'Local'}</span>
        </span>
        {!!workers.length && <Button id="agentPanelToggle" size="sm" variant="ghost" onClick={() => setAgentsOpen(true)}><Icon name="i-bolt" className="size-3.5" />{workers.length} agents</Button>}
        {appState && <ContextMeter session={session} config={appState.config} />}
        {session && <Button size="icon-sm" variant="ghost" onClick={() => void setBlocked()} aria-label={blocked ? 'Unblock conversation' : 'Block conversation'}><Icon name={blocked ? 'i-lock' : 'i-ban'} className="size-3.5" /></Button>}
        {session?.conversationId && <Button size="icon-sm" variant="ghost" onClick={() => void unwrap(api.openSessionChat(session.id))} aria-label="Open in ChatGPT"><Icon name="i-out" className="size-3.5" /></Button>}
        <Button id="chatSettingsBtn" size="icon-sm" variant="ghost" onClick={onCustomize} aria-label="Customize"><Icon name="i-gear" className="size-3.5" /></Button>
      </header>
      <div id="chatBody" ref={transcript} onScroll={() => void maybeLoadHistory()} className="min-h-0 flex-1 overflow-y-auto">
        {(history.loadingOlder || history.loadingNewer) && <div className="sticky top-2 z-10 mx-auto w-fit rounded-full border border-border bg-background/95 px-3 py-1 text-[11px] text-muted-foreground shadow-sm">Loading conversation…</div>}
        <Timeline sessionId={session?.id ?? null} events={events} loading={loading} developerMode={appState?.config.ui.developerMode === true} />
        {!history.atLatest && <div className="sticky bottom-3 mx-auto mb-3 w-fit"><Button size="sm" variant="secondary" onClick={() => void history.loadNewer()}>Back toward latest</Button></div>}
      </div>
      <TaskDock
        session={session}
        controls={controlState.controls}
        rows={queueState.rows}
        pausedHelpers={queueState.pausedHelpers}
        loading={controlState.loading || queueState.loading}
        error={controlState.error || queueState.error}
        onRefresh={queueState.refresh}
        onControlsChanged={controlsChanged}
      />
      <Composer
        key={session?.id ?? `new:${draftIdentity}`}
        session={session}
        projects={projects}
        draftProjectId={draftProjectId}
        controls={controlState.controls}
        onProjectSelected={onProjectSelected}
        onSent={(entry, followFreshSession) => { void queueState.refresh(); void controlState.refresh(); onSent(entry, followFreshSession); }}
        onControlsChanged={controlsChanged}
        onDraftChanged={onDraftChanged}
        onOpenCustomize={onCustomize}
        planBackend={appState?.config.ui.planBackend ?? 'chatgpt'}
      />
      <AgentPanel parentSessionId={session?.id ?? null} workers={workers} open={agentsOpen} onOpenChange={setAgentsOpen} onOpenMain={onSelectSession} />
    </section>
  );
}
