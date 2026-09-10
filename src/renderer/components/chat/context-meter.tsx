import type { SessionSummary } from '../../../shared/session.js';
import type { Config } from '../../../shared/types.js';
import { isProModel } from '../../../shared/chat-models.js';

export function ContextMeter({ session, config }: { session: SessionSummary | null; config: Config }) {
  if (!session) return null;
  const used = Math.max(0, session.contextTokens ?? 0);
  const observed = session.selectedModel?.conversationId === session.conversationId ? session.selectedModel : null;
  const pro = isProModel(observed?.model, observed?.reasoningEffort);
  const limit = config.sessions.limitTokens;
  const percent = limit > 0 ? Math.min(100, Math.round(used / limit * 100)) : 0;
  const tokens = new Intl.NumberFormat().format(used);
  const detail = pro
    ? `${tokens} tokens used · estimated · Auto-compaction off for Pro`
    : `${tokens} / ${new Intl.NumberFormat().format(limit)} tokens · ${percent}% of configured limit · ${config.compaction.auto ? `Auto-compaction at ${new Intl.NumberFormat().format(config.compaction.autoTokens)} tokens` : 'Auto-compaction off'}`;
  return (
    <details className="group relative" data-testid="context-meter">
      <summary className="grid size-7 cursor-pointer list-none place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground marker:hidden" aria-label={`Session context. ${detail}`}>
        <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden="true">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2" />
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" pathLength="100" strokeDasharray={`${pro ? 0 : percent} 100`} />
        </svg>
      </summary>
      <div className="absolute right-0 top-9 z-30 w-72 rounded-lg border border-border bg-popover p-3 text-xs leading-5 text-popover-foreground shadow-lg">
        <div className="font-medium">Session context · estimated</div>
        <div className="mt-1 text-muted-foreground">{detail}</div>
      </div>
    </details>
  );
}
