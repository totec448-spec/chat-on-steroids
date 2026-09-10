import { cn } from '../../lib/cn.js';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-border bg-card text-card-foreground shadow-sm', className)} {...props} />;
}

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('inline-flex h-5 items-center rounded-md bg-muted px-1.5 text-[11px] font-medium text-muted-foreground', className)} {...props} />;
}
