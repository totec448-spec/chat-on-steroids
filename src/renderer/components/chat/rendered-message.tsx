import { useLayoutEffect, useRef } from 'react';
import type { StoredText } from '../../../shared/session.js';
import { renderedMarkdown, renderedMessage } from '../../lib/rendered-message.js';
import { cn } from '../../lib/cn.js';

export function RenderedMessage({
  source,
  rendered,
  className,
}: {
  source: string;
  rendered?: StoredText;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    const node = rendered ? renderedMessage(rendered, source) : renderedMarkdown(source);
    host.replaceChildren(node);
    return () => host.replaceChildren();
  }, [rendered, source]);
  return <div ref={ref} className={cn('min-w-0', className)} />;
}
