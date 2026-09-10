import zhCN from './locales/zh-CN.json';

export type Language = 'en' | 'zh-CN';
const STORAGE_KEY = 'cos.ui.language';
const catalog: Readonly<Record<string, string>> = zhCN;
let language: Language = 'en';
try { if (window.localStorage.getItem(STORAGE_KEY) === 'zh-CN') language = 'zh-CN'; } catch { /* Storage may be unavailable in a restricted renderer. */ }

export function currentLanguage(): Language { return language; }

/** Translate only app-authored copy at explicit call sites. Arguments remain verbatim. */
export function t(source: string, args: readonly unknown[] = []): string {
  const key = Object.hasOwn(catalog, source) ? source : source.replace(/\s+/g, ' ').trim();
  const translated = language === 'zh-CN' && Object.hasOwn(catalog, key) ? catalog[key]! : source;
  return translated.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < args.length ? String(args[Number(index)]) : match);
}

type Property = 'textContent' | 'title' | 'placeholder' | 'aria-label' | 'aria-valuetext' | 'data-usage-hint';
type Binding = { read: () => string; last: string };
const bindings = new WeakMap<Node, Map<Property, Binding>>();
const nodes = new Set<WeakRef<Node>>();
let registrations = 0;

function read(node: Node, property: Property): string | null {
  return property === 'textContent' ? node.textContent : (node as Element).getAttribute(property);
}
function write(node: Node, property: Property, value: string): void {
  if (property === 'textContent') node.textContent = value;
  else (node as Element).setAttribute(property, value);
}

/** Bind the existing node, never reconstruct controls, drafts, icons or chat history. */
export function ui<T extends Node>(node: T, property: Property, value: () => string): T {
  let properties = bindings.get(node);
  if (!properties) {
    bindings.set(node, properties = new Map());
    nodes.add(new WeakRef(node));
    // Dead DOM nodes must not accumulate during long recorded conversations.
    if (++registrations % 256 === 0) for (const ref of nodes) if (!ref.deref()) nodes.delete(ref);
  }
  const last = value();
  properties.set(property, { read: value, last });
  write(node, property, last);
  return node;
}

export function uiText(value: () => string): Text {
  return ui(document.createTextNode(''), 'textContent', value);
}

export function setLanguage(next: Language): void {
  language = next;
  try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* The current window can still change language. */ }
  document.documentElement.lang = next;
  syncLanguageControls();
  for (const ref of nodes) {
    const node = ref.deref();
    if (!node) { nodes.delete(ref); continue; }
    for (const [property, binding] of bindings.get(node) ?? []) {
      // A renderer may replace a placeholder with an authored title or an error.
      // That newer value owns the node; a language change cannot overwrite it.
      if (read(node, property) !== binding.last) { bindings.get(node)?.delete(property); continue; }
      binding.last = binding.read();
      write(node, property, binding.last);
    }
  }
}

/** Setup and settings project the same saved preference. */
function syncLanguageControls(): void {
  const select = document.getElementById('uiLanguage') as HTMLSelectElement | null;
  if (select) select.value = language;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-language]')) {
    button.setAttribute('aria-pressed', String(button.dataset.language === language));
  }
}

/** Run once on the static shell, before any user/provider content is inserted. */
export function initLanguage(): void {
  const walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const node of texts) {
    if (node.parentElement?.closest('script, style, svg, code, kbd, textarea, [translate="no"]')) continue;
    const source = node.data;
    const key = source.replace(/\s+/g, ' ').trim();
    if (Object.hasOwn(catalog, key)) ui(node, 'textContent', () => source.replace(/\S[\s\S]*\S|\S/, t(key)));
  }
  for (const node of document.querySelectorAll<HTMLElement>('[title], [placeholder], [aria-label]')) {
    for (const property of ['title', 'placeholder', 'aria-label'] as const) {
      const source = node.getAttribute(property);
      if (source && Object.hasOwn(catalog, source)) ui(node, property, () => t(source));
    }
  }
  document.documentElement.lang = language;
  const select = document.getElementById('uiLanguage') as HTMLSelectElement;
  syncLanguageControls();
  select.addEventListener('change', () => setLanguage(select.value === 'zh-CN' ? 'zh-CN' : 'en'));
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-language]')) {
    button.addEventListener('click', () => setLanguage(button.dataset.language === 'zh-CN' ? 'zh-CN' : 'en'));
  }
}
