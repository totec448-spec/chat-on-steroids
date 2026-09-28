import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../src/renderer/index.html');
const iconsCss = read('../src/renderer/icons.css');
const dom = read('../src/renderer/dom.ts');
const vocabulary = new Map([...dom.matchAll(/'(i-[a-z0-9-]+)': '([^']+)'/g)].map(match => [match[1]!, match[2]!]));
const packageCss = (family: 'regular' | 'fill') =>
  readFileSync(createRequire(import.meta.url).resolve(`@phosphor-icons/web/${family}`), 'utf8');
const codepoints = (css: string, family: string) => new Map([...css.matchAll(
  new RegExp(String.raw`\.${family}\.ph-([a-z0-9-]+):{1,2}before\s*\{\s*content:\s*["']\\([0-9a-f]+)["']`, 'g')
)].map(match => [match[1]!, match[2]!]));

/** Every glyph the renderer can draw, as `family:name`. */
function drawnGlyphs(): Set<string> {
  const glyphs = new Set<string>();
  for (const value of vocabulary.values()) {
    glyphs.add(value.startsWith('fill:') ? `ph-fill:${value.slice(5)}` : `ph:${value.split(' ')[0]}`);
  }
  for (const [, family, name] of html.matchAll(/class="[^"]*\b(ph|ph-fill) ph-([a-z0-9-]+)/g)) glyphs.add(`${family}:${name}`);
  return glyphs;
}

it('resolves every icon name the renderer uses through the one vocabulary in dom.ts', () => {
  const renderer = new URL('../src/renderer/', import.meta.url);
  const used = new Set<string>();
  for (const file of readdirSync(renderer).filter(name => name.endsWith('.ts'))) {
    for (const match of readFileSync(new URL(file, renderer), 'utf8').matchAll(/['"`](i-[a-z0-9-]+)['"`]/g)) used.add(match[1]!);
  }
  expect(used.size).toBeGreaterThan(30);
  expect([...used].filter(name => !vocabulary.has(name))).toEqual([]);
});

it('maps exactly the glyphs the renderer draws, at the codepoints the bundled Phosphor font defines', () => {
  const mapped = new Map([
    ...[...codepoints(iconsCss, 'ph')].map(([name, point]) => [`ph:${name}`, point] as const),
    ...[...codepoints(iconsCss, 'ph-fill')].map(([name, point]) => [`ph-fill:${name}`, point] as const)
  ]);
  expect([...drawnGlyphs()].sort()).toEqual([...mapped.keys()].sort());
  // A package update may renumber glyphs; the copy here must follow the package, not memory.
  const official = { ph: codepoints(packageCss('regular'), 'ph'), 'ph-fill': codepoints(packageCss('fill'), 'ph-fill') };
  expect(official.ph.size).toBeGreaterThan(1000);
  for (const [key, point] of mapped) {
    const [family, name] = key.split(':') as ['ph' | 'ph-fill', string];
    expect(point, key).toBe(official[family].get(name));
  }
});

it('draws every interface icon with the font instead of a hand-drawn SVG', () => {
  // Allowed SVG: the sprite, the product mark, language flags, the context ring, and the one authored
  // disclosure chevron, which must rotate around its drawn centre (a font caret sits on a baseline).
  for (const [, tag, rest] of html.matchAll(/(<svg\b[^>]*>)([\s\S]{0,80})/g)) {
    const allowed = /class="(sprite|language-flag|disclosure-chevron\b[^"]*)"/.test(tag!) || /^<use href="#i-mark"/.test(rest!) ||
      /^<circle class="context-track"/.test(rest!.trim());
    expect(allowed, tag).toBe(true);
  }
  const renderer = new URL('../src/renderer/', import.meta.url);
  const drawing = readdirSync(renderer).filter(name => name.endsWith('.ts') &&
    readFileSync(new URL(name, renderer), 'utf8').includes("createElementNS('http://www.w3.org/2000/svg', 'svg')"));
  // dom.ts draws the disclosure chevron; the setup guide draws a connector line across its screenshot.
  expect(drawing).toEqual(['dom.ts', 'setup-guide.ts']);
});

it('keeps only the bespoke product mark in the inline sprite', () => {
  const sprite = html.slice(html.indexOf('<svg class="sprite"'), html.indexOf('</defs>'));
  expect([...sprite.matchAll(/<g id="(i-[a-z0-9-]+)"/g)].map(match => match[1])).toEqual(['i-mark']);
  expect([...new Set([...html.matchAll(/href="#(i-[a-z0-9-]+)"/g)].map(match => match[1]))]).toEqual(['i-mark']);
  expect(html).toContain('href="./icons.css"');
});
