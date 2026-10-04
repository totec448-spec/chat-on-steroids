import zhCN from './locales/zh-CN.json';
import es from './locales/es.json';
import zhTW from './locales/zh-TW.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import tr from './locales/tr.json';
import fr from './locales/fr.json';
import ptPT from './locales/pt-PT.json';
import ptBR from './locales/pt-BR.json';
import de from './locales/de.json';
import ru from './locales/ru.json';
import vi from './locales/vi.json';

export type Language = 'en' | 'es' | 'zh-CN' | 'zh-TW' | 'ja' | 'ko' | 'tr' | 'vi' | 'fr' | 'pt-PT' | 'pt-BR' | 'de' | 'ru';
const STORAGE_KEY = 'cos.ui.language';
type Catalog = Readonly<Record<string, string>>;
const catalogs: Readonly<Record<Exclude<Language, 'en'>, Catalog>> = { es, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko, tr, vi, fr, 'pt-PT': ptPT, 'pt-BR': ptBR, de, ru };
const sourceKeys = new Set(Object.values(catalogs).flatMap(catalog => Object.keys(catalog)));

function parseLanguage(value: string | null | undefined): Language {
  return value === 'es' || value === 'zh-CN' || value === 'zh-TW' || value === 'ja' || value === 'ko' || value === 'tr' || value === 'vi' || value === 'fr' || value === 'pt-PT' || value === 'pt-BR' || value === 'de' || value === 'ru' ? value : 'en';
}

/**
 * The first of the system's preferred languages that the app speaks, else English. Only a first start
 * uses it: once someone picks a language, the saved choice wins. Before this, a German Windows opened
 * Setup in English with nothing on screen saying the app speaks German.
 */
export function systemLanguage(preferred: readonly string[]): Language {
  for (const raw of preferred) {
    const tag = String(raw).toLowerCase();
    const [base] = tag.split('-');
    if (base === 'zh') return /-(hant|tw|hk|mo)\b/.test(tag) ? 'zh-TW' : 'zh-CN';
    if (base === 'pt') return /^pt-pt\b/.test(tag) ? 'pt-PT' : 'pt-BR';
    if (base === 'en' || base === 'es' || base === 'ja' || base === 'ko' || base === 'tr' || base === 'vi' || base === 'fr' || base === 'de' || base === 'ru') return base;
  }
  return 'en';
}

function systemPreferred(): readonly string[] {
  try { return window.navigator.languages?.length ? window.navigator.languages : [window.navigator.language]; }
  catch { return []; }
}

let language: Language = 'en';
try {
  const saved = window.localStorage.getItem(STORAGE_KEY);
  language = saved === null ? systemLanguage(systemPreferred()) : parseLanguage(saved);
} catch { /* Storage may be unavailable in a restricted renderer; follow the system as on a first start. */
  language = systemLanguage(systemPreferred());
}

export function currentLanguage(): Language { return language; }

const languageListeners = new Set<() => void>();
/** Runs after each language change, for copy that leaves this document (#855). */
export function onLanguageChange(listener: () => void): () => void {
  languageListeners.add(listener);
  return () => { languageListeners.delete(listener); };
}

/** Translate only app-authored copy at explicit call sites. Arguments remain verbatim. */
export function t(source: string, args: readonly unknown[] = []): string {
  const catalog = language === 'en' ? undefined : catalogs[language];
  const key = catalog && Object.hasOwn(catalog, source) ? source : source.replace(/\s+/g, ' ').trim();
  const translated = catalog && Object.hasOwn(catalog, key) ? catalog[key]! : source;
  return translated.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < args.length ? String(args[Number(index)]) : match);
}

type Property = 'textContent' | 'title' | 'placeholder' | 'aria-label' | 'aria-valuetext' | 'data-usage-hint';
type Binding = { read: () => string; last: string };
const bindings = new WeakMap<Node, Map<Property, Binding>>();

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
  for (const listener of languageListeners) {
    try { listener(); } catch { /* One listener cannot block the repaint below. */ }
  }
  // The document owns the live labels, including hidden settings and collapsed
  // history. Do not index every label ever created: sweeping WeakRefs during
  // rendering keeps their detached DOM trees alive until the job ends and makes
  // each repaint revisit accumulated history. Bindings alone do not retain nodes.
  const walker = document.createTreeWalker(document.body, 1 | 4 /* elements + text */);
  do {
    const node = walker.currentNode;
    for (const [property, binding] of bindings.get(node) ?? []) {
      // A renderer may replace a placeholder with an authored title or an error.
      // That newer value owns the node; a language change cannot overwrite it.
      if (read(node, property) !== binding.last) { bindings.get(node)?.delete(property); continue; }
      binding.last = binding.read();
      write(node, property, binding.last);
    }
  } while (walker.nextNode());
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
    if (sourceKeys.has(key)) ui(node, 'textContent', () => source.replace(/\S[\s\S]*\S|\S/, t(key)));
  }
  for (const node of document.querySelectorAll<HTMLElement>('[title], [placeholder], [aria-label]')) {
    if (node.closest('[translate="no"]')) continue;
    for (const property of ['title', 'placeholder', 'aria-label'] as const) {
      const source = node.getAttribute(property);
      if (source && sourceKeys.has(source)) ui(node, property, () => t(source));
    }
  }
  document.documentElement.lang = language;
  const select = document.getElementById('uiLanguage') as HTMLSelectElement;
  syncLanguageControls();
  select.addEventListener('change', () => setLanguage(parseLanguage(select.value)));
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-language]')) {
    button.addEventListener('click', () => setLanguage(parseLanguage(button.dataset.language)));
  }
}
