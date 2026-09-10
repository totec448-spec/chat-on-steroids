import { Select as BaseSelect } from '@base-ui/react/select';
import { cn } from '../../lib/cn.js';
import { Icon } from './icon.js';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export function Select<T extends string>({
  value,
  options,
  onValueChange,
  className,
  disabled,
  ariaLabel,
}: {
  value: T;
  options: readonly SelectOption<T>[];
  onValueChange: (value: T) => void;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <BaseSelect.Root
      value={value}
      disabled={disabled}
      items={options}
      onValueChange={(next) => { if (next !== null) onValueChange(next as T); }}
    >
      <BaseSelect.Trigger
        aria-label={ariaLabel}
        className={cn(
          'inline-flex h-8 min-w-36 items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-[13px] text-foreground outline-none transition-colors hover:bg-accent focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/15 disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      >
        <BaseSelect.Value className="min-w-0 flex-1 truncate text-left" />
        <Icon name="i-down" className="size-3.5 shrink-0 text-muted-foreground" />
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={6} alignItemWithTrigger={false} className="z-[80] outline-none">
          <BaseSelect.Popup className="min-w-[var(--anchor-width)] rounded-lg border border-border bg-popover text-popover-foreground shadow-lg outline-none transition-[transform,opacity] data-ending-style:scale-[.98] data-ending-style:opacity-0 data-starting-style:scale-[.98] data-starting-style:opacity-0">
            <BaseSelect.List className="max-h-72 overflow-y-auto p-1">
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2.5 text-[13px] outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:cursor-not-allowed data-disabled:opacity-45"
                >
                  <BaseSelect.ItemText className="min-w-0 flex-1 truncate">{option.label}</BaseSelect.ItemText>
                  <BaseSelect.ItemIndicator className="grid size-4 place-items-center text-foreground">
                    <Icon name="i-check" className="size-3.5" />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
