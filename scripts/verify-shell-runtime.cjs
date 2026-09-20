const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { WebSocket } = require('ws');
const { transformSync, buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const reactRuntime = process.argv.find(value => value.startsWith('--react-runtime='))?.slice('--react-runtime='.length);
const output = path.join(root, 'outputs', 'shell-runtime-native');
fs.mkdirSync(output, { recursive: true });
const tests = fs.readFileSync(path.join(root, 'test/shell-compat.test.ts'), 'utf8');
const begin = tests.indexOf('function fixture()');
const end = tests.indexOf('// Models the observed', begin);
assert(begin > 0 && end > begin);
let fixture = tests.slice(begin, end);
fixture = fixture.replace(/page = new JSDOM\((`[\s\S]*?`), \{ url:[^\n]+\);/, 'document.body.innerHTML = $1;');
fixture = fixture.replace('const win = page.window, doc = win.document;', 'const win = window, doc = document;');
fixture = fixture.split('\n').filter(line => !line.includes('HTMLElement.prototype,') && !line.includes('win.postMessage =')).join('\n');
assert(!fixture.includes('JSDOM') && !fixture.includes('page.window'));
const liveStart = tests.indexOf('function liveShellMapping(');
const liveEnd = tests.indexOf('\nit.each', liveStart);
assert(liveStart > 0 && liveEnd > liveStart);
const liveMapping = tests.slice(liveStart, liveEnd);
const pairedStart = tests.indexOf('function pairedShellCall(');
const pairedEnd = tests.indexOf('\nit.each', pairedStart);
assert(pairedStart > 0 && pairedEnd > pairedStart);
const pairedMapping = tests.slice(pairedStart, pairedEnd);
const recorderStart = tests.indexOf('async function recorder(');
const recorderEnd = tests.indexOf('\nfunction addExchange(', recorderStart);
assert(recorderStart > 0 && recorderEnd > recorderStart);
const nativeRecorder = tests.slice(recorderStart, recorderEnd).replace(
  'await vi.waitFor(() => expect(hook).toBeTruthy());', 'if (!hook) throw Error("Recorder did not initialize");');
const constants = tests.slice(tests.indexOf('const THREAD ='), tests.indexOf('let page:'));
const setup = transformSync(`${constants}
const vi = { fn: (fn = () => {}) => fn };
const domSource = ${JSON.stringify(fs.readFileSync(path.join(root, 'extension/chatgpt-dom.js'), 'utf8'))};
const fiberSource = ${JSON.stringify(fs.readFileSync(path.join(root, 'extension/fiber.js'), 'utf8'))};
const usageSource = ${JSON.stringify(fs.readFileSync(path.join(root, 'extension/usage.js'), 'utf8'))};
const contentSource = ${JSON.stringify(fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8'))};
${fixture}
${liveMapping}
${pairedMapping}
${nativeRecorder}
globalThis.recorder = recorder;
globalThis.pairedShellCall = pairedShellCall;
globalThis.liveShellMapping = liveShellMapping;
globalThis.fixture = fixture; globalThis.usageSource = usageSource;`, { loader: 'ts', target: 'es2022' }).code;

const executable = path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1243/chrome-win64/chrome.exe');
assert(fs.existsSync(executable));
const profile = path.join(output, 'profile');
fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
const browser = spawn(executable, [`--user-data-dir=${profile}`, '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, seq = 0, session;
const pending = new Map();
function cdp(method, params = {}, target = session) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 12000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject });
    socket.send(JSON.stringify({ id, method, params, ...(target ? { sessionId: target } : {}) }));
  });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
