// Run after npm run build. Isolated production markup/styles, real Usage renderer;
// permission and connector rows below are explicit layout fixtures, not live settings.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/settings-layout');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  const { build } = await import('vite');
  const bundle = await build({ configFile: false, logLevel: 'silent', build: { write: false,
    lib: { entry: path.join(root, 'src/renderer/usage.ts'), name: 'usageFixture', formats: ['iife'] } } });
  const code = (Array.isArray(bundle) ? bundle[0] : bundle).output.find(item => item.type === 'chunk').code;
  const html = fs.readFileSync(path.join(root, 'out/renderer/index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'out/renderer/')).href}">`);
  const file = path.join(output, 'fixture.html'); fs.writeFileSync(file, html);
  const win = new BrowserWindow({ show: false, width: 1440, height: 950,
    webPreferences: { sandbox: true, backgroundThrottling: false } });
  try {
    await win.loadFile(file);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('DOM.enable');
    await win.webContents.debugger.sendCommand('CSS.enable');
    const js = script => win.webContents.executeJavaScript(script);
    await js(code);
    await js(`(() => {
      const models = [{ model: 'gpt-6-astra', reasoningEffort: 'high', assumed: false, tokens: 1200000 }];
      const data = { contextTokenCap: 533333, tokens: 1200000, sessions: 24, models,
        days: [{ date: new Date().toISOString().slice(0, 10), tokens: 1200000, models }],
        messages: { through: Date.now(), days: [] }, limits: [{ model: 'gpt-6-astra', scope: 'model',
          remaining: 12345, remainingPercent: 75, resetAt: Date.now() + 86400000,
          windowSeconds: 604800, observedAt: Date.now() }] };
      window.api = { getUsage: async () => ({ ok: true, data }) };
      usageFixture.initUsage();
      document.querySelector('.app').dataset.screen = 'settings';
      for (const selector of ['.sidebar-brand', '#sidebarPrimary', '.sidebar-sessions', '#newChat']) document.querySelector(selector).hidden = true;
      for (const id of ['tabs', 'backToChat']) document.getElementById(id).hidden = false;
      document.getElementById('rootsEmpty').hidden = true;
      const row = document.createElement('div'); row.className = 'root';
      row.innerHTML = '<i class="ico ph ph-folder"></i><b></b><span></span><button class="btn">Rename</button><button class="btn">Remove</button>';
      row.querySelector('b').textContent = 'project-with-a-very-long-name-'.repeat(8);
      row.querySelector('span').textContent = 'C:/long-folder/'.repeat(50);
      document.getElementById('rootList').append(row);
    })()`);
    await js('usageFixture.refreshUsage()');
    await js(`(() => {
      const groups = document.getElementById('groups');
      for (const [glyph, title] of [['eye', 'Look at files'], ['pencil-simple', 'Change files'],
        ['monitor', 'Browser and desktop control'], ['terminal-window', 'Run programs'], ['robot', 'Sub-agents']]) {
        const row = document.createElement('div'); row.className = 'perm is-on';
        row.innerHTML = '<div class="perm-head"><button class="perm-main" type="button"><svg class="disclosure-chevron ico chev" viewBox="0 0 16 16"><path d="M6 3.5 10.5 8 6 12.5"></path></svg><i class="ico ph ph-' + glyph + '"></i><span><b>' + title + '</b><em class="group-count">Enabled</em></span></button><span class="sw"><input type="checkbox" checked aria-label="' + title + '"><i></i></span></div>';
        groups.append(row);
      }
      for (const name of ['Core', 'Desktop', 'Plugins']) {
        const row = document.createElement('div'); row.className = 'connector';
        row.innerHTML = '<div class="connector-head"><h4>' + name + '</h4></div><div class="field"><label>Name</label><div class="row-inline"><input type="text" readonly value="Chat On Steroids ' + name + '"><button class="btn">Copy</button></div></div>';
        document.getElementById('connectorCards').append(row);
      }
      const menu = document.getElementById('setupProfileMenu');
      for (const name of ['Default', 'A long profile name that must wrap without losing the delete button']) {
        const row = document.createElement('div'); row.className = 'setup-profile-option';
        const choose = document.createElement('button'); choose.className = 'btn'; choose.textContent = name;
        choose.setAttribute('aria-pressed', String(name === 'Default'));
        const remove = document.createElement('button'); remove.className = 'btn';
        remove.innerHTML = '<i class="ico ph ph-trash"></i>'; remove.setAttribute('aria-label', 'Delete profile');
        row.append(choose, remove); menu.append(row);
      }
    })()`);
    const failures = [];
    for (const theme of ['dark', 'light']) for (const width of [900, 1440]) for (const zoom of [1, 1.25]) {
      win.setSize(width, 950); win.webContents.setZoomFactor(zoom);
      await js(`document.documentElement.dataset.theme = '${theme}'`);
      for (const page of ['home', 'appearance', 'usage', 'setup', 'chat', 'activity']) {
        const result = await js(`(async () => {
          for (const panel of document.querySelectorAll('.panel')) panel.classList.toggle('is-active', panel.dataset.panel === '${page}');
          for (const button of document.querySelectorAll('#tabs button')) button.classList.toggle('is-sel', button.dataset.tab === ('${page}' === 'chat' ? 'settings' : '${page}'));
          for (const view of document.querySelectorAll('[data-view]')) view.hidden = view.dataset.view !== 'settings';
          // Real openChatView hides the composer for settings; this fixture has no chat runtime.
          document.getElementById('composer').hidden = true;
          const panel = document.querySelector('[data-panel="${page}"]'); panel.scrollTop = 0;
          // Layout checks measure settled geometry; hidden Chromium windows may throttle time.
          for (const animation of document.getAnimations()) if (Number.isFinite(animation.effect.getComputedTiming().endTime)) animation.finish();
          const overflows = [...panel.querySelectorAll('.settings-page-content, .settings-surface, .pane')]
            .filter(el => el.checkVisibility() && !['auto', 'scroll'].includes(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1)
            .map(el => el.id || el.className);
          const grid = document.querySelector('.heat-grid');
          return { overflows, pageOverflow: panel.scrollWidth > panel.clientWidth + 1,
            heatColumns: '${page}' === 'usage' ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : null,
            heatHeight: '${page}' === 'usage' ? grid.getBoundingClientRect().height : null };
        })()`);
        if (result.pageOverflow || result.overflows.length || (page === 'usage' && (result.heatColumns !== 53 || result.heatHeight < 70))) failures.push({ theme, width, zoom, page, ...result });
        if (page === 'home') {
          const emptySpacing = await js(`(() => {
            const empty = document.getElementById('rootsEmpty'); empty.hidden = false;
            const style = getComputedStyle(empty);
            const padding = [style.paddingTop, style.paddingBottom]; empty.hidden = true;
            return padding;
          })()`);
          assert.deepEqual(emptySpacing, ['10px', '10px']);
          const corners = await js(`(() => {
            const surface = document.querySelector('.workspace-permissions .settings-surface');
            surface.scrollIntoView({block: 'center'});
            const r = surface.getBoundingClientRect();
            return { overflow: getComputedStyle(surface).overflow,
              cornerHitsRow: !!document.elementFromPoint(r.left + 2, r.top + 2)?.closest('.perm-head'),
              centerHitsRow: !!document.elementFromPoint(r.left + 60, r.top + 20)?.closest('.perm-head') };
          })()`);
          assert.equal(corners.overflow, 'hidden');
          assert.equal(corners.cornerHitsRow, false, 'Hover must not paint outside the rounded corner');
          assert.equal(corners.centerHitsRow, true, 'Clipping must preserve the row hit target');
        }
        if (page === 'appearance') {
          const profile = await js(`(() => {
            document.getElementById('setupProfile').scrollIntoView({block: 'center'});
            const menu = document.getElementById('setupProfileMenu'); menu.showPopover();
            const r = menu.getBoundingClientRect();
            return { inside: r.left >= 0 && r.right <= innerWidth,
              overflow: menu.scrollWidth > menu.clientWidth + 1,
              rows: Array.from(menu.children, row => {
                const a = row.firstElementChild.getBoundingClientRect(), b = row.lastElementChild.getBoundingClientRect();
                return a.width > 100 && a.right <= b.left && b.right <= r.right && b.width >= 29;
              }) };
          })()`);
          assert.deepEqual(profile, { inside: true, overflow: false, rows: [true, true] });
          await js(`document.getElementById('setupProfileMenu').hidePopover()`);
        }
        if (page === 'setup') {
          const borders = await js(`Array.from(document.querySelectorAll('#connectorCards > .connector'), el => {
            const s = getComputedStyle(el); return [s.borderTopWidth, s.borderRightWidth, s.borderRadius];
          })`);
          assert.deepEqual(borders[0], ['0px', '0px', '0px']);
          for (const [top, right, radius] of borders.slice(1)) {
            assert.ok(parseFloat(top) > 0 && parseFloat(top) <= 1, 'One device-snapped divider');
            assert.equal(right, '0px'); assert.equal(radius, '0px');
          }
        }
        if (zoom === 1) {
          await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
          fs.writeFileSync(path.join(output, `${theme}-${width}-${page}.png`), (await win.webContents.capturePage()).toPNG());
          if (page === 'home') {
            const { root: doc } = await win.webContents.debugger.sendCommand('DOM.getDocument');
            for (const [label, selector] of [['first', '.perm:first-child .perm-head'], ['last', '.perm:last-child .perm-head']]) {
              const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: doc.nodeId, selector });
              await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
              await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
              fs.writeFileSync(path.join(output, `${theme}-${width}-hover-${label}.png`), (await win.webContents.capturePage()).toPNG());
              await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
            }
          }
        }
      }
    }
    assert.deepEqual(failures, []);
    // Agents & automation shares the chat host. Exercise real dock layout classes,
    // including expanded/narrow/closing states, without starting a terminal process.
    for (const width of [760, 1440]) {
      win.setSize(width, 950); win.webContents.setZoomFactor(1);
      const dockChecks = await js(`(() => {
        const app = document.querySelector('.app');
        const host = document.querySelector('[data-panel="chat"]');
        document.querySelectorAll('.panel').forEach(p => p.classList.toggle('is-active', p === host));
        const card = host.querySelector('.is-session');
        const right = document.createElement('aside'); right.className = 'work-dock work-dock-right';
        const bottom = document.createElement('section'); bottom.className = 'work-dock work-dock-bottom';
        const resize = document.createElement('div'); resize.className = 'work-panel-resize';
        right.append(resize); host.append(right); app.append(bottom);
        host.classList.add('has-work-dock'); app.classList.add('has-bottom-dock');
        const results = [];
        for (const expanded of [false, true]) for (const closing of [false, true]) {
          host.classList.toggle('is-work-dock-expanded', expanded);
          for (const dock of [right, bottom]) { dock.hidden = closing; dock.classList.toggle('is-closing', closing); }
          app.dataset.screen = 'settings';
          const fullWidth = Math.abs(card.getBoundingClientRect().width - host.getBoundingClientRect().width) < 2;
          const hidden = !right.checkVisibility() && !bottom.checkVisibility() && !resize.checkVisibility();
          const contentVisible = card.checkVisibility();
          app.dataset.screen = 'chat';
          const restored = right.checkVisibility() && bottom.checkVisibility()
            && host.classList.contains('has-work-dock')
            && host.classList.contains('is-work-dock-expanded') === expanded;
          results.push({ fullWidth, hidden, contentVisible, restored });
        }
        right.remove(); bottom.remove(); host.classList.remove('has-work-dock', 'is-work-dock-expanded');
        app.classList.remove('has-bottom-dock'); app.dataset.screen = 'settings';
        return results;
      })()`);
      for (const result of dockChecks) assert.deepEqual(result, { fullWidth: true, hidden: true, contentVisible: true, restored: true });
    }
    console.log('Settings layout passed: six pages, two themes, two widths, two zooms, live Usage renderer and long folder paths.');
  } finally { win.destroy(); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
