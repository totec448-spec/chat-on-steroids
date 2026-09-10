import { useMemo, useState } from 'react';
import type { LocalProject } from '../../../shared/projects.js';
import type { SessionSummary } from '../../../shared/session.js';
import { Icon } from '../ui/icon.js';
import { Input } from '../ui/input.js';

export function SearchPage({ sessions, projects, onSelect }: { sessions: SessionSummary[]; projects: LocalProject[]; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((session) => `${session.title} ${projectMap.get(session.projectId ?? '')?.name ?? ''}`.toLowerCase().includes(needle));
  }, [projectMap, query, sessions]);
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" data-panel="search">
      <header className="flex h-12 shrink-0 items-center border-b border-border px-5"><h1 className="text-sm font-semibold">Search</h1></header>
      <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <label className="relative block"><Icon name="i-search" className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} className="h-10 pl-9" placeholder="Search conversations and repositories" /></label>
        <div className="mt-5 overflow-hidden rounded-xl border border-border">
          {rows.slice(0, 100).map((session) => (
            <button key={session.id} type="button" onClick={() => onSelect(session.id)} className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left last:border-0 hover:bg-accent">
              <Icon name="i-chat" className="size-4 text-muted-foreground" /><div className="min-w-0 flex-1"><div className="truncate text-[13px] font-medium">{session.title}</div><div className="mt-0.5 truncate text-xs text-muted-foreground">{projectMap.get(session.projectId ?? '')?.name ?? 'No folder'} · {new Date(session.updatedAt).toLocaleString()}</div></div>
            </button>
          ))}
          {!rows.length && <div className="px-4 py-10 text-center text-sm text-muted-foreground">No matching conversations.</div>}
        </div>
      </div>
      </div>
    </section>
  );
}
