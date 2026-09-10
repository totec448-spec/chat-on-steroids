import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { cn } from '../../lib/cn.js';

export function Switch({
  className,
  thumbClassName,
  ...props
}: React.ComponentProps<typeof BaseSwitch.Root> & { thumbClassName?: string }) {
  return (
    <BaseSwitch.Root
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border bg-muted p-0.5 outline-none transition-colors data-checked:bg-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb
        className={cn(
          'block size-3.5 rounded-full bg-background shadow-sm transition-transform data-checked:translate-x-4',
          thumbClassName,
        )}
      />
    </BaseSwitch.Root>
  );
}
