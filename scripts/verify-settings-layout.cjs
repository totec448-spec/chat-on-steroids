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
      for (const page of ['home', 'general', 'appearance', 'usage', 'setup', 'chat', 'activity']) {
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
          // Every section-head button stays readable in both states: Read-only on used to paint its
          // label in the same color as its inverted background (#1039), an empty white or black pill.
          const contrast = await js(`(() => {
            const rgb = value => (value.match(/[\\d.]+/g) || []).map(Number);
            const lum = ([r, g, b]) => { const c = [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
              return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
            const background = el => { for (let node = el; node; node = node.parentElement) {
              const c = rgb(getComputedStyle(node).backgroundColor); if (c.length >= 3 && (c[3] ?? 1) > 0.5) return c; } return [255, 255, 255]; };
            const ratio = el => { const a = lum(rgb(getComputedStyle(el).color)), b = lum(background(el)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
            const readOnly = document.getElementById('readOnlyBtn'), out = [];
            for (const on of [false, true]) {
              readOnly.classList.toggle('is-on', on);
              // Colors are read after their transition; a mid-fade read would see the old background.
              for (const animation of document.getAnimations()) animation.finish();
              for (const button of document.querySelectorAll('.settings-section-head .btn')) {
                if (!button.checkVisibility() || !button.textContent.trim()) continue;
                const value = ratio(button);
                if (value < 4.5) out.push((button.id || button.textContent.trim()) + (on ? ' (Read-only on)' : '') + ': ' + value.toFixed(2));
              }
            }
            readOnly.classList.remove('is-on');
            return out;
          })()`);
          assert.deepEqual(contrast, [], `Unreadable section-head buttons (${theme}, ${width}px, zoom ${zoom})`);
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
          if (page === 'chat' && width === 1440) {
            const autoSkill = await js(`(() => {
              const input = document.getElementById('autoSelectSkills');
              input.scrollIntoView({ block: 'center' });
              const row = input.closest('.setting'), rect = row.getBoundingClientRect();
              return {
                visible: row.checkVisibility(),
                inside: rect.top >= 0 && rect.bottom <= innerHeight,
                label: row.textContent
              };
            })()`);
            assert.equal(autoSkill.visible, true, 'Auto-select Skills must be visible in General settings');
            assert.equal(autoSkill.inside, true, 'Auto-select Skills must fit inside the visible settings viewport');
            assert.match(autoSkill.label, /Auto-select Skills/);
            assert.match(autoSkill.label, /exact name in the message, not by topic/);
            await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
            fs.writeFileSync(path.join(output, `${theme}-auto-select-skills.png`), (await win.webContents.capturePage()).toPNG());
          }
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
    // Optical alignment, measured on real pixels: a box can be centered while its glyph is not.
    // Insets are CSS px from the element's inner edges to the first drawn pixel on each side.
    const inkInsets = async element => {
      // Settings scroll smoothly; the rect is read only after an instant scroll has landed.
      await js(`${element}.scrollIntoView({ block: 'center', behavior: 'instant' })`);
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const box = await js(`(() => { const el = ${element}, r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return { x: r.left, y: r.top, width: r.width, height: r.height, border: parseFloat(s.borderTopWidth) || 0,
          round: parseFloat(s.borderTopLeftRadius) >= r.width / 2 - 1 }; })()`);
      const rect = { x: Math.floor(box.x), y: Math.floor(box.y) };
      rect.width = Math.ceil(box.x + box.width) - rect.x; rect.height = Math.ceil(box.y + box.height) - rect.y;
      const image = await win.webContents.capturePage(rect);
      // The capture is in device pixels while its reported scale factor can stay 1.
      const { width, height } = image.getSize(), bitmap = image.toBitmap(), scale = width / rect.width;
      const at = (x, y) => { const i = (y * width + x) * 4; return [bitmap[i], bitmap[i + 1], bitmap[i + 2]]; };
      // Inside the border; a round element is read inside its circle so the edge never counts as ink.
      const left = (box.x - rect.x + box.border + 1) * scale, top = (box.y - rect.y + box.border + 1) * scale;
      const right = (box.x - rect.x + box.width - box.border - 1) * scale, bottom = (box.y - rect.y + box.height - box.border - 1) * scale;
      const cx = (left + right) / 2, cy = (top + bottom) / 2, radius = (right - left) / 2;
      const inside = (x, y) => !box.round || (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= radius ** 2;
      const counts = new Map();
      for (let y = Math.ceil(top); y < bottom; y++) for (let x = Math.ceil(left); x < right; x++) if (inside(x, y)) {
        const key = at(x, y).join(); counts.set(key, (counts.get(key) || 0) + 1);
      }
      const fill = [...counts].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
      const diff = (x, y) => at(x, y).reduce((sum, value, i) => sum + Math.abs(value - fill[i]), 0);
      let strongest = 0;
      for (let y = Math.ceil(top); y < bottom; y++) for (let x = Math.ceil(left); x < right; x++) if (inside(x, y)) strongest = Math.max(strongest, diff(x, y));
      const threshold = Math.max(36, strongest * 0.4), ink = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      for (let y = Math.ceil(top); y < bottom; y++) for (let x = Math.ceil(left); x < right; x++) if (inside(x, y) && diff(x, y) > threshold) {
        ink.left = Math.min(ink.left, x); ink.right = Math.max(ink.right, x + 1); ink.top = Math.min(ink.top, y); ink.bottom = Math.max(ink.bottom, y + 1);
      }
      assert.ok(Number.isFinite(ink.left), 'Something is drawn in ' + element);
      return { left: (ink.left - left) / scale, right: (right - ink.right) / scale, top: (ink.top - top) / scale, bottom: (bottom - ink.bottom) / scale };
    };
    const showPage = page => js(`(() => {
      for (const panel of document.querySelectorAll('.panel')) panel.classList.toggle('is-active', panel.dataset.panel === '${page}');
      for (const view of document.querySelectorAll('[data-view]')) view.hidden = view.dataset.view !== 'settings';
      for (const animation of document.getAnimations()) if (Number.isFinite(animation.effect.getComputedTiming().endTime)) animation.finish();
    })()`);
    const offCenter = [];
    win.setSize(1440, 950); win.webContents.setZoomFactor(1);
    for (const theme of ['dark', 'light']) {
      await js(`document.documentElement.dataset.theme = '${theme}'`);
      // Every Setup step's check mark, done and ready; the green marks once sat low and right.
      await showPage('setup');
      await js(`document.querySelectorAll('.setup-rail li').forEach(li => { li.classList.add('is-done'); li.classList.remove('is-current'); })`);
      const marks = await js(`document.querySelectorAll('.setup-rail-mark').length`);
      assert.ok(marks >= 7, 'All Setup steps are on the rail');
      for (let index = 0; index < marks; index++) {
        const ink = await inkInsets(`document.querySelectorAll('.setup-rail-mark')[${index}]`);
        // At 1x a device pixel is a whole CSS pixel, so snapping alone can leave 1 px; the bug was 2.5–3.7 px.
        if (Math.abs(ink.left - ink.right) > 1.5 || Math.abs(ink.top - ink.bottom) > 1.5) offCenter.push({ theme, element: `.setup-rail-mark #${index + 1}`, ink });
      }
      await js(`document.querySelectorAll('.setup-rail li').forEach(li => li.classList.remove('is-done'))`);
      // Every other round badge that holds only an icon, on every settings page.
      for (const page of ['home', 'general', 'appearance', 'usage', 'setup', 'activity']) {
        await showPage(page);
        const count = await js(`(window.iconBadges = [...document.querySelector('[data-panel="${page}"]').querySelectorAll('*')].filter(el => {
          if (el.closest('.setup-rail') || !el.checkVisibility() || el.textContent.trim()) return false;
          const r = el.getBoundingClientRect(), s = getComputedStyle(el);
          return r.width >= 14 && r.width <= 72 && Math.abs(r.width - r.height) < 1 && parseFloat(s.borderTopLeftRadius) >= r.width / 2 - 1
            && (s.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(s.borderTopWidth) > 0) && !!el.querySelector('.ph, svg');
        })).length`);
        for (let index = 0; index < count; index++) {
          const ink = await inkInsets(`window.iconBadges[${index}]`);
          if (Math.abs(ink.left - ink.right) > 1.5 || Math.abs(ink.top - ink.bottom) > 1.5)
            offCenter.push({ theme, page, element: await js(`window.iconBadges[${index}].className`), ink });
        }
      }
      // Health: the two figures sit as far from the card's top edge as from the divider below them.
      await showPage('home');
      await js(`document.getElementById('bigHandshake').textContent = '20s'; document.getElementById('bigRequest').textContent = '4h'`);
      const health = await inkInsets(`document.querySelector('.workspace-health .big')`);
      if (Math.abs(health.top - health.bottom) > 2) offCenter.push({ theme, element: 'Health figures', ink: health });
    }
    assert.deepEqual(offCenter, [], 'Glyphs and figures sit optically centered: ' + JSON.stringify(offCenter));
    console.log('Settings layout passed: six pages, two themes, two widths, two zooms, live Usage renderer and long folder paths, centered marks.');
  } finally { win.destroy(); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