(async () => {
  try {
    let port;
    for (let at = 0; at < 100; at++) { try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n'); break; } catch { await delay(100); } }
    assert(port);
    socket = new WebSocket(`ws://127.0.0.1:${port[0]}${port[1]}`);
    await new Promise(resolve => socket.once('open', resolve));
    socket.on('message', raw => {
      const message = JSON.parse(raw), receipt = pending.get(message.id);
      if (receipt) { pending.delete(message.id); message.error ? receipt.reject(new Error(message.error.message)) : receipt.resolve(message.result); }
      // All fixture requests are answered locally. No reporter page or account is loaded.
      if (message.method === 'Fetch.requestPaused') void cdp('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: Buffer.from('<!doctype html><html><body></body></html>').toString('base64') }, message.sessionId);
    });
    const target = await cdp('Target.createTarget', { url: 'about:blank' }, null);
    session = (await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId;
    await cdp('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp('Page.navigate', { url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    await delay(200);
    await evaluate(setup);
    const report = await evaluate(`(async () => {
      const f = fixture(), checks = [];
      f.entry.turn.status = 'complete'; f.entry.turn.items[2].completed = true;
      const native = liveShellMapping(f, true);
      const publicNode = f.doc.querySelector('[data-markdown-text-style]');
      publicNode.textContent = 'I will inspect the project.';
      publicNode.__reactFiber$fixture = f.chain({ item: f.entry.turn.items[1].items[1] }, f.row);
      const live = (await f.ask()).turns[0];
      if (f.queries.length || live.calls[0]?.requestId !== OTHER || live.activities[0]?.messageId !== native.thought ||
          !live.messages.some(m => m.rawMessageId === native.preamble) || JSON.stringify(live).includes('PRIVATE_REASONING_CONTENT'))
        throw Error('Native live mapping/public projection failed');
      const stamp = publicNode.getAttribute('data-clf-fiber-message');
      if (!stamp?.endsWith(native.preamble)) throw Error('Native public preamble anchor missing');
      const roots = f.doc.querySelectorAll('[data-clf-fiber-message]');
      if ([...roots].filter(n => n.getAttribute('data-clf-fiber-message').endsWith(ANSWER)).length !== 1)
        throw Error('Native final placement is ambiguous');
      checks.push('live shell request and public source ids are readable before history hydration; native preamble/final anchors are unique');
      const options = f.props.modelListConfig;
      f.props.modelListConfig = null;
      const missing = new Promise(resolve => {
        const receive = event => {
          if (event.source === window && event.data?.source === 'clf-picker-reply' && !event.data.picker) {
            window.removeEventListener('message', receive); resolve();
          }
        }; window.addEventListener('message', receive);
      });
      const cold = f.api.selectModelSettings('gpt-5-6-thinking', 'high');
      await missing;
      f.props.modelListConfig = options; f.trigger.setAttribute('data-state', 'closed');
      if (!await cold || f.api.composer().textContent.trim()) throw new Error('Cold native picker failed to resume');
      checks.push('cold picker refreshed ownership after account hydration and selected exact High');
      const origins = [];
      const observed = new Promise(resolve => {
        const receive = event => {
          if (event.source === window && event.data?.type === 'cos-request-origin') {
            origins.push(event.data); window.removeEventListener('message', receive); resolve();
          }
        }; window.addEventListener('message', receive);
      });
      window.fetch = async () => {
        const response = new Response('event: delta_encoding\\ndata: "v1"\\n\\nevent: delta\\ndata: ' + JSON.stringify({ v: { conversation_id: THREAD, message: { metadata: { request_id: 'wfr_native_early' }, content: { parts: ['PRIVATE_FIXTURE_VALUE'] } } } }) + '\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
        Object.defineProperty(response, 'url', { value: 'https://chatgpt.com/backend-api/f/conversation' });
        return response;
      };
      window.eval(usageSource);
      await window.fetch('/backend-api/f/conversation', { method: 'POST' }); await observed;
      if (origins.length !== 1 || origins[0].conversationId !== THREAD || origins[0].requestIds[0] !== 'wfr_native_early' || JSON.stringify(origins).includes('PRIVATE_FIXTURE_VALUE')) throw new Error('Native early origin projection failed');
      checks.push('native Response clone projected early inherited-header identity without message content');
      await f.ask();
      const box = f.api.composer();
      const text = '# Worker instructions\\n\\nKeep **literal** markup, C:\\\\work and <example>.\\n';
      if (!f.api.insertPrompt(text, true)) throw new Error('Native insertion refused');
      const span = box.querySelector('span[data-prompt-literal-paste]');
      if (!span || box.querySelector('example') || span.innerText.replace(/\\n$/, '') !== text.replace(/\\n$/, '')) throw new Error('Native HTML normalization lost literal text');
      checks.push('native insertHTML retained literal mark, punctuation, line breaks and escaped markup');
      if (!f.api.clearPromptExact(text)) throw new Error('Owned draft clear failed');
      const models = await f.api.inspectModelSettings();
      if (models?.length !== 3 || f.doc.querySelector('[data-model-picker-view]')) throw new Error('Picker discovery/closure failed');
      checks.push('native picker discovery selected versions and closed cleanly');
      if (!(await f.api.selectModelSettings('future-pro', 'pro'))) throw new Error('Worker model selection failed');
      checks.push('exact worker model and reasoning selection succeeded');
      if (f.api.generating() || !f.api.composerSubmitReady()) throw new Error('Completed composer remains blocked');
      checks.push('completed shell composer is ready');
      for (let at = 1; at <= 3; at++) {
        const submitted = '# Native send ' + at + '\\nKeep **literal** text.';
        const userId = '77777777-1111-4111-8111-' + String(at * 10 + 1).padStart(12, '0');
        const turnId = '77777777-1111-4111-8111-' + String(at * 10 + 2).padStart(12, '0');
        const answerId = '77777777-1111-4111-8111-' + String(at * 10 + 3).padStart(12, '0');
        let clicked = 0, receipted = 0;
        const entry = { id: turnId, conversationId: THREAD, turn: { status: 'in_progress', messageIds: [userId, answerId], items: [
          { type: 'user-message', messageId: userId, serverMessageId: userId, message: submitted },
          { type: 'assistant-message', messageId: answerId, content: 'Working', phase: 'final_answer', completed: false }
        ] } };
        const row = document.createElement('div'); row.setAttribute('data-turn-key', userId);
        row.innerHTML = '<div data-content-search-turn-key="' + turnId + '"><div data-content-search-unit-key="' + turnId + ':0:user"><div data-user-message-bubble><div class="whitespace-pre-wrap"></div></div></div><span hidden data-chatgpt-agent-turn-start></span><div data-content-search-unit-key="' + turnId + ':1:assistant"><div data-markdown-text-style="assistant-message">Working</div></div></div>';
        row.querySelector('.whitespace-pre-wrap').textContent = submitted;
        row.__reactFiber$fixture = f.chain({ entry }, f.top);
        f.api.sendButton().addEventListener('click', event => {
          event.preventDefault(); clicked++; box.replaceChildren();
          document.querySelector('[data-thread-find-target]').append(row); void f.ask();
        }, { once: true });
        if (!f.api.insertPrompt(submitted, true)) throw new Error('Native follow-up insertion failed');
        const sent = await f.api.send({ acceptanceTimeoutMs: 3000, acceptUserReceipt: (message, conversation) => {
          if (message.id !== userId || conversation !== THREAD) return false; receipted++; return true;
        } });
        if (!sent || clicked !== 1 || receipted !== 1) throw new Error('Native exact Send receipt failed');
        entry.turn.status = 'complete'; entry.turn.items[1].completed = true;
        const finished = await f.ask();
        if (finished.turns.at(-1).endMessageId !== answerId || f.api.generating()) throw new Error('Native final did not release composer');
        if (!finished.turns.at(-1).messages.some(message => message.rawMessageId === answerId && message.stable === true)) throw new Error('Native final lost handoff identity');
      }
      checks.push('three native sends clicked once each, matched exact user receipts and settled exact finals');
      checks.push('completed native final ids retain handoff capture proof without classic parent metadata');
      for (const source of ['request', 'result', 'embedded']) {
        const paired = fixture(), { mapping, step, resultId } = pairedShellCall(paired);
        if (source !== 'request') {
          delete mapping[CALL]; mapping[resultId].message.metadata.request_id = OTHER;
          if (source === 'embedded') step.callId = 'native-mcp-call-not-a-provider-message';
        }
        const descriptor = (await paired.ask()).turns[0];
        if (descriptor.calls[0]?.messageId !== step.callId || descriptor.calls[0]?.requestId !== OTHER ||
            descriptor.calls[0]?.answered !== true || /PRIVATE_TOOL_RESULT|DO_NOT_COPY/.test(JSON.stringify(descriptor)))
          throw Error('Native paired invocation/source projection failed: ' + source);
        checks.push('reloaded paired tool retains exact request ownership from ' + source + ' metadata');
      }
      const manual = fixture(), manualMapping = liveShellMapping(manual, true);
      manual.entry.conversationId = 'local-chatgpt:' + OTHER;
      manualMapping.owner.memoizedProps.conversationId = manual.entry.conversationId;
      const freshSection = manual.doc.querySelector('[data-turn-key]');
      freshSection.remove();
      const manualRecorder = await recorder(manual);
      manual.api.sendButton().addEventListener('click', event => {
        event.preventDefault(); manual.api.composer().replaceChildren();
        manual.doc.querySelector('[data-thread-find-target]').append(freshSection);
      }, { once: true });
      if (!manual.api.insertPrompt('hello', true)) throw Error('Native manual draft insertion failed');
      manual.api.sendButton().click();
      // The earlier stream test deliberately leaves another exact origin in the
      // document replay cache. Its readiness replay is not this Send's receipt.
      const manualOwners = () => manualRecorder.sent.filter(message => message.type === 'correlate' &&
        message.conversationId === THREAD && message.calls.some(call => call.requestId === OTHER));
      const deadline = Date.now() + 5000;
      while (manualOwners().length === 0 && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 20));
      await manualRecorder.hook.flush();
      if (manualRecorder.events().filter(event => event.kind === 'turn_start').length !== 1 ||
          manualOwners().length !== 1)
        throw Error('Native manual send did not establish exactly one generation and request owner: ' + JSON.stringify({
          events: manualRecorder.events().map(event => event.kind),
          requests: manualRecorder.sent.filter(message => message.type === 'correlate').flatMap(message => message.calls.map(call => call.requestId))
        }));
      if (!manualRecorder.events().some(event => event.kind === 'tool_evidence' && event.turnId &&
          event.calls.some(call => call.messageId === CALL && call.requestId === OTHER)))
        throw Error('Native manual Send did not retain turn-owned tool evidence');
      window.__CLF_CONTENT_RECORDER__.stop();
      checks.push('native click and transcript mutations establish shell request identity without a forced scan or page reload');
      const code = fixture(), liveCode = liveShellMapping(code, true), execution = '88888888-3333-4333-8333-333333333333';
      liveCode.mapping[execution] = { id: execution, message: { id: execution, author: { role: 'assistant' },
        recipient: 'functions.exec', metadata: { request_id: 'wfr_native_code_mode' } } };
      code.entry.turn.items[1].items.push({ type: 'dynamic-tool-call', callId: execution, tool: 'exec', completed: false });
      const codeTurn = (await code.ask()).turns[0];
      if (!codeTurn.requests.some(request => request.requestId === 'wfr_native_code_mode')) throw Error('Native Code Mode identity missing');
      checks.push('mounted Code Mode invocation supplies its exact request metadata before a result or history query');
      const worker = fixture(), workerMapping = liveShellMapping(worker, true);
      worker.entry.conversationId = 'local-chatgpt:' + OTHER;
      workerMapping.owner.memoizedProps.conversationId = worker.entry.conversationId;
      const bootstrap = 'Read the diagnostic and report back through agents.';
      worker.entry.turn.items[0].message = bootstrap;
      const workerRow = worker.doc.querySelector('[data-turn-key]');
      workerRow.querySelector('.whitespace-pre-wrap').textContent = bootstrap;
      workerRow.remove(); history.replaceState({}, '', '/?clf=native-event-worker');
      let workerSends = 0;
      worker.api.sendButton().addEventListener('click', event => {
        event.preventDefault(); workerSends++; worker.api.composer().replaceChildren();
        queueMicrotask(() => { history.pushState({}, '', '/c/' + THREAD);
          worker.doc.querySelector('[data-thread-find-target]').append(workerRow); });
      });
      const nativeTimeout = window.setTimeout.bind(window);
      // Reproduce deferred background timers while native mutations/messages run.
      window.setTimeout = (fn, ms, ...args) => Number(ms) >= 500 ? 987654321 : nativeTimeout(fn, ms, ...args);
      let workerRecorder;
      try {
        workerRecorder = await recorder(worker, { redeem: () => ({ ok: true,
          command: { id: 'native-event-worker', type: 'worker', agent: 'worker-1', text: bootstrap } }) }, false);
        const workerDeadline = Date.now() + 5000;
        while ((!workerRecorder.sent.some(message => message.type === 'ack') ||
            !workerRecorder.sent.some(message => message.type === 'correlate' && message.calls.some(call => call.requestId === OTHER))) && Date.now() < workerDeadline)
          await new Promise(resolve => nativeTimeout(resolve, 20));
        const acknowledgments = workerRecorder.sent.filter(message => message.type === 'ack');
        if (workerSends !== 1 || acknowledgments.length !== 1 || acknowledgments[0].status !== 'sent' ||
            acknowledgments[0].conversationId !== THREAD || acknowledgments[0].agent !== 'worker-1')
          throw Error('Fresh worker did not acknowledge its exact native receipt without a polling timer');
        if (!workerRecorder.sent.some(message => message.type === 'correlate' && message.calls.some(call => call.requestId === OTHER)))
          throw Error('Fresh worker request identity did not reach the recorder');
        checks.push('fresh worker sends, binds and correlates from native events while background polling timers are deferred');
      } finally {
        window.__CLF_CONTENT_RECORDER__?.stop(); window.setTimeout = nativeTimeout;
        history.replaceState({}, '', '/c/' + THREAD);
      }
      return { ok: true, checks, userAgent: navigator.userAgent };
    })()`);
    if (reactRuntime) {
      const realReact = buildSync({ stdin: { contents: fs.readFileSync(path.join(__dirname, 'fixtures/shell-react-runtime.js'), 'utf8'),
        resolveDir: path.resolve(root, reactRuntime) }, bundle: true, write: false, platform: 'browser', format: 'iife',
        define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text;
      await evaluate(realReact);
      report.react = await evaluate(`verifyCommittedShellReact(${JSON.stringify(fs.readFileSync(path.join(root, 'extension/fiber.js'), 'utf8'))},${JSON.stringify(fs.readFileSync(path.join(root, 'extension/chatgpt-dom.js'), 'utf8'))})`);
      report.checks.push(...report.react.checks);
    }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (socket?.readyState === WebSocket.OPEN) { try { await cdp('Browser.close', {}, null); } catch {} socket.close(); }
    browser.kill();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
