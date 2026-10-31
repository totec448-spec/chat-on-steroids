// Real renderer with synthetic data only. Never connects to the installed app or ChatGPT.
// Phone notifications in Settings → General: with the options open, the text fields share one left
// and one right edge, every switch and choice sits on the card's right edge, nothing is cut, and the
// buttons and choices stay on one line, in every language, narrow and zoomed too.
const { withoutScripts } = require('./ui-check-page.cjs');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const root = path.join(__dirname, '..'), output = path.join(root, 'outputs/phone-push');
  fs.mkdirSync(output, { recursive: true });
  const code = (await require('esbuild').build({ stdin: { contents: `
      export { initPhonePushSettings, applyPhonePush } from './src/renderer/phone-push-settings.ts';
      export { setLanguage, initLanguage } from './src/renderer/i18n.ts';`, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'phone', logLevel: 'error', loader: { '.css': 'empty' } })).outputFiles[0].text;
  const font = (name) => 'data:font/woff2;base64,' + fs.readFileSync(path.join(root, 'node_modules/@phosphor-icons/web/src', name)).toString('base64');
  const icons = fs.readFileSync(path.join(root, 'src/renderer/icons.css'), 'utf8')
    .replace("url('@phosphor-icons/web/regular/Phosphor.woff2')", `url('${font('regular/Phosphor.woff2')}')`)
    .replace("url('@phosphor-icons/web/fill/Phosphor-Fill.woff2')", `url('${font('fill/Phosphor-Fill.woff2')}')`);
  // Every stylesheet the page links, in its order (settings.css owns the settings layouts).
  const linked = [...fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8').matchAll(/<link rel="stylesheet" href="\.\/([\w-]+\.css)"/g)].map(match => match[1]);
  if (!linked.includes('settings.css')) throw new Error('index.html no longer links settings.css; update this check');
  const css = linked.map(name => name === 'icons.css' ? icons : fs.readFileSync(path.join(root, 'src/renderer', name), 'utf8')).join('\n');
  const html = withoutScripts(fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')).replace(/<link\b[^>]*>/g, '')
    .replace('</head>', `<style>${css}</style></head>`);
  const win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.webContents.on('console-message', (_e, _l, message) => { if (/error|Error/.test(message) && !/Invalid URL/.test(message)) console.error('renderer:', message); });
  await win.webContents.executeJavaScript(code);
  await win.webContents.executeJavaScript(`(()=>{
    phone.initLanguage();
    const ok = data => Promise.resolve({ ok: true, data });
    window.telegramCalls = [];
    const telegramState = next => ({ ...window.fixtureState, telegram: next });
    phone.initPhonePushSettings({ testPhonePush: () => ok(undefined), setPhonePushToken: () => ok({}),
      // Telegram (#1934): the token goes in, a code comes back; nothing here talks to Telegram.
      connectTelegram: token => { window.telegramCalls.push(['connect', token]); return ok(telegramState({ state: 'pairing', botName: '@cos_home_bot', userName: null, code: 'K7M2Q9XA', codeUntil: Date.now() + 600000 })); },
      disconnectTelegram: () => { window.telegramCalls.push(['disconnect']); return ok(telegramState({ state: 'off', botName: null, userName: null })); },
      testTelegram: () => { window.telegramCalls.push(['test']); return ok(undefined); },
      writeClipboard: text => { window.telegramCalls.push(['copy', text]); return ok(true); } },
      { save: () => Promise.resolve(), applied: next => phone.applyPhonePush(next), toast: message => { window.lastToast = message; } });
    window.fixtureState = { hasPhonePushToken: true, config: { ui: { phonePush: { enabled: true, server: 'https://ntfy.sh', topic: 'cos-k3j9x2m4q8w7e5r1a6b7',
      needsYou: true, failures: true, finishedAfterMinutes: 15, onlyWhenAway: true, quietHours: { from: '22:00', to: '07:00' }, includeDetails: false } } } };
    phone.applyPhonePush(window.fixtureState);
    document.querySelector('.app')?.setAttribute('data-screen', 'settings');
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('is-active', p.dataset.panel === 'general'));
    return true; })()`);
  const measure = `(()=>{
    const section = document.getElementById('phonePushSettings'); section.scrollIntoView({ block: 'start' });
    const card = section.querySelector('.settings-surface').getBoundingClientRect(), top = section.getBoundingClientRect().top;
    const shown = el => !el.closest('[hidden]') && el.getClientRects().length > 0;
    const inputs = [...section.querySelectorAll('.phone-push-control input')].filter(shown);
    const fieldRights = [...section.querySelectorAll('.phone-push-control')].filter(shown).map(c => Math.round(c.getBoundingClientRect().right));
    const controls = [...section.querySelectorAll('.setting > input[type=checkbox], .setting > select, .setting > .btn')].filter(shown);
    const cut = [...section.querySelectorAll('b, em, .btn, h2, p, select')].filter(shown)
      .filter(el => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible').map(el => el.textContent.trim().slice(0, 40));
    const tall = [...section.querySelectorAll('.btn, select')].filter(shown).filter(el => el.getBoundingClientRect().height > 44).map(el => el.textContent.trim().slice(0, 30));
    return { inputLefts: [...new Set(inputs.map(i => Math.round(i.getBoundingClientRect().left)))], inputRights: [...new Set(inputs.map(i => Math.round(i.getBoundingClientRect().right)))], fieldRights: [...new Set(fieldRights)],
      controlRights: [...new Set(controls.map(c => Math.round(c.getBoundingClientRect().right)))], cut, tall,
      box: { x: Math.max(0, Math.floor(card.left) - 16), y: Math.max(0, Math.floor(top) - 8), width: Math.min(innerWidth - Math.max(0, Math.floor(card.left) - 16), Math.ceil(card.width) + 32), height: Math.min(innerHeight - Math.max(0, Math.floor(top) - 8), Math.ceil(card.bottom - top) + 24) }, top: Math.round(top) }; })()`;
  const results = [];
  const languages = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'];
  for (const language of languages) {
    for (const [width, height, zoom] of language === 'en' || language === 'de' || language === 'ru' ? [[1100, 900, 1], [720, 900, 1], [1100, 900, 1.5]] : [[1100, 900, 1]]) {
      win.setContentSize(width, height); win.webContents.setZoomFactor(zoom);
      await new Promise(r => setTimeout(r, 120));
      for (const advanced of [false, true]) {
      const tag = `${language}-${width}${zoom === 1 ? '' : '-zoom'}${advanced ? '-advanced' : ''}`;
      // Server, token and a new topic wait behind Advanced; both states are measured.
      await win.webContents.executeJavaScript(`document.getElementById('phonePushAdvanced').open = ${advanced}; true`);
      await win.webContents.executeJavaScript(`phone.setLanguage(${JSON.stringify(language)}); true`);
      // The page reflows after a zoom or size change; the app aligns on the next state push, as here.
      await win.webContents.executeJavaScript(`phone.applyPhonePush(window.fixtureState); true`);
      await new Promise(r => setTimeout(r, 60));
      const result = await win.webContents.executeJavaScript(measure);
      results.push({ tag, ...result });
      assert.deepEqual(result.cut, [], 'nothing cut ' + tag);
      assert.deepEqual(result.tall, [], 'buttons and choices on one line ' + tag);
      assert.equal(result.inputLefts.length, 1, 'text fields share one left edge ' + tag + JSON.stringify(result.inputLefts));
      assert.equal(result.inputRights.length, 1, 'text fields share one right edge ' + tag + JSON.stringify(result.inputRights));
      assert.equal(result.fieldRights.length, 1, 'field rows share one right edge ' + tag + JSON.stringify(result.fieldRights));
      assert.equal(result.controlRights.length, 1, 'switches and choices share one right edge ' + tag + JSON.stringify(result.controlRights));
      assert.equal(result.controlRights[0], result.fieldRights[0], 'fields end where switches end ' + tag);
      if (zoom === 1 && (width === 1100 ? ['en', 'de', 'ja'].includes(language) : language === 'en')) {
        // An offscreen window hands back its last painted frame: let the scroll above paint first,
        // or the picture shows the top of the page instead of this section.
        await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))');
        fs.writeFileSync(path.join(output, `phone-${tag}.png`), (await win.webContents.capturePage(result.box)).toPNG());
      }
      if (advanced) assert.equal(result.inputLefts.length === 1 && result.fieldRights.length === 1, true, 'all three fields on one grid ' + tag);
      if (!advanced) {
        // #1802: Play sounds sits under "Notify when a chat finishes", on the same edges, nothing cut.
        const sound = await win.webContents.executeJavaScript(`(()=>{
          const rows = ['turnNotifications', 'soundCues'].map(id => document.getElementById(id).closest('.setting'));
          rows[0].scrollIntoView({ block: 'center' });
          const r = rows.map(row => row.getBoundingClientRect()), switches = rows.map(row => row.querySelector('input').getBoundingClientRect());
          const texts = rows.map(row => row.querySelector('.setting-text').getBoundingClientRect());
          const cut = rows.flatMap(row => [...row.querySelectorAll('b, em')]).filter(el => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible').length;
          return { adjacent: rows[0].nextElementSibling === rows[1], rights: [...new Set(switches.map(s => Math.round(s.right)))], lefts: [...new Set(texts.map(t => Math.round(t.left)))],
            inside: switches.every((s, i) => s.right <= r[i].right + 0.5 && s.left >= texts[i].right - 0.5), cut, title: rows[1].querySelector('b').textContent,
            box: { x: Math.max(0, Math.floor(r[0].left) - 16), y: Math.max(0, Math.floor(r[0].top) - 12), width: Math.ceil(r[0].width) + 32, height: Math.ceil(r[1].bottom - r[0].top) + 24 } }; })()`);
        results.push({ tag: tag + '-sounds', ...sound });
        assert.ok(sound.adjacent && sound.rights.length === 1 && sound.lefts.length === 1 && sound.inside && sound.cut === 0, 'Play sounds row aligned and whole ' + tag + JSON.stringify(sound));
        if (zoom === 1 && width === 1100 && ['en', 'de', 'ja'].includes(language)) {
          await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))');
          fs.writeFileSync(path.join(output, `sounds-${language}.png`), (await win.webContents.capturePage(sound.box)).toPNG());
        }
      }
      }
    }
  }
  win.setContentSize(1100, 900); win.webContents.setZoomFactor(1);
  // Telegram (#1934): each state of its row and its two setup steps, on the card's edges, in English
  // and German (the longest texts), with ntfy on and off.
  const shot = async name => {
    const result = await win.webContents.executeJavaScript(measure);
    await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))');
    fs.writeFileSync(path.join(output, `${name}.png`), (await win.webContents.capturePage(result.box)).toPNG());
    return result;
  };
  const telegramRow = `(()=>{ const shown = el => !el.closest('[hidden]') && el.getClientRects().length > 0;
    const buttons = [...document.querySelectorAll('.telegram-actions .btn')].filter(shown);
    return { status: document.getElementById('telegramStatus').textContent, warn: document.getElementById('telegramStatus').classList.contains('is-warn'),
      buttons: buttons.map(b => b.id), right: Math.round(Math.max(...buttons.map(b => b.getBoundingClientRect().right))),
      setup: shown(document.getElementById('telegramSetup')), token: shown(document.getElementById('telegramTokenStep')), code: shown(document.getElementById('telegramCodeStep')),
      codeText: document.getElementById('telegramCode').value, hint: document.getElementById('telegramCodeHint').textContent,
      ntfy: shown(document.getElementById('phonePushNtfyOptions')) }; })()`;
  const telegram = next => win.webContents.executeJavaScript(`phone.applyPhonePush({ ...window.fixtureState, telegram: ${JSON.stringify(next)} }); true`);
  for (const language of ['en', 'de']) {
    await win.webContents.executeJavaScript(`phone.setLanguage(${JSON.stringify(language)}); document.getElementById('phonePushAdvanced').open = false; true`);
    await telegram({ state: 'off', botName: null, userName: null });
    let row = await win.webContents.executeJavaScript(telegramRow);
    let layout = await shot(`telegram-off-${language}`);
    assert.deepEqual(row.buttons, ['telegramLink'], 'not linked: Link… only ' + language);
    assert.equal(row.right, layout.controlRights[0], 'the Telegram button ends where switches end ' + language);
    assert.equal(row.setup, false);
    // Link…: the token step, its field on the same grid as the topic.
    await win.webContents.executeJavaScript(`document.getElementById('telegramLink').click(); true`);
    row = await win.webContents.executeJavaScript(telegramRow);
    layout = await shot(`telegram-token-${language}`);
    assert.ok(row.setup && row.token && !row.code, 'the token step shows ' + language);
    assert.deepEqual([layout.inputLefts.length, layout.inputRights.length, layout.fieldRights.length], [1, 1, 1], 'token field on the fields\' grid ' + language + JSON.stringify(layout));
    assert.deepEqual(layout.cut, [], 'nothing cut in the token step ' + language);
    // Continue with a token: the code step, naming the bot, with /start and the code to copy.
    await win.webContents.executeJavaScript(`document.getElementById('telegramToken').value = '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ1'; document.getElementById('telegramContinue').click(); true`);
    await new Promise(r => setTimeout(r, 80));
    row = await win.webContents.executeJavaScript(telegramRow);
    layout = await shot(`telegram-code-${language}`);
    assert.ok(row.setup && !row.token && row.code, 'the code step shows ' + language);
    assert.equal(row.codeText, '/start K7M2Q9XA');
    assert.ok(row.hint.includes('@cos_home_bot'), 'the hint names the bot ' + language);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('telegramToken').value`), '', 'the token is not kept in the field');
    assert.deepEqual(layout.cut, [], 'nothing cut in the code step ' + language);
    await win.webContents.executeJavaScript(`document.getElementById('telegramCopyCode').click(); true`);
    // Linked: who and through which bot, with Send test and Unlink; the setup closes.
    await telegram({ state: 'linked', botName: '@cos_home_bot', userName: '@maxim' });
    row = await win.webContents.executeJavaScript(telegramRow);
    layout = await shot(`telegram-linked-${language}`);
    assert.deepEqual(row.buttons, ['telegramTest', 'telegramUnlink'], 'linked: Send test and Unlink ' + language);
    assert.ok(row.status.includes('@maxim') && row.status.includes('@cos_home_bot') && !row.warn, 'linked status ' + language);
    assert.equal(row.setup, false, 'the setup closes once linked ' + language);
    assert.equal(row.right, layout.controlRights[0], 'linked buttons end where switches end ' + language);
    // Another app reads the bot: said as a warning, with Unlink.
    await telegram({ state: 'conflict', botName: '@cos_home_bot', userName: '@maxim' });
    row = await win.webContents.executeJavaScript(telegramRow);
    await shot(`telegram-conflict-${language}`);
    assert.ok(row.warn && row.buttons.includes('telegramUnlink'), 'conflict warns ' + language);
    // Telegram only: ntfy off hides its topic, test and Advanced.
    await win.webContents.executeJavaScript(`window.fixtureState.config.ui.phonePush.ntfy = false; true`);
    await telegram({ state: 'linked', botName: '@cos_home_bot', userName: '@maxim' });
    row = await win.webContents.executeJavaScript(telegramRow);
    layout = await shot(`telegram-only-${language}`);
    assert.equal(row.ntfy, false, 'ntfy off hides its rows ' + language);
    assert.equal(layout.controlRights.length, 1, 'switches on one edge with ntfy off ' + language);
    await win.webContents.executeJavaScript(`window.fixtureState.config.ui.phonePush.ntfy = true; true`);
  }
  // Cancel during the code step forgets the token; Unlink does too.
  await telegram({ state: 'pairing', botName: '@cos_home_bot', userName: null, code: 'K7M2Q9XA', codeUntil: Date.now() + 600000 });
  await win.webContents.executeJavaScript(`document.getElementById('telegramCancel').click(); true`);
  await new Promise(r => setTimeout(r, 80));
  const calls = await win.webContents.executeJavaScript('window.telegramCalls');
  assert.deepEqual(calls.map(call => call[0]), ['connect', 'copy', 'connect', 'copy', 'disconnect']);
  assert.equal(calls[1][1], '/start K7M2Q9XA');
  assert.equal((await win.webContents.executeJavaScript(telegramRow)).setup, false, 'Cancel closes the setup');
  fs.writeFileSync(path.join(output, 'measurements.json'), JSON.stringify(results, null, 2));
  console.log('Passed: Telegram links, shows its code, its linked and conflict states and Telegram only on the card\'s edges in English and German. Play sounds sits aligned under Notify when a chat finishes, and phone notifications keep one edge for fields and switches, cut nothing and keep controls on one line in all 13 languages (English, German and Russian also narrow and zoomed).');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
