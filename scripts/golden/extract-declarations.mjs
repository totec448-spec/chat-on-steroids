// Extracts the tool declarations and the static instruction blocks the Rust kernel serves from
// the golden corpus, so `tools/list` and `initialize` come from what the TypeScript app sent
// rather than from hand-copied JSON.
//
//   node scripts/golden/extract-declarations.mjs            writes the file
//   node scripts/golden/extract-declarations.mjs --check    exit 1 when the file is stale
//
// Output: rust/crates/cos-tools/declarations.json. Every `tools/list` element is stored once per
// surface, in listing order, in the key order the server sent. Values that change with the
// config become placeholders (`{{roots}}`); the script fails when two variants disagree on
// anything else, so a config-dependent value it does not know about cannot slip through.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const corpus = path.join(repo, 'rust', 'golden');
const output = path.join(repo, 'rust', 'crates', 'cos-tools', 'declarations.json');

// Registration order in the TypeScript app (tools-core.ts, code-mode-tool.ts). The corpus never
// lists `session_finish` and `agents` together, so their relative order comes from here; every
// recorded list must be a subsequence of it.
const CORE_ORDER = ['read', 'view_image', 'save_image', 'find', 'apply_patch', 'exec_command', 'write_stdin',
  'update_plan', 'session_finish', 'agents', 'exec'];

// zod's uuid pattern ends with the nil and max UUIDs, which the normalizer numbered as UUIDs.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const ZOD_UUID_TAIL = '[0-9a-fA-F]{12}|<UUID:1>|<UUID:2>)$';

function fail(message) {
  console.error(`extract-declarations: ${message}`);
  process.exit(1);
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function variants() {
  return fs.readdirSync(corpus, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(corpus, entry.name, 'config.json')))
    .map(entry => entry.name)
    .sort();
}

/** The virtual roots a Core endpoint names: the user roots, then the managed `/skills`. */
function coreRoots(variant) {
  const { config } = readJson(path.join(corpus, variant, 'config.json'));
  const user = (config.roots ?? []).filter(root => root.name.toLowerCase() !== 'skills');
  return [...user.map(root => `/${root.name}`), '/skills'].join(', ');
}

function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map(item => mapStrings(item, fn));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn)]));
  }
  return value;
}

function template(tool, surface, variant) {
  let replaced = 0;
  const roots = coreRoots(variant);
  const result = mapStrings(tool, text => {
    let out = text;
    if (out.includes(ZOD_UUID_TAIL)) out = out.replace('<UUID:1>', NIL_UUID).replace('<UUID:2>', MAX_UUID);
    if (surface === 'core' && out.includes(`: ${roots}.`)) {
      out = out.replace(`: ${roots}.`, ': {{roots}}.');
      replaced++;
    }
    if (/<(?:UUID|PROJECT|SECOND|PROFILE|RUN|REPO|TMP|HOME|MCP_PORT|PORT|PID|ISO_TIME)\b/.test(out)) {
      fail(`${variant}/${surface}/${tool.name}: unresolved corpus placeholder in ${JSON.stringify(out.slice(0, 120))}`);
    }
    return out;
  });
  if (tool.name === 'read' && replaced !== 1) fail(`${variant}: read names its roots ${replaced} times, expected 1`);
  return result;
}

function isSubsequence(list, order) {
  let at = 0;
  for (const name of list) {
    at = order.indexOf(name, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

function extractTools() {
  const lists = { core: [], desktop: [], plugins: [] };
  const declarations = { core: new Map(), desktop: new Map(), plugins: new Map() };
  for (const variant of variants()) {
    for (const surface of Object.keys(lists)) {
      const file = path.join(corpus, variant, 'mcp', surface, 'tools-list.json');
      if (!fs.existsSync(file)) continue;
      const tools = readJson(file).response.messages[0].result.tools;
      lists[surface].push({ variant, names: tools.map(tool => tool.name) });
      for (const tool of tools) {
        const rendered = JSON.stringify(template(tool, surface, variant));
        const seen = declarations[surface].get(tool.name);
        if (seen && seen.json !== rendered) fail(`${surface}/${tool.name} differs between ${seen.variant} and ${variant}`);
        if (!seen) declarations[surface].set(tool.name, { json: rendered, variant });
      }
    }
  }
  const longest = surface => lists[surface].reduce((best, list) => list.names.length > best.length ? list.names : best, []);
  const orders = { core: CORE_ORDER, desktop: longest('desktop'), plugins: longest('plugins') };
  const surfaces = {};
  for (const [surface, order] of Object.entries(orders)) {
    for (const { variant, names } of lists[surface]) {
      if (!isSubsequence(names, order)) fail(`${variant}/${surface} lists ${names.join(',')} outside the order ${order.join(',')}`);
    }
    surfaces[surface] = order
      .filter(name => declarations[surface].has(name))
      .map(name => JSON.parse(declarations[surface].get(name).json));
  }
  // No variant installs a plugin, so Plugins never listed its code mode. tools-plugins.ts
  // publishes the standard `codeModeDeclaration()`, the element Core lists, after the plugins.
  if (surfaces.plugins.length > 0) fail('Plugins listed tools; take its exec from the corpus instead');
  surfaces.plugins = surfaces.core.filter(tool => tool.name === 'exec');
  return surfaces;
}

function instructionsOf(variant, surface) {
  const file = path.join(corpus, variant, 'mcp', surface, 'initialize.json');
  return readJson(file).response.messages[0].result.instructions;
}

function between(text, start, end, where) {
  const from = start === null ? 0 : text.indexOf(start);
  if (from < 0) fail(`${where}: no ${JSON.stringify(start)}`);
  const to = end === null ? text.length : text.indexOf(end, from);
  if (to < 0) fail(`${where}: no ${JSON.stringify(end)}`);
  return text.slice(from, to);
}

function extractInstructions() {
  const core = instructionsOf('base', 'core');
  const desktop = instructionsOf('base', 'desktop');
  const blocks = {
    coding: between(core, null, '\n# Installed skills\n', 'base/core'),
    codeMode: between(core, 'Code mode: use exec', null, 'base/core'),
    browser: between(desktop, null, '\n\nWindows Computer Use uses', 'base/desktop'),
    windowsDesktop: between(desktop, 'Windows Computer Use uses', '\n\nFiles, patches and shell commands live in', 'base/desktop')
  };
  for (const variant of variants()) {
    const file = path.join(corpus, variant, 'mcp', 'core', 'initialize.json');
    if (!fs.existsSync(file)) continue;
    const text = instructionsOf(variant, 'core');
    if (!text.startsWith(blocks.coding) || !text.endsWith(`\n\n${blocks.codeMode}`)) {
      fail(`${variant}/core instructions do not start with the coding block and end with code mode`);
    }
  }
  return blocks;
}

const rendered = `${JSON.stringify({
  source: 'Extracted from rust/golden by scripts/golden/extract-declarations.mjs. Do not edit by hand.',
  instructions: extractInstructions(),
  surfaces: extractTools()
}, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '';
  if (current !== rendered) fail(`${path.relative(repo, output)} is stale; rerun without --check`);
  console.log('declarations are current');
} else {
  fs.writeFileSync(output, rendered);
  console.log(`wrote ${path.relative(repo, output)}`);
}
