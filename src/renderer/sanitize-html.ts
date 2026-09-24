const AUTO_DIRECTION_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'TD', 'TH']);
const CODE_DIRECTION_TAGS = new Set(['PRE', 'CODE', 'KBD']);

export interface HtmlSanitizerOptions {
  allowedTags: ReadonlySet<string>;
  dropTags: ReadonlySet<string>;
  safeHref: (value: string) => string | null;
  preserveDirection?: boolean;
}

/**
 * Shared renderer sanitizer for markup that originated outside the Electron renderer.
 *
 * Callers own their tag policy; this owns the security-sensitive traversal and the tiny common
 * attribute allowlist so chat captures and Files markdown cannot drift in opposite directions.
 */
export function sanitizeHtmlTree(parent: ParentNode, options: HtmlSanitizerOptions, directionOwned = false): void {
  for (const node of [...parent.childNodes]) {
    // Use the DOM numeric discriminator instead of the global `Node` constructor. Besides
    // working across jsdom realms, this keeps the sanitizer valid in any isolated document
    // whose Node constructor was not copied onto globalThis.
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    const tag = element.tagName.toUpperCase();
    if (options.dropTags.has(tag)) {
      element.remove();
      continue;
    }

    const sourceDir = options.preserveDirection ? element.getAttribute('dir')?.toLowerCase() : null;
    const explicitDir = sourceDir === 'ltr' || sourceDir === 'rtl' || sourceDir === 'auto' ? sourceDir : null;
    const automaticDir = options.preserveDirection === true && !directionOwned && AUTO_DIRECTION_TAGS.has(tag);
    const codeDir = options.preserveDirection === true && CODE_DIRECTION_TAGS.has(tag);
    const resolvedDir = options.allowedTags.has(tag) ? explicitDir ?? (codeDir ? 'ltr' : automaticDir ? 'auto' : null) : null;

    sanitizeHtmlTree(element, options, directionOwned || !!resolvedDir);
    if (!options.allowedTags.has(tag)) {
      element.replaceWith(...element.childNodes);
      continue;
    }

    const href = tag === 'A' ? options.safeHref(element.getAttribute('href') ?? '') : null;
    const title = element.getAttribute('title');
    const start = tag === 'OL' ? element.getAttribute('start') : null;
    const colSpan = tag === 'TD' || tag === 'TH' ? element.getAttribute('colspan') : null;
    const rowSpan = tag === 'TD' || tag === 'TH' ? element.getAttribute('rowspan') : null;
    for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
    if (resolvedDir) element.setAttribute('dir', resolvedDir);
    if (href) {
      element.setAttribute('href', href);
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noreferrer noopener');
    }
    if (title) element.setAttribute('title', title.slice(0, 500));
    if (start && /^\d{1,6}$/.test(start)) element.setAttribute('start', start);
    if (colSpan && /^\d{1,3}$/.test(colSpan)) element.setAttribute('colspan', colSpan);
    if (rowSpan && /^\d{1,3}$/.test(rowSpan)) element.setAttribute('rowspan', rowSpan);
  }
}
