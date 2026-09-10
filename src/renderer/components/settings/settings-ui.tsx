import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.js';

export function SettingsSection({ title, description, children, className }: { title: string; description?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('grid gap-3 border-b border-border py-6 last:border-0', className)}>
      <div><h2 className="text-sm font-semibold text-foreground">{title}</h2>{description && <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">{description}</p>}</div>
      <div className="overflow-hidden rounded-xl border border-border bg-card">{children}</div>
    </section>
  );
}

export function SettingRow({ title, description, children, className }: { title: string; description?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-h-14 items-center gap-5 border-b border-border px-4 py-3 last:border-0', className)}>
      <div className="min-w-0 flex-1"><div className="text-[13px] font-medium text-foreground">{title}</div>{description && <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</div>}</div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="grid gap-1.5 px-4 py-3 text-xs"><span className="font-medium text-foreground">{label}</span>{children}{hint && <span className="leading-5 text-muted-foreground">{hint}</span>}</label>;
}
