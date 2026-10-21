// The made-up project, chat, plan and workers behind the README pictures and its demo recording,
// run against the production renderer. Synthetic data only: placeholder paths and an invented task.
const fs = require('node:fs');
const path = require('node:path');
const { fixtureConfigSource } = require('./app-defaults.cjs');

const root = path.resolve(__dirname, '..', '..');

const fixture = (demo, sidebar) => `
  addEventListener('error', event => console.error(event.error?.stack || event.message));
  addEventListener('unhandledrejection', event => console.error(event.reason?.stack || event.reason));
  // ?lang=de and so on: the Sidebar layout pictures are taken once per language.
  const LANG = new URLSearchParams(location.search).get('lang') || 'en';
  try { localStorage.setItem('cos.ui.language', LANG); } catch {}
  // The stills look at a task four minutes in; the demo starts it now.
  const T0 = ${demo} ? Date.now() : Date.now() - 4 * 60_000;
  const text = text => ({ text, chars: text.length, truncated: false });
  const call = (seq, tool, args, summary, extra = {}) => ({ kind: 'tool_call', source: 'mcp', seq, origin: seq, time: T0 + seq * 9000, turnId: 'turn-1', agent: 'prime',
    call: { callId: 'call-' + seq, tool, attribution: 'request_id', requestId: 'req-' + seq, conversationId: 'demo-chat', attributionMethod: 'request_id',
      args: text(JSON.stringify(args)), result: text('ok'), outcome: 'ok', durationMs: 900 + seq * 37, summary, ...extra } });
  window.rows = [
    { kind: 'turn_start', seq: 1, origin: 1, time: T0, turnId: 'turn-1', source: 'extension' },
    { kind: 'user_message', seq: 2, origin: 2, time: T0 + 1000, turnId: 'turn-1', source: 'extension', messageId: 'ask', inputDelivery: 'confirmed',
      message: text('Add dark mode to the settings page and keep the existing tests green.') },
    call(3, 'read', { path: 'src/settings/theme.ts' }, { title: 'Read src/settings/theme.ts', detail: 'lines 1–120', tone: 'neutral', kind: 'read' }),
    call(4, 'search', { query: 'prefers-color-scheme' }, { title: 'Searched for prefers-color-scheme', metric: '6 matches', tone: 'neutral', kind: 'search' }),
    call(5, 'apply_patch', { path: 'src/settings/theme.ts' }, { title: 'Edited src/settings/theme.ts', metric: '+42 −7', tone: 'good', kind: 'edit' },
      { changes: [{ path: 'src/settings/theme.ts', added: 42, removed: 7, approximate: false }] }),
    call(6, 'apply_patch', { path: 'src/settings/SettingsPage.tsx' }, { title: 'Edited src/settings/SettingsPage.tsx', metric: '+18 −3', tone: 'good', kind: 'edit' },
      { changes: [{ path: 'src/settings/SettingsPage.tsx', added: 18, removed: 3, approximate: false }] }),
    call(7, 'exec_command', { cmd: 'npm test' }, { title: 'Ran npm test', metric: '✓ 6.2s', tone: 'good', kind: 'command' }),
    { kind: 'assistant_message', seq: 8, origin: 8, time: T0 + 80_000, turnId: 'turn-1', source: 'extension', messageId: 'progress', final: false, state: 'streaming',
      message: text('The **Theme** switch is in and the existing tests pass. Two workers are adding tests and updating the docs while I check the contrast of the dark colors.') },
    call(9, 'exec_command', { cmd: 'npm test' }, { title: 'Ran npm test', metric: '✓ 9.4s', tone: 'good', kind: 'command' }),
    { kind: 'assistant_message', seq: 10, origin: 10, time: T0 + 110_000, turnId: 'turn-1', source: 'extension', messageId: 'final', final: true, state: 'complete',
      message: text('Dark mode is in. **Settings → Appearance** has a Theme switch (Light, Dark, System), the choice is saved, and all 48 tests pass, including the 6 new ones from the worker. The docs describe the new setting.') },
    { kind: 'turn_end', seq: 11, origin: 11, time: T0 + 111_000, turnId: 'turn-1', source: 'extension', outcome: 'completed' }
  ];
  // What of the story is on screen. The stills show its middle; the demo plays it from the start.
  window.stage = ${demo} ? { rows: 0, listed: false, plan: -1, workers: 0 } : { rows: 8, listed: true, plan: 2, workers: 2 };
  const shown = () => window.rows.slice(0, window.stage.rows);
  const ended = () => shown().some(row => row.kind === 'turn_end');
  ${fixtureConfigSource()}
  const config = fixtureConfig({ roots: [{ name: 'demo-app', path: '/Users/you/Projects/demo-app' }, { name: 'design-tokens', path: '/Users/you/Projects/design-tokens' }],
    tunnel: { kind: 'openai', tunnelId: 'tunnel_0123456789abcdef0123456789abcdef', desktopTunnelId: '', binaryPath: '' },
    ui: { theme: 'dark', autoConnect: false, chatBrowser: 'chrome', defaultChatModel: 'gpt-6', defaultChatReasoning: 'high' }, multiAgent: { enabled: true, maxWorkers: 2 } });
  const surface = (id, connectorName, tools) => ({ id, connectorName, description: connectorName, cardSummary: '', optional: id !== 'core', available: true,
    localUrl: 'http://127.0.0.1:8765/mcp/' + id, publicUrl: null, tools, state: 'live', detail: '', lastRequestAt: Date.now() - 4000, lastToolCallAt: Date.now() - 4000 });
  const state = { config, hasApiKey: true, hasGoalKey: false, resolvedBinary: null,
    status: { state: 'connected', detail: '', publicUrl: null, localUrl: 'http://127.0.0.1:8765', handshakeAt: Date.now() - 60000, lastRequestAt: Date.now() - 4000, lastToolCallAt: Date.now() - 4000, health: null,
      surfaces: [surface('core', 'Chat On Steroids Core', ['read', 'apply_patch', 'exec_command'])] },
    bridge: { running: true, paired: true, present: true, port: 8765, lastSeenAt: Date.now(), extensionVersion: '2.1.36',
      externalExtension: { present: true, version: '2.1.36', lastSeenAt: Date.now(), signedIn: true } },
    update: { current: '2.1.36', latest: null, stage: 'idle', error: null, checkedAt: null } };
  const summary = { id: 'demo', title: 'Dark mode for settings', conversationId: 'demo-chat', chatIds: ['demo-chat'], startedAt: T0, updatedAt: T0 + 81000,
    events: window.rows.length, userMessages: 1, toolCalls: 5, estimatedTokens: 18200, contextTokens: 18200, errors: 0, agents: ['prime'], origin: null,
    selectedModel: { model: 'gpt-6', reasoningEffort: 'high', observedAt: T0 + 1000 } };
  const others = [['Fix flaky upload test', 3], ['Release notes for 1.4', 26], ['Refactor billing client', 51]].map(([title, hours], index) =>
    ({ ...summary, id: 'other-' + index, title, conversationId: 'other-' + index, chatIds: ['other-' + index], startedAt: Date.now() - hours * 3600e3, updatedAt: Date.now() - hours * 3600e3 }));
  // stage.plan steps are done and the next one is in progress; -1 is no plan yet.
  const plan = () => window.stage.plan < 0 ? null : { updatedAt: T0 + 70000, explanation: '', plan:
    ['Read the current theme handling', 'Add the Theme switch and store it', 'Check dark-mode contrast', 'Merge the workers\u2019 tests and docs'].map((step, index) =>
      ({ step, status: index < window.stage.plan ? 'completed' : index === window.stage.plan ? 'in_progress' : 'pending' })) };
  const agent = (id, role, label, task, state, extra = {}) => ({ id, role, label, task, jobTitle: label, runId: 'run-1', reasoningEffort: null, model: null, state,
    createdAt: T0 + 30000, activatedAt: T0 + 32000, finishedAt: null, result: null, pending: 0, awaitingAck: 0, delivered: 1,
    conversationId: id === 'prime' ? 'demo-chat' : id + '-chat', primeConversationId: 'demo-chat', detachedAt: null, ...extra });
  // stage.workers: 0 none yet, 1 both working, 2 the docs worker has finished, 3 both have.
  // In the demo the workers have been at it for a while when they first show, so their times read like real work.
  const started = () => window.stage.at ? { createdAt: window.stage.at[1] - 42000, activatedAt: window.stage.at[1] - 40000 } : {};
  const swarm = () => ({ enabled: true, running: window.stage.workers > 0 && window.stage.workers < 3, runId: 'run-1', maxWorkers: 2, pendingReports: 0, agents: window.stage.workers === 0 ? [] : [
    agent('prime', 'prime', 'prime', '', 'active'),
    agent('worker-1', 'worker', 'Theme tests', 'Write tests for the Theme switch', window.stage.workers >= 3 ? 'finished' : 'active',
      { ...started(), ...(window.stage.workers >= 3 ? { finishedAt: window.stage.at?.[3] ?? T0 + 100000, result: '6 tests added in test/theme.test.ts' } : {}) }),
    agent('worker-2', 'worker', 'Settings docs', 'Update the settings documentation', window.stage.workers >= 2 ? 'finished' : 'active',
      { ...started(), ...(window.stage.workers >= 2 ? { finishedAt: window.stage.at?.[2] ?? T0 + 75000, result: 'Docs updated in docs/settings.md' } : {}) }) ] });
  // Each worker is its own ChatGPT chat, linked to the chat that started it.
  const workerChats = () => [['worker-1', 'Theme tests', 'Write tests for the Theme switch'], ['worker-2', 'Settings docs', 'Update the settings documentation']].map(([id, title, task]) =>
    ({ ...summary, id, title, conversationId: id + '-chat', chatIds: [id + '-chat'], agents: [id], toolCalls: 3, estimatedTokens: 6400, contextTokens: 6400,
      startedAt: started().activatedAt ?? T0 + 32000, updatedAt: window.stage.at ? Date.now() : T0 + 76000, origin: { kind: 'worker', fromSessionId: 'demo', agentId: id, task },
      ...(window.stage.at ? { activityExpiresAt: window.stage.workers >= (id === 'worker-1' ? 3 : 2) ? null : Date.now() + 60000 } : {}) }));
  // ChatGPT's model list as the app read it on 2026-10-12.
  const models = { state: 'ready', requestedAt: Date.now() - 60000, observedAt: Date.now() - 60000, models: [
    { id: 'gpt-6', label: 'GPT-6', efforts: ['none', 'medium', 'high', 'xhigh'], aliases: ['gpt-6', 'gpt-6-thinking'] },
    { id: 'gpt-5-6', label: 'GPT-5.6', efforts: ['none', 'medium', 'high', 'xhigh'], aliases: ['gpt-5-6-instant', 'gpt-5-6-thinking'] },
    { id: 'gpt-5-5', label: 'GPT-5.5', efforts: ['none', 'medium', 'high', 'xhigh'], aliases: ['gpt-5-5-instant', 'gpt-5-5-thinking'] } ] };
  // The Sidebar layout pictures (scripts/capture-layout-previews.cjs): three projects and their chats.
  const SIDEBAR = ${sidebar};
  const H = 3600e3, now = Date.now();
  const demoProjects = [
    { id: 'p-web', name: 'website', path: '/Users/you/Projects/website', createdAt: 3, color: 'blue' },
    { id: 'p-app', name: 'mobile-app', path: '/Users/you/Projects/mobile-app', createdAt: 2, color: 'green' },
    { id: 'p-docs', name: 'docs', path: '/Users/you/Projects/docs', createdAt: 1, color: 'amber' } ];
  // The made-up chat names in each app language, so a picture reads like that language's sidebar.
  // Project names are folder names and stay as they are.
  const SIDEBAR_TITLES = {
    de: ['Dunkelmodus einbauen', 'Kontaktformular reparieren', 'Bilder schneller laden', 'Login-Absturz auf iOS', 'Push-Einstellungen', 'Versionshinweise für 1.4', 'Anleitung überarbeiten', 'Team-Offsite planen'],
    es: ['Modo oscuro para los ajustes', 'Arreglar el formulario de contacto', 'Cargar las imágenes más rápido', 'Fallo de la pantalla de inicio de sesión en iOS', 'Ajustes de notificaciones push', 'Notas de la versión 1.4', 'Reescribir la guía de instalación', 'Planificar la salida del equipo'],
    fr: ['Mode sombre pour les réglages', 'Corriger le formulaire de contact', 'Accélérer le chargement des images', "Plantage de l'écran de connexion sur iOS", 'Réglages des notifications push', 'Notes de version 1.4', "Réécrire le guide d'installation", "Organiser le séminaire d'équipe"],
    'pt-BR': ['Modo escuro nas configurações', 'Corrigir o formulário de contato', 'Acelerar o carregamento de imagens', 'Falha na tela de login no iOS', 'Configurações de notificações push', 'Notas da versão 1.4', 'Reescrever o guia de configuração', 'Planejar o encontro da equipe'],
    'pt-PT': ['Modo escuro nas definições', 'Corrigir o formulário de contacto', 'Acelerar o carregamento de imagens', 'Falha no ecrã de início de sessão no iOS', 'Definições de notificações push', 'Notas da versão 1.4', 'Reescrever o guia de configuração', 'Planear o encontro da equipa'],
    ru: ['Тёмная тема для настроек', 'Исправить форму обратной связи', 'Ускорить загрузку изображений', 'Сбой экрана входа на iOS', 'Настройки push-уведомлений', 'Примечания к выпуску 1.4', 'Переписать руководство по настройке', 'Спланировать выезд команды'],
    tr: ['Ayarlar için koyu mod', 'İletişim formunu düzelt', 'Görsellerin yüklenmesini hızlandır', "iOS'ta giriş ekranı çökmesi", 'Anlık bildirim ayarları', '1.4 sürüm notları', 'Kurulum kılavuzunu yeniden yaz', 'Ekip gezisini planla'],
    vi: ['Chế độ tối cho phần cài đặt', 'Sửa biểu mẫu liên hệ', 'Tăng tốc tải hình ảnh', 'Lỗi màn hình đăng nhập trên iOS', 'Cài đặt thông báo đẩy', 'Ghi chú phát hành 1.4', 'Viết lại hướng dẫn cài đặt', 'Lên kế hoạch dã ngoại cho nhóm'],
    ja: ['設定画面のダークモード', 'お問い合わせフォームを修正', '画像の読み込みを高速化', 'iOS でログイン画面がクラッシュ', 'プッシュ通知の設定', 'バージョン 1.4 のリリースノート', 'セットアップガイドを書き直す', 'チーム合宿を計画'],
    ko: ['설정 화면 다크 모드', '문의 양식 수정', '이미지 로딩 속도 개선', 'iOS 로그인 화면 충돌', '푸시 알림 설정', '1.4 릴리스 노트', '설치 가이드 다시 쓰기', '팀 워크숍 계획'],
    'zh-CN': ['设置页面的深色模式', '修复联系表单', '加快图片加载', 'iOS 登录界面崩溃', '推送通知设置', '1.4 版本说明', '重写安装指南', '策划团队团建'],
    'zh-TW': ['設定頁面的深色模式', '修正聯絡表單', '加快圖片載入', 'iOS 登入畫面當機', '推播通知設定', '1.4 版本說明', '重寫安裝指南', '規劃團隊外出活動']
  };
  const sidebarChat = (id, title, projectId, hoursAgo, active) => ({ ...summary, id, title, projectId, conversationId: 'c-' + id, chatIds: ['c-' + id],
    startedAt: now - hoursAgo * H - 600e3, updatedAt: now - hoursAgo * H, ...(active ? { activityExpiresAt: now + H } : {}) });
  const demoSessions = [
    sidebarChat('website', 'Dark mode for settings', 'p-web', 0.05, true), sidebarChat('w2', 'Fix the contact form', 'p-web', 3),
    sidebarChat('w3', 'Speed up image loading', 'p-web', 26), sidebarChat('a1', 'Login screen crash on iOS', 'p-app', 0.1, true),
    sidebarChat('a2', 'Push notification settings', 'p-app', 30), sidebarChat('d1', 'Release notes for 1.4', 'p-docs', 5),
    sidebarChat('d2', 'Rewrite the setup guide', 'p-docs', 50), sidebarChat('n1', 'Plan the team offsite', null, 8) ];
  for (const [index, title] of (SIDEBAR_TITLES[LANG] ?? []).entries()) demoSessions[index].title = title;
  const ok = data => Promise.resolve({ ok: true, data });
  window.api = new Proxy({
    getState: () => ok(state), getLog: () => ok([]), listProjects: () => ok(SIDEBAR ? demoProjects : []),
    listSessions: () => SIDEBAR ? ok({ sessions: demoSessions, activeId: null, pressure: [], blocked: [] }) : ok({ sessions: [...(window.stage.listed ? [{ ...summary, ...(${demo} ? { updatedAt: Date.now(), activityExpiresAt: ended() ? null : Date.now() + 60000 } : {}) }] : []), ...(window.stage.workers ? workerChats() : []), ...others],
      activeId: window.stage.listed && !ended() ? 'demo' : null, pressure: [], blocked: [] }),
    // As the app's store answers: everything on opening, then only rows from the cursor on.
    getSession: (_id, options = {}) => { const rows = shown().filter(row => row.seq >= (options.from ?? 0));
      return ok({ summary: { ...summary, events: shown().length }, events: structuredClone(rows), total: shown().length, nextFrom: shown().reduce((next, row) => Math.max(next, row.seq + 1), options.from ?? 0) }); },
    getSessionControls: () => ok({ automation: 'off', blocked: '', job: null, plan: plan(), activeTurnId: ended() ? null : 'turn-1' }),
    listInputs: () => ok([]), runningTools: () => ok([]), listPausedHelpers: () => ok([]),
    onSessionChanged: fn => { window.changed = fn; return () => {}; }, onStateChanged: fn => { window.pushState = fn; return () => {}; },
    getSwarm: () => ok(swarm()), onSwarmChanged: fn => { (window.swarmListeners ??= []).push(fn); return () => {}; }, getChatModels: () => ok(models)
  }, { get: (target, key) => key in target ? target[key] : () => ok(null) });
  await import('/main.ts');
  // A running app repaints on every state update; one more paint settles first-paint badges.
  window.pushState?.(state);
  // The demo moves the story on: more rows, a further plan step, workers starting and finishing.
  window.advance = change => {
    // Rows and workers carry the time they appear, so durations on screen are the demo's own.
    for (const row of window.rows.slice(window.stage.rows, change.rows ?? 0)) row.time = Date.now();
    if (change.workers) (window.stage.at ??= {})[change.workers] = Date.now();
    Object.assign(window.stage, change); window.changed?.({ sessionIds: ['demo'] }); for (const listener of window.swarmListeners ?? []) listener(swarm()); };
  window.ready = true;
`;


/** A Vite server for the production renderer whose /fixture.html runs the fixture in place of the app's entry script. */
async function fixtureServer({ demo = false, sidebar = false } = {}) {
  const { createServer } = await import('vite');
  const server = await createServer({ configFile: false, logLevel: 'error', root: path.join(root, 'src/renderer'), server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] } },
    plugins: [{ name: 'readme-fixture', configureServer(vite) { vite.middlewares.use('/fixture.html', async (_req, res) => {
      // The production page without its entry script, which the fixture replaces.
      const entry = '<script type="module" src="./main.ts"></script>';
      const page = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
      if (page.split(entry).length !== 2) throw new Error('index.html has exactly one entry script');
      const html = page.replace(entry, '').replace('</body>', '<script type="module">' + fixture(demo, sidebar) + '</script></body>');
      res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/fixture.html', html));
    }); } }] });
  await server.listen();
  return server;
}

module.exports = { fixtureServer, root };
