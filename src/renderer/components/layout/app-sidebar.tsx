import { Fragment, useMemo, useState } from 'react';
import type { LocalProject } from '../../../shared/projects.js';
import type { SessionSummary } from '../../../shared/session.js';
import { cn } from '../../lib/cn.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu.js';
import { Icon } from '../ui/icon.js';
import { ScrollArea } from '../ui/scroll-area.js';

export type AppPage = 'chat' | 'search' | 'automations' | 'customize' | 'plugins' | 'usage' | 'activity';

type SessionRole = 'conversation' | 'primary' | 'worker';

function SessionRow({
  session,
  selected,
  role,
  nested = false,
  onSelect,
  onDelete,
}: {
  session: SessionSummary;
  selected: boolean;
  role: SessionRole;
  nested?: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const worker = role === 'worker';
  const primary = role === 'primary';
  const active = !!session.activeTurnId || !!session.activityExpiresAt && session.activityExpiresAt > Date.now();
  return (
    <div
      className={cn(
        'group/session flex h-8 min-w-0 max-w-full items-center rounded-md text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground',
        nested ? 'ml-3 w-[calc(100%-0.75rem)]' : 'w-full',
        selected && 'bg-accent text-foreground',
        primary && 'bg-brand-wash/70 text-brand hover:bg-brand-wash hover:text-brand',
      )}
      data-session-id={session.id}
      data-session-role={role}
    >
      <button type="button" className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-left" onClick={onSelect}>
        <span className={cn('size-1.5 shrink-0 rounded-full bg-muted-foreground/30', active && 'bg-foreground', primary && 'bg-brand')} />
        <span className="min-w-0 flex-1 truncate">{session.title || 'Untitled chat'}</span>
        {primary && <span className="text-[10px] font-medium text-brand">primary</span>}
        {worker && <span className="text-[10px] text-muted-foreground/70">agent</span>}
      </button>
      <button
        type="button"
        className="mr-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-background/70 hover:text-destructive"
        aria-label={`Delete ${session.title || 'Untitled chat'}`}
        title={`Delete ${session.title || 'Untitled chat'}`}
        onClick={onDelete}
      >
        <Icon name="i-trash" className="size-3.5" />
      </button>
    </div>
  );
}

function SessionRows({
  rows,
  page,
  selectedId,
  onSelectSession,
  onDelete,
}: {
  rows: SessionSummary[];
  page: AppPage;
  selectedId: string | null;
  onSelectSession: (id: string) => void;
  onDelete: (session: SessionSummary) => void;
}) {
  const ids = new Set(rows.map(session => session.id));
  const children = new Map<string, SessionSummary[]>();
  const roots: SessionSummary[] = [];
  for (const session of rows) {
    const parentId = session.origin?.kind === 'worker' ? session.origin.fromSessionId : null;
    if (parentId && ids.has(parentId)) {
      const nested = children.get(parentId) ?? [];
      nested.push(session);
      children.set(parentId, nested);
    } else {
      roots.push(session);
    }
  }

  return <>{roots.map(session => {
    const workerChildren = children.get(session.id) ?? [];
    const primary = session.origin?.kind !== 'worker' && (workerChildren.length > 0 || session.agents.some(agent => agent.startsWith('worker-')));
    const role: SessionRole = primary ? 'primary' : session.origin?.kind === 'worker' ? 'worker' : 'conversation';
    return (
      <Fragment key={session.id}>
        <SessionRow
          session={session}
          role={role}
          selected={page === 'chat' && selectedId === session.id}
          onSelect={() => onSelectSession(session.id)}
          onDelete={() => onDelete(session)}
        />
        {workerChildren.map(worker => (
          <SessionRow
            key={worker.id}
            session={worker}
            role="worker"
            nested
            selected={page === 'chat' && selectedId === worker.id}
            onSelect={() => onSelectSession(worker.id)}
            onDelete={() => onDelete(worker)}
          />
        ))}
      </Fragment>
    );
  })}</>;
}

export function AppSidebar({
  open,
  page,
  sessions,
  projects,
  selectedId,
  onPage,
  onSelectSession,
  onNewChat,
  onAddProject,
  onRemoveProject,
  onDeleteSession,
  onLoadMore,
  hasMore,
}: {
  open: boolean;
  page: AppPage;
  sessions: SessionSummary[];
  projects: LocalProject[];
  selectedId: string | null;
  onPage: (page: AppPage) => void;
  onSelectSession: (id: string) => void;
  onNewChat: (projectId?: string | null) => void;
  onAddProject: () => void;
  onRemoveProject: (id: string) => Promise<void> | void;
  onDeleteSession: (id: string) => Promise<void> | void;
  onLoadMore: () => void;
  hasMore: boolean;
}) {
  const [pendingProject, setPendingProject] = useState<{ id: string; name: string } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const visibleProjects = useMemo(() => projects.filter(project => !project.hidden), [projects]);
  const grouped = useMemo(() => {
    const byProject = new Map<string, SessionSummary[]>();
    const loose: SessionSummary[] = [];
    const visibleIds = new Set(visibleProjects.map(project => project.id));
    const byId = new Map(sessions.map(session => [session.id, session]));
    for (const session of sessions) {
      const inheritedProjectId = session.origin?.kind === 'worker'
        ? byId.get(session.origin.fromSessionId ?? '')?.projectId
        : undefined;
      const projectId = session.projectId ?? inheritedProjectId;
      if (projectId && visibleIds.has(projectId)) {
        const rows = byProject.get(projectId) ?? [];
        rows.push(session); byProject.set(projectId, rows);
      } else loose.push(session);
    }
    return { byProject, loose };
  }, [sessions, visibleProjects]);

  // The title-bar row owns the one sidebar toggle, so a closed sidebar renders
  // nothing instead of a second reopen rail beside it.
  if (!open) return null;

  function toggleProject(id: string): void {
    setCollapsedProjects(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const nav: Array<{ page: AppPage; label: string; icon: string }> = [
    { page: 'search', label: 'Search', icon: 's-search' },
    { page: 'automations', label: 'Automations', icon: 's-agents' },
    { page: 'customize', label: 'Customize', icon: 's-settings' },
  ];
  // min-h-0 on the rail is load-bearing: without it the rail floors at its content
  // height and the session list grows instead of scrolling.
  async function confirmRemoveProject(): Promise<void> {
    if (!pendingProject || actionBusy) return;
    setActionBusy(true);
    try {
      await onRemoveProject(pendingProject.id);
      setPendingProject(null);
    } catch {
      // The shell owns the visible error banner; keep the confirmation open for retry/cancel.
    } finally {
      setActionBusy(false);
    }
  }

  function deleteSession(id: string): void {
    try {
      void Promise.resolve(onDeleteSession(id)).catch(() => undefined);
    } catch {
      // The shell owns the visible error banner.
    }
  }

  return (
    <>
    <aside id="sidebar" className="flex min-h-0 w-[280px] shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar text-sidebar-foreground">
      <nav className="space-y-0.5 px-2 pt-2" aria-label="Primary navigation">
        {nav.map((item) => (
          <button
            key={item.page}
            type="button"
            onClick={() => onPage(item.page)}
            className={cn('flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] hover:bg-sidebar-accent', page === item.page && 'bg-sidebar-accent text-sidebar-accent-foreground')}
          >
            <Icon name={item.icon} className="size-4" />{item.label}
          </button>
        ))}
      </nav>

      <div className="mt-5 flex items-center justify-between px-3.5 text-[11px] font-medium text-muted-foreground">
        <span>Repositories</span>
        <Button id="addProject" size="icon-sm" variant="ghost" onClick={onAddProject} aria-label="Add repository"><Icon name="i-folder" className="size-3.5" /></Button>
      </div>
      <ScrollArea className="mt-1 min-w-0 flex-1">
        <div id="sessionList" className="min-w-0 space-y-2 px-2 pb-4">
          {visibleProjects.map((project) => {
            const rows = grouped.byProject.get(project.id) ?? [];
            const collapsed = collapsedProjects.has(project.id);
            const sessionsId = `project-sessions-${project.id}`;
            return (
              <section key={project.id} className="min-w-0">
                <div
                  className="group/project flex h-9 min-w-0 max-w-full items-center gap-1 rounded-md px-1 text-[13px] text-foreground hover:bg-sidebar-accent/60"
                  data-project-header={project.id}
                >
                  <button
                    type="button"
                    className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left"
                    aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${project.name}`}
                    aria-expanded={!collapsed}
                    aria-controls={sessionsId}
                    onClick={() => toggleProject(project.id)}
                    title={project.path}
                  >
                    <Icon name={collapsed ? 'i-chev' : 'i-down'} className="size-3.5 text-muted-foreground" />
                    <Icon name="i-folder" className="size-4 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  </button>
                  <button
                    type="button"
                    className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground"
                    aria-label={`New conversation in ${project.name}`}
                    title={`New conversation in ${project.name}`}
                    onClick={() => onNewChat(project.id)}
                  >
                    <Icon name="i-plus" className="size-3.5" />
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-70 outline-none hover:bg-accent hover:text-foreground group-hover/project:opacity-100" aria-label={`Repository actions for ${project.name}`}>
                      <Icon name="i-more" className="size-3.5" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-44">
                      <DropdownMenuItem className="text-destructive" onClick={() => setPendingProject({ id: project.id, name: project.name })}><Icon name="i-x" className="size-3.5" />Remove from sidebar</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {!collapsed && <div id={sessionsId} className="ml-[18px] min-w-0 space-y-0.5 border-l border-border pl-1.5">
                  <SessionRows
                    rows={rows}
                    page={page}
                    selectedId={selectedId}
                    onSelectSession={onSelectSession}
                    onDelete={(session) => deleteSession(session.id)}
                  />
                </div>}
              </section>
            );
          })}
          {!!grouped.loose.length && (
            <section>
              <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">Other conversations</div>
              <div className="space-y-0.5"><SessionRows rows={grouped.loose} page={page} selectedId={selectedId} onSelectSession={onSelectSession} onDelete={(session) => deleteSession(session.id)} /></div>
            </section>
          )}
          {hasMore && <Button variant="ghost" size="sm" className="w-full" onClick={onLoadMore}>Show more</Button>}
        </div>
      </ScrollArea>

      <div className="border-t border-border p-2">
        <div className="grid grid-cols-3 gap-1">
          <Button size="sm" variant={page === 'plugins' ? 'secondary' : 'ghost'} onClick={() => onPage('plugins')}><Icon name="s-plugins" className="size-3.5" />Plugins</Button>
          <Button size="sm" variant={page === 'usage' ? 'secondary' : 'ghost'} onClick={() => onPage('usage')}><Icon name="s-usage" className="size-3.5" />Usage</Button>
          <Button size="sm" variant={page === 'activity' ? 'secondary' : 'ghost'} onClick={() => onPage('activity')}><Icon name="s-activity" className="size-3.5" />Activity</Button>
        </div>
      </div>
    </aside>
    <Dialog open={pendingProject !== null} onOpenChange={(open) => { if (!open && !actionBusy) setPendingProject(null); }}>
      <DialogContent className="w-[min(420px,calc(100vw-3rem))]">
        <div className="px-5 pt-5">
          <DialogTitle className="text-sm font-semibold">Remove repository?</DialogTitle>
          <DialogDescription className="mt-1.5 text-xs leading-5 text-muted-foreground">
            {`Remove “${pendingProject?.name ?? ''}” from the repository sidebar? Existing chats keep their project binding and folder permission; permissions can be revoked separately in Customize.`}
          </DialogDescription>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4">
          <DialogClose className="inline-flex h-8 cursor-pointer items-center rounded-md border border-border px-3 text-xs hover:bg-accent">Cancel</DialogClose>
          <Button variant="destructive" disabled={actionBusy} onClick={() => void confirmRemoveProject()}>{actionBusy ? 'Working…' : 'Remove repository'}</Button>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}
