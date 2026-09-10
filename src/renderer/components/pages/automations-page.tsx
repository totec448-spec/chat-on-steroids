import { useCallback, useEffect, useState } from 'react';
import type { InputEntry } from '../../../main/session/input.js';
import { api, unwrap } from '../../state/app-store.js';
import { Button } from '../ui/button.js';
import { Icon } from '../ui/icon.js';
import { Badge } from '../ui/card.js';

export function AutomationsPage() {
  const [rows, setRows] = useState<InputEntry[]>([]);
  const [error, setError] = useState('');
  const refresh = useCallback(() => {
    void unwrap(api.listInputs()).then(setRows).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);
  useEffect(() => { refresh(); return api.onSessionChanged(refresh); }, [refresh]);
  const active = rows.filter((row) => !['sent', 'cancelled', 'failed', 'decision'].includes(row.state));
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" data-panel="automations">
      <header className="flex h-12 shrink-0 items-center border-b border-border px-5"><h1 className="text-sm font-semibold">Automations</h1><Button className="ml-auto" size="sm" variant="ghost" onClick={refresh}><Icon name="i-retry" className="size-3.5" />Refresh</Button></header>
      <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <h2 className="text-base font-semibold">Queued work</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Messages scheduled for a chat, after-turn deliveries, Goal/Loop continuations and session-finish work live here.</p>
        <div className="mt-5 overflow-hidden rounded-xl border border-border">
          {active.map((row) => (
            <div key={row.id} className="flex items-start gap-3 border-b border-border px-4 py-3 last:border-0">
              <Icon name="i-clock" className="mt-0.5 size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1"><div className="line-clamp-2 text-[13px] leading-5">{row.text}</div><div className="mt-2 flex flex-wrap items-center gap-1.5"><Badge>{row.state}</Badge><Badge>{row.mode}</Badge>{row.automation && row.automation !== 'off' && <Badge>{row.automation}</Badge>}<span className="text-[11px] text-muted-foreground">{new Date(row.dueAt).toLocaleString()}</span></div>{row.error && <p className="mt-1 text-xs text-destructive">{row.error}</p>}</div>
              <Button size="sm" variant="ghost" onClick={() => void unwrap(api.cancelInput(row.id)).then(refresh)}>Cancel</Button>
            </div>
          ))}
          {!active.length && <div className="px-4 py-12 text-center"><Icon name="i-clock" className="mx-auto mb-3 size-6 text-muted-foreground" /><p className="text-sm">No queued automations</p><p className="mt-1 text-xs text-muted-foreground">Use Goal, Loop, after-turn delivery, or a scheduled task from a conversation.</p></div>}
        </div>
          {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      </div>
      </div>
    </section>
  );
}
