// Run after npm run build. axe-core (WCAG 2 A/AA) over the production markup and styles: every
// settings page and the chat screen, both themes, with stateful controls off and on. Our own
// layout checks only measured the default state, so the Read-only button could ship as an empty
// pill whenever it was on (#1039). Isolated fixture: no runtime, tunnel, credentials or user data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/accessibility');
app.setPath('userData', path.join(output, 'runtime'));

/** Pages as the settings tabs name them; `chat` is the chat screen itself. */
const PAGES = ['home', 'general', 'usage', 'setup', 'settings', 'appearance', 'activity', 'chat'];
/**
 * Known findings, each with its reason. Anything not listed here fails the check, so a new
 * unlabeled control or unreadable text cannot ship unnoticed.
 */
const KNOWN = [
  // sidebar-resize.ts render() sets aria-valuenow/min/max at runtime; this fixture has no runtime.
  { id: 'aria-required-attr', target: '#sidebarResize' },
  // The Projects/Chats <summary> hosts its add/refresh buttons. Separating them changes the sidebar
  // header design, which wants a product review first (#1039).
  { id: 'nested-interactive', target: '#projectsSection > .sidebar-session-heading' },
  { id: 'nested-interactive', target: '#chatsSection > .sidebar-session-heading' }
];

/** Controls whose look changes with their state. Each is checked off and on. */
const STATES = [{ name: 'default', on: [] }, { name: 'toggled', on: ['readOnlyBtn'] }];

app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  const html = fs.readFileSync(path.join(root, 'out/renderer/index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'out/renderer/')).href}">`);
  const file = path.join(output, 'fixture.html'); fs.writeFileSync(file, html);
  const axe = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, backgroundThrottling: false } });
  const report = [];
  try {
    await win.loadFile(file);
    const js = script => win.webContents.executeJavaScript(script);
    await js(axe);
    for (const theme of ['dark', 'light']) for (const state of STATES) for (const page of PAGES) {
      const result = await js(`(async () => {
        document.documentElement.dataset.theme = ${JSON.stringify(theme)};
        const app = document.querySelector('.app');
        const chat = ${JSON.stringify(page)} === 'chat';
        app.dataset.screen = chat ? 'chat' : 'settings';
        for (const s of ['.sidebar-brand', '#sidebarPrimary', '.sidebar-sessions', '#newChat']) document.querySelector(s).hidden = !chat;
        for (const id of ['tabs', 'backToChat']) document.getElementById(id).hidden = chat;
        const target = ${JSON.stringify(page)} === 'settings' || chat ? 'chat' : ${JSON.stringify(page)};
        for (const p of document.querySelectorAll('.panel')) p.classList.toggle('is-active', p.dataset.panel === target);
        for (const v of document.querySelectorAll('[data-view]')) v.hidden = v.dataset.view !== (chat ? 'chat' : 'settings');
        document.getElementById('composer').hidden = !chat;
        for (const id of ${JSON.stringify(STATES.flatMap(item => item.on))}) document.getElementById(id)?.classList.remove('is-on');
        for (const id of ${JSON.stringify(state.on)}) { const el = document.getElementById(id); el?.classList.add('is-on'); el?.setAttribute('aria-pressed', 'true'); }
        // Flush styles so state changes have started their transitions, then settle them: axe must
        // see the final colors, not the first frame of a fade (which hid the Read-only bug).
        for (const el of document.querySelectorAll('.btn, .setting, .panel')) void getComputedStyle(el).backgroundColor;
        for (const animation of document.getAnimations()) animation.finish();
        const scope = chat ? document.querySelector('.app') : document.querySelector('.panel.is-active');
        const run = await axe.run(scope, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations', 'incomplete'] });
        // axe files text at exactly 1:1 contrast as "incomplete", assuming it is hidden on purpose. Here it is
        // the Read-only bug's signature (label painted in its own background color), so it counts as a failure.
        const invisible = run.incomplete.filter(v => v.id === 'color-contrast')
          .map(v => ({ ...v, id: 'invisible-text', impact: 'serious', help: 'Text has the same color as its background',
            nodes: v.nodes.filter(n => (n.any || []).some(check => String(check.message).includes(' 1:1 contrast'))) }))
          .filter(v => v.nodes.length);
        return [...run.violations, ...invisible].map(v => ({ id: v.id, impact: v.impact, help: v.help,
          nodes: v.nodes.map(n => ({ target: n.target.join(' '), summary: (n.failureSummary || '').split('\\n').slice(1, 2).join(' ').trim() })) }));
      })()`);
      for (const violation of result) report.push({ theme, state: state.name, page, ...violation });
    }
  } finally { win.destroy(); }
  fs.writeFileSync(path.join(output, 'violations.json'), JSON.stringify(report, null, 2));
  const unique = new Map();
  for (const item of report) for (const node of item.nodes.filter(node => !KNOWN.some(known => known.id === item.id && known.target === node.target))) {
    const key = `${item.id} ${node.target}`;
    if (!unique.has(key)) unique.set(key, { id: item.id, impact: item.impact, target: node.target, summary: node.summary, where: new Set() });
    unique.get(key).where.add(`${item.page}/${item.theme}/${item.state}`);
  }
  for (const item of unique.values()) console.log(`${item.impact.padEnd(8)} ${item.id.padEnd(22)} ${item.target}  — ${item.summary}  [${[...item.where].slice(0, 4).join(', ')}${item.where.size > 4 ? ', …' : ''}]`);
  console.log(unique.size ? `${unique.size} distinct violation(s)` : `Accessibility passed: ${PAGES.length} screens, two themes, controls off and on (${KNOWN.length} known findings listed).`);
  app.exit(unique.size ? 1 : 0);
}).catch(error => { console.error(error); app.exit(1); });
