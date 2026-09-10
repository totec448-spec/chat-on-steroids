import { Menu as BaseMenu } from '@base-ui/react/menu';
import { cn } from '../../lib/cn.js';

export const DropdownMenu = BaseMenu.Root;
export const DropdownMenuTrigger = BaseMenu.Trigger;

export function DropdownMenuContent({
  className,
  align = 'start',
  ...props
}: React.ComponentProps<typeof BaseMenu.Popup> & { align?: 'start' | 'center' | 'end' }) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner sideOffset={6} align={align} className="z-[70] outline-none">
        <BaseMenu.Popup
          className={cn(
            'min-w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none transition-[transform,opacity] data-ending-style:scale-[.98] data-ending-style:opacity-0 data-starting-style:scale-[.98] data-starting-style:opacity-0',
            className,
          )}
          {...props}
        />
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

export function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof BaseMenu.Item>) {
  return (
    <BaseMenu.Item
      className={cn(
        'flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2.5 text-[13px] outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:cursor-not-allowed data-disabled:opacity-45',
        className,
      )}
      {...props}
    />
  );
}

export const DropdownMenuSeparator = ({ className, ...props }: React.ComponentProps<typeof BaseMenu.Separator>) => (
  <BaseMenu.Separator className={cn('my-1 h-px bg-border', className)} {...props} />
);
