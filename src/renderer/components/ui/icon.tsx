import type { SVGProps } from 'react';
import { cn } from '../../lib/cn.js';

export function Icon({ name, className, ...props }: SVGProps<SVGSVGElement> & { name: string }) {
  return (
    <svg className={cn('size-4 shrink-0', className)} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <use href={`#${name}`} />
    </svg>
  );
}
