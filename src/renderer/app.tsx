import { useCallback, useEffect, useRef, useState } from 'react';
import type { InputEntry } from '../preload/index.js';
import { AppSidebar, type AppPage } from './components/layout/app-sidebar.js';
import { ConversationWorkspace } from './components/chat/workspace.js';
import { SearchPage } from './components/pages/search-page.js';
import { AutomationsPage } from './components/pages/automations-page.js';
import { PluginsPage } from './components/pages/plugins-page.js';
import { UsagePage } from './components/pages/usage-page.js';
import { ActivityPage } from './components/pages/activity-page.js';
import { CustomizePage } from './components/settings/customize-page.js';
import { Button } from './components/ui/button.js';
import { Icon } from './components/ui/icon.js';
import { TooltipProvider } from './components/ui/tooltip.js';
import { api, unwrap, useAppStore } from './state/app-store.js';
import { useSessionDetail, useSessions } from './state/session-store.js';
import { RELEASES_PAGE } from '../shared/types.js';

function LoadingShell() {
  return <div className="grid h-screen place-items-center bg-background text-sm text-muted-foreground">Loading Chat On Steroids…</div>;
}

export function App() {
  const { state: appState, logs } = useAppStore();
  const sessions = useSessions();
  const [page, setPage] = useState<AppPage>('chat');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
  const [draftIdentity, setDraftIdentity] = useState(0);
  const [shellStatus, setShellStatus] = useState('');
  const draftGeneration = useRef(0);
  const pendingFresh = useRef<{ id: string; generation: number } | null>(null);
  const detail = useSessionDetail(page === 'chat' ? sessions.activeId : null);

  const resolveFreshSession = useCallback(async () => {
    const pending = pendingFresh.current;
    if (!pending) return;
    try {
      const rows = await unwrap(api.listInputs());
      if (pendingFresh.current !== pending || draftGeneration.current !== pending.generation) return;
      const row = rows.find((entry) => entry.id === pending.id);
      if (!row?.deliveredSessionId) return;
      pendingFresh.current = null;
      setDraftProjectId(null);
      setPage('chat');
      sessions.select(row.deliveredSessionId);
      void sessions.refresh(true);
    } catch {
      // Delivery remains visible in the durable outbox; the next authoritative session/input
      // change retries this exact id instead of guessing a conversation from recency.
    }
  }, [sessions.refresh, sessions.select]);

  useEffect(() => {
    if (!appState) return;
    document.documentElement.classList.toggle('dark', appState.config.ui.theme === 'dark');
    document.documentElement.dataset.theme = appState.config.ui.theme;
  }, [appState?.config.ui.theme]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault(); setSidebarOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  useEffect(() => api.onSessionChanged(() => { void resolveFreshSession(); }), [resolveFreshSession]);

  if (!appState) return <LoadingShell />;

  function newChat(projectId: string | null = null) {
    ++draftGeneration.current;
    pendingFresh.current = null;
    setDraftIdentity((value) => value + 1);
    sessions.select(null); setDraftProjectId(projectId); setPage('chat');
  }

  function selectSession(id: string) {
    ++draftGeneration.current;
    pendingFresh.current = null;
    sessions.select(id); setDraftProjectId(null); setPage('chat');
  }

  function draftChanged() {
    if (sessions.activeId !== null) return;
    ++draftGeneration.current;
    pendingFresh.current = null;
  }

  function inputAccepted(entry: InputEntry, followFreshSession: boolean) {
    if (!entry.sessionId && followFreshSession) {
      pendingFresh.current = { id: entry.id, generation: draftGeneration.current };
      void resolveFreshSession();
    }
    void sessions.refresh(true);
    void detail.refresh();
  }

  async function addProject() {
    try {
      const project = await unwrap(api.addProject());
      if (!project) return;
      await sessions.refresh(true);
      newChat(project.id);
      setShellStatus('');
    } catch (error) { setShellStatus(error instanceof Error ? error.message : String(error)); }
  }

  async function removeProject(id: string): Promise<void> {
    try {
      await unwrap(api.removeProject(id));
      await sessions.refresh(true);
      setShellStatus('');
    } catch (error) {
      setShellStatus(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function deleteSession(id: string): Promise<void> {
    const deletedProjectId = sessions.sessions.find(session => session.id === id)?.projectId ?? null;
    try {
      await unwrap(api.deleteSession(id));
      if (sessions.activeId === id) {
        if (deletedProjectId) newChat(deletedProjectId);
        else { sessions.select(null); setDraftProjectId(null); setPage('chat'); }
      }
      await sessions.refresh(true);
      setShellStatus('');
    } catch (error) {
      setShellStatus(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  const update = appState.update;
  return (
    <TooltipProvider>
      <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground">
        <div className="app-topbar">
          <Button id="sidebarToggle" size="icon-sm" variant="ghost" onClick={() => setSidebarOpen((open) => !open)} aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'} title="Toggle sidebar (Ctrl+B)"><Icon name="i-sidebar" /></Button>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1">
        <AppSidebar
          open={sidebarOpen}
          page={page}
          sessions={sessions.sessions}
          projects={sessions.projects}
          selectedId={sessions.activeId}
          onPage={setPage}
          onSelectSession={selectSession}
          onNewChat={newChat}
          onAddProject={() => void addProject()}
          onRemoveProject={removeProject}
          onDeleteSession={deleteSession}
          onLoadMore={() => void sessions.loadMore()}
          hasMore={!!sessions.nextCursor}
        />

        {/* min-h-0 is load-bearing: without it this column floors at its content height
            and every scroll region below grows instead of scrolling. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {update.latest && (
            <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-border bg-muted/60 px-4 text-xs text-muted-foreground">
              <Icon name="i-bolt" className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">Chat On Steroids {update.latest} is available{update.stage === 'ready' ? ' and ready to install.' : '.'}</span>
              {update.stage === 'ready' ? <Button size="sm" variant="ghost" onClick={() => void unwrap(api.installUpdate())}>Install now</Button> : <Button size="sm" variant="ghost" onClick={() => void unwrap(api.openLink(RELEASES_PAGE))}>View release</Button>}
            </div>
          )}
          {shellStatus && <div role="status" className="flex min-h-8 shrink-0 items-center border-b border-border bg-destructive/5 px-4 text-xs text-destructive"><span className="min-w-0 flex-1 truncate">{shellStatus}</span><Button size="icon-sm" variant="ghost" onClick={() => setShellStatus('')} aria-label="Dismiss"><Icon name="i-x" /></Button></div>}

          {page === 'chat' && (
            <ConversationWorkspace
              appState={appState}
              session={detail.summary}
              events={detail.events}
              loading={detail.loading}
              projects={sessions.projects}
              draftProjectId={draftProjectId}
              draftIdentity={draftIdentity}
              onProjectSelected={(id) => { setDraftProjectId(id); void sessions.refresh(true); }}
              onRefresh={() => { void sessions.refresh(true); void detail.refresh(); }}
              onSent={inputAccepted}
              onDraftChanged={draftChanged}
              onCustomize={() => setPage('customize')}
              workers={sessions.sessions.filter((row) => row.origin?.kind === 'worker' && row.origin.fromSessionId === detail.summary?.id)}
              onSelectSession={selectSession}
              history={detail}
              blocked={!!detail.summary && sessions.blocked.has(detail.summary.id)}
            />
          )}
          {page === 'search' && <SearchPage sessions={sessions.sessions} projects={sessions.projects} onSelect={selectSession} />}
          {page === 'automations' && <AutomationsPage />}
          {page === 'customize' && <CustomizePage appState={appState} />}
          {page === 'plugins' && <PluginsPage appState={appState} />}
          {page === 'usage' && <UsagePage />}
          {page === 'activity' && <ActivityPage logs={logs} />}
        </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
