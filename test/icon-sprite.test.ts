import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
const sprite = html.slice(html.indexOf('<svg class="sprite"'), html.indexOf('</defs>'));
const defined = new Set([...sprite.matchAll(/<g id="(i-[a-z0-9-]+)"/g)].map(match => match[1]));

it('resolves every icon the renderer names to one sprite symbol', () => {
  const renderer = new URL('../src/renderer/', import.meta.url);
  const used = new Set([...html.matchAll(/href="#(i-[a-z0-9-]+)"/g)].map(match => match[1]));
  for (const file of readdirSync(renderer).filter(name => name.endsWith('.ts'))) {
    for (const match of readFileSync(new URL(file, renderer), 'utf8').matchAll(/['"`](i-[a-z0-9-]+)['"`]/g)) used.add(match[1]);
  }
  expect([...used].filter(name => !defined.has(name))).toEqual([]);
});

it('draws the Phosphor symbols on the shared 24-unit grid with the theme colour', () => {
  // Phosphor paths are 256 units wide and filled; every other attribute would fight the .ico stroke.
  const groups = [...sprite.matchAll(/<g id="(i-[a-z0-9-]+)"([^>]*)>/g)].filter(([, id]) => id !== 'i-mark');
  expect(groups.length).toBeGreaterThanOrEqual(46);
  for (const [, id, attributes] of groups) {
    expect(attributes, id).toContain('fill="currentColor"');
    expect(attributes, id).toContain('stroke="none"');
    expect(attributes, id).toMatch(/0\.09375/);
  }
});
