import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import { cn } from '../../lib/cn.js';

export const TooltipProvider = BaseTooltip.Provider;
export const Tooltip = BaseTooltip.Root;
export const TooltipTrigger = BaseTooltip.Trigger;

export function TooltipContent({ className, ...props }: React.ComponentProps<typeof BaseTooltip.Popup>) {
  return (
    <BaseTooltip.Portal>
      <BaseTooltip.Positioner sideOffset={8} className="z-[80]">
        <BaseTooltip.Popup
          className={cn(
            'rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md outline-none transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0',
            className,
          )}
          {...props}
        />
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  );
}
