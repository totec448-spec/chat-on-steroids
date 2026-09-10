import { useEffect, useState } from 'react';
import type { SessionEvent, SessionSummary } from '../../../shared/session.js';
import { api, unwrap } from '../../state/app-store.js';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../ui/dialog.js';
import { Icon } from '../ui/icon.js';
import { Timeline } from './timeline.js';

export function AgentPanel({ parentSessionId, workers, open, onOpenChange, onOpenMain }: { parentSessionId: string | null; workers: SessionSummary[]; open: boolean; onOpenChange: (open: boolean) => void; onOpenMain: (id: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const worker = workers.find((row) => row.id === selected) ?? null;
  useEffect(() => {
    if (!open) { setSelected(null); setEvents([]); setLoading(false); }
  }, [open]);
  useEffect(() => {
    setSelected(null); setEvents([]); setLoading(false);
  }, [parentSessionId]);
  useEffect(() => {
    if (!selected) { setEvents([]); setLoading(false); return; }
    let current = true;
    setLoading(true);
    void unwrap(api.getSession(selected, { limit: 120 })).then((detail) => { if (current) { setEvents(detail.events); setLoading(false); } }).catch(() => { if (current) { setEvents([]); setLoading(false); } });
    return () => { current = false; };
  }, [selected]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(760px,calc(100vh-3rem))] max-w-[1000px] flex-col">
        <div className="flex h-12 shrink-0 items-center border-b border-border px-4">
          {worker && <button type="button" className="mr-2 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setSelected(null)}><Icon name="i-chev" className="rotate-180" /></button>}
          <DialogTitle className="min-w-0 flex-1 truncate text-sm font-semibold">{worker?.title ?? 'Sub-agents'}</DialogTitle>
          {worker && <button type="button" className="mr-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => { onOpenMain(worker.id); onOpenChange(false); }}>Open full chat</button>}
          <DialogClose className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><Icon name="i-x" /></DialogClose>
        </div>
        {worker ? <div className="min-h-0 flex-1 overflow-y-auto"><Timeline sessionId={worker.id} events={events} loading={loading} developerMode={false} /></div> : <div className="min-h-0 flex-1 overflow-y-auto p-3"><div className="grid gap-1">{workers.map((row) => <button key={row.id} type="button" onClick={() => setSelected(row.id)} className="flex items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-accent"><span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold">{row.origin?.agentId?.replace(/^worker-/, '') ?? '•'}</span><div className="min-w-0 flex-1"><div className="truncate text-[13px] font-medium">{row.title}</div><div className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{row.origin?.task || 'Worker conversation'}</div></div>{row.activeTurnId && <span className="size-1.5 rounded-full bg-foreground" />}</button>)}{!workers.length && <div className="py-16 text-center text-sm text-muted-foreground">No sub-agents recorded for this conversation.</div>}</div></div>}
      </DialogContent>
    </Dialog>
  );
}
