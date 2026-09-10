import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { cn } from '../../lib/cn.js';

export const Dialog = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogClose = BaseDialog.Close;

export function DialogContent({ className, children, ...props }: React.ComponentProps<typeof BaseDialog.Popup>) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[1px] transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0 dark:bg-black/45" />
      <BaseDialog.Viewport className="fixed inset-0 z-50 flex items-center justify-center p-6">
        <BaseDialog.Popup
          className={cn(
            'max-h-[calc(100vh-3rem)] w-[min(760px,calc(100vw-3rem))] overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-xl outline-none transition-[transform,opacity] data-ending-style:scale-[.985] data-ending-style:opacity-0 data-starting-style:scale-[.985] data-starting-style:opacity-0',
            className,
          )}
          {...props}
        >
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Viewport>
    </BaseDialog.Portal>
  );
}

export const DialogTitle = BaseDialog.Title;
export const DialogDescription = BaseDialog.Description;
