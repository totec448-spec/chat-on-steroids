import type { LogEntry } from '../../../shared/types.js';
import { api, unwrap } from '../../state/app-store.js';
import { Button } from '../ui/button.js';
import { Icon } from '../ui/icon.js';

export function ActivityPage({ logs }: { logs: LogEntry[] }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" data-panel="activity">
      <header className="flex h-12 items-center border-b border-border px-5"><h1 className="text-sm font-semibold">Activity</h1><div className="ml-auto flex gap-1"><Button size="sm" variant="ghost" onClick={() => void unwrap(api.getLogText()).then((text) => unwrap(api.writeClipboard(text)))}><Icon name="i-copy" className="size-3.5" />Text</Button><Button size="sm" variant="ghost" onClick={() => void unwrap(api.getLogJson()).then((text) => unwrap(api.writeClipboard(text)))}><Icon name="i-copy" className="size-3.5" />JSON</Button></div></header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 font-mono text-[11px] leading-5">
        <div className="mx-auto max-w-5xl space-y-0.5">{logs.map((entry, index) => <div key={`${entry.time}:${index}`} className="grid grid-cols-[82px_48px_minmax(0,1fr)] gap-2 rounded px-2 py-1 hover:bg-accent"><span className="text-muted-foreground">{new Date(entry.time).toLocaleTimeString()}</span><span className={entry.level === 'error' ? 'text-destructive' : entry.level === 'warn' ? 'text-foreground' : 'text-muted-foreground'}>{entry.level}</span><span className="break-words">{entry.agent ? `[${entry.agent}] ` : ''}{entry.message}</span></div>)}</div>
      </div>
    </section>
  );
}
