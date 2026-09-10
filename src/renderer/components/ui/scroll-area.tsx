import { ScrollArea as BaseScrollArea } from '@base-ui/react/scroll-area';
import { cn } from '../../lib/cn.js';

export function ScrollArea({ className, viewportClassName, children }: { className?: string; viewportClassName?: string; children: React.ReactNode }) {
  return (
    <BaseScrollArea.Root className={cn('relative min-h-0 min-w-0 overflow-hidden', className)}>
      <BaseScrollArea.Viewport className={cn('h-full w-full outline-none', viewportClassName)}>
        <BaseScrollArea.Content style={{ minWidth: 0, width: '100%' }}>{children}</BaseScrollArea.Content>
      </BaseScrollArea.Viewport>
      <BaseScrollArea.Scrollbar className="m-0.5 flex w-2.5 justify-center rounded-full opacity-0 transition-opacity data-hovering:opacity-100 data-scrolling:opacity-100">
        <BaseScrollArea.Thumb className="w-1.5 rounded-full bg-foreground/20" />
      </BaseScrollArea.Scrollbar>
    </BaseScrollArea.Root>
  );
}
