import { browserPage, boundedBrowserValue, browserFramePoint } from './browser-control-page.js';

/** One browser-lifetime tab custodian. No selected-tab fallback and no action replay. */
export function createBrowserControl(chrome, transport, protectedTab = () => false) {
  const KEY = 'cosBrowserControl';
  const tabs = new Map();
  let browserId, epoch = null, receipt = null, loading, pumping, again = false, saving = Promise.resolve();
  let policy = { read: false, write: false };
  const id = () => crypto.randomUUID();
  const cut = (s, n = 1000) => String(s ?? '').slice(0,n);
  const error = message => { throw new Error(message); };
  const handle = tabId => `${browserId}:${tabId}`;
  const owns = (state, command) => !!state && (state.owner === command.owner ||
    state.owner.startsWith('request:') && command.owner.startsWith('session:') && command.ownerAliases?.includes(state.owner));
  async function cleanup(work) {
    let timer;
    try { await Promise.race([work.catch(() => {}),new Promise(resolve => {timer=setTimeout(resolve,1500);})]); }
    finally {clearTimeout(timer);}
  }
  function removeIndicator(state) {
    return chrome.scripting.executeScript({target:{tabId:state.tabId},args:[state.lease],func:lease=>{
      for(const node of document.querySelectorAll('[data-cos-browser-control]')) if(node.getAttribute('data-cos-browser-control')===lease)node.remove();
    }});
  }
  const pageURL = raw => {
    if (raw === 'about:blank') return raw;
    let url; try { url = new URL(raw); } catch { error('BROWSER_URL_INVALID'); }
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) error('BROWSER_URL_UNSUPPORTED: use an HTTP(S) page without embedded credentials.');
    return url.href;
  };
  function save() {
    const work = saving.catch(() => {}).then(() => chrome.storage.session.set({ [KEY]: {
      browserId, epoch, receipt,
      tabs: [...tabs.values()].map(s => ({ tabId: s.tabId, owner: s.owner, lease: s.lease }))
    } }));
    saving = work; return work;
  }
  function newState(tabId, owner, lease = id()) {
    return { tabId, owner, lease, pageId: id(), contexts: new Map(), frames: new Map(), sessions: new Set(),
      console: [], network: new Map(), seq: 0, consoleDropped: 0, networkDropped: 0, screenshot: null, dialog: null, initialized: false };
  }
  function invalidate(state) {
    state.pageId = id(); state.screenshot = null; state.refFrames?.clear();
    for (const key of state.contexts.keys()) if (key.endsWith(':isolated')) state.contexts.delete(key);
  }
  async function ready() {
    if (!loading) loading = (async () => {
      const data = (await chrome.storage.session.get(KEY))[KEY];
      browserId = typeof data?.browserId === 'string' && /^[a-f\d-]{36}$/i.test(data.browserId) ? data.browserId : id();
      epoch = data?.epoch || null; receipt = data?.receipt || null;
      for (const entry of (Array.isArray(data?.tabs) ? data.tabs : []).slice(0,32)) {
        if (Number.isSafeInteger(entry.tabId) && typeof entry.owner === 'string' && typeof entry.lease === 'string') {
          const state = newState(entry.tabId, entry.owner, entry.lease);state.restored = true;tabs.set(entry.tabId,state);
        }
      }
      await save();
    })();
    return loading;
  }
  function alive(state, command) {
    if (tabs.get(state.tabId) !== state) error('BROWSER_DETACHED: tab ownership was released. Attach again deliberately.');
    if (command && (command.epoch !== epoch || command.expiresAt <= Date.now())) error('BROWSER_EXPIRED: remaining input was not dispatched. Earlier actions may have completed.');
    if (command?.args.pageId && !/^[a-f\d-]{36}$/i.test(command.args.pageId)) error('BROWSER_PAGE_ID_INVALID: copy the top-level pageId from the observation, not a frameId or element ref. No input was dispatched.');
    if (command?.args.pageId && state.pageId !== command.args.pageId) error('BROWSER_PAGE_STALE: navigation invalidated the observation. Snapshot again.');
  }
  async function send(state, method, params = {}, sessionId, command) {
    alive(state,command);
    if (method === 'Input.dispatchMouseEvent' && params.__sessionId) {
      const {__sessionId,...inputParams} = params;sessionId = __sessionId;params = inputParams;
    }
    let timer;
    try {
      return await Promise.race([
        chrome.debugger.sendCommand({ tabId: state.tabId, ...(sessionId ? { sessionId } : {}) }, method, params).then(value => {alive(state);return value;}),
        new Promise((_,reject) => { timer = setTimeout(() => {
          // Retire admission before releasing a stuck debugger. A late result cannot
          // lend its target to another command; accepted effects are not replayed.
          if (tabs.get(state.tabId) === state) {
            tabs.delete(state.tabId);
            void cleanup(removeIndicator(state));
            if (method === 'Runtime.evaluate') void chrome.debugger.sendCommand({tabId:state.tabId,...(sessionId ? {sessionId}: {})},'Runtime.terminateExecution').catch(() => {});
            void chrome.debugger.detach({tabId:state.tabId}).catch(() => {});
            void save().catch(() => {});
          }
          reject(new Error(`BROWSER_CDP_TIMEOUT: ${method} did not acknowledge within its deadline. This attachment was retired; the tab was not closed. List tabs, explicitly attach the same existing tab, then inspect before repeating any input.`));
        // Background compositing can legitimately outlast input's 8s bound. A
        // capture gets 20s within the same absolute RPC deadline, never a retry.
        }, Math.min(method==='Page.captureScreenshot' ? 20000 : 8000,command ? Math.max(1,command.expiresAt-Date.now()) : 8000)); })
      ]);
    } catch (cause) {
      clearTimeout(timer);
      // A debugger loss can race its MV3 notification. Confirm Chrome's current target
      // state before retiring custody; an ordinary protocol/JavaScript error is not detach.
      if (tabs.get(state.tabId) === state) {
        const targets = await chrome.debugger.getTargets().catch(() => null);
        if (targets && !targets.some(target => target.tabId === state.tabId && target.attached)) {
          await release(state);
          error('BROWSER_DETACHED: Chrome ended this attachment. Earlier input may have completed; inspect before repeating.');
        }
      }
      throw cause;
    } finally { clearTimeout(timer); }
  }
  async function currentTab(state, command) {
    alive(state,command);
    const tab = await getTab(state.tabId);
    alive(state,command);
    pageURL(tab.url);
    if (tab.pendingUrl && tab.pendingUrl !== tab.url) error('BROWSER_NAVIGATING: wait for the destination and snapshot again.');
    const observes = ['browser_snapshot','browser_screenshot','browser_console','browser_network'].includes(command?.tool);
    if (!observes && protectedTab(state.tabId, tab.url, command?.conversationId)) error('BROWSER_EXECUTOR_TAB: active ChatGPT orchestration owns this tab. browser_snapshot can inspect its DOM directly without attach. Input, navigation and arbitrary JavaScript remain unavailable here.');
    return tab;
  }
  async function getTab(tabId) {
    try { return await chrome.tabs.get(tabId); }
    catch (cause) {
      if (/No tab with id|Invalid tab ID/i.test(cause?.message || '')) error('BROWSER_TAB_CLOSED: this exact tab no longer exists, possibly closed by the user. List tabs to inspect current state; do not recreate it automatically.');
      throw cause;
    }
  }
  async function input(state, method, params, command) {
    await authorize(command);
    await currentTab(state,command);
    return send(state,method,params,undefined,command);
  }
  async function authorize(command, writes = true) {
    if (!(writes ? policy.write : policy.read)) error('BROWSER_PERMISSION_REVOKED');
    const check = await transport('/browser-control',{method:'POST',body:JSON.stringify({action:'check',browserId,id:command.id,epoch:command.epoch})});
    if (!check.ok || check.data?.allowed !== true) error('BROWSER_PERMISSION_REVOKED: remaining input was not dispatched.');
  }
  async function initialize(state, sessionId) {
    if (!sessionId && state.restored) {
      // Chrome may retain enabled domains while the MV3 JavaScript heap disappears.
      // Renew this lease's domain subscriptions so existing contexts/child sessions are emitted.
      await send(state,'Target.setAutoAttach',{autoAttach:false,waitForDebuggerOnStart:false,flatten:true});
      await send(state,'Runtime.disable');state.restored = false;
    }
    await send(state,'Page.enable',{},sessionId);
    // Hidden widgets otherwise wait ~5s for mouse ACKs and suspend animation/media.
    // This affects only the attached page, never Chrome's selected tab or OS focus.
    // Chrome drops the emulation when its debugger session is detached.
    if (!sessionId) await send(state,'Emulation.setFocusEmulationEnabled',{enabled:true});
    await send(state,'Runtime.enable',{},sessionId);
    await send(state,'Network.enable',{ maxTotalBufferSize: 2_000_000, maxResourceBufferSize: 500_000, maxPostDataSize: 16000 },sessionId);
    await send(state,'Log.enable',{},sessionId);
    // Chrome 125+ flat child sessions let the same tab own out-of-process frames.
    await send(state,'Target.setAutoAttach',{ autoAttach:true, waitForDebuggerOnStart:false, flatten:true, filter:[{ type:'iframe', exclude:false }] },sessionId);
    if (!sessionId) state.initialized = true;
  }
  async function frameList(state) {
    const found = [], observed = new Map();
    const visit = (tree, sessionId) => {
      if (!tree || found.length >= 100) return;
      const f = tree.frame;
      if (f?.id) {
        const previous = state.frames.get(f.id);
        const row = { id:f.id, parentId:f.parentId || previous?.parentId, url:cut(f.url,2000), sessionId:sessionId || previous?.sessionId };
        observed.set(f.id,row); found.push({ frameId:f.id, parentId:row.parentId, url:row.url });
      }
      for (const child of tree.childFrames || []) visit(child,sessionId);
    };
    const root = await send(state,'Page.getFrameTree'); visit(root.frameTree);
    for (const sessionId of state.sessions) {
      const tree = await send(state,'Page.getFrameTree',{},sessionId).catch(() => null);
      if (tree) visit(tree.frameTree,sessionId);
    }
    state.frames = observed;
    return found.filter((f,i) => found.findIndex(other => other.frameId === f.frameId) === i);
  }
  async function context(state, frameId, main = false) {
    const frames = await frameList(state);
    const frame = state.frames.get(frameId || frames[0]?.frameId);
    if (!frame) error('BROWSER_FRAME_UNAVAILABLE: choose a frameId from a fresh snapshot.');
    pageURL(frame.url);
    const key = `${frame.id}:${main ? 'main' : 'isolated'}`;
    if (!main && !state.contexts.has(key)) {
      const pageId = state.pageId;
      const created = await send(state,'Page.createIsolatedWorld',{ frameId:frame.id, worldName:`cos-browser-${state.lease}`, grantUniveralAccess:false },frame.sessionId);
      if (state.pageId !== pageId) error('BROWSER_PAGE_STALE: frame changed while observing.');
      state.contexts.set(key,{ id:created.executionContextId, sessionId:frame.sessionId });
    }
    const ctx = state.contexts.get(key);
    if (!ctx) error('BROWSER_FRAME_UNAVAILABLE: the frame has no current main-world execution context. Snapshot again after loading.');
    return ctx;
  }
  async function evaluate(state, expression, ctx, command) {
    const result = await send(state,'Runtime.evaluate',{ expression, contextId:ctx.id, returnByValue:true, awaitPromise:true, timeout:5000 },ctx.sessionId,command);
    if (result.exceptionDetails) error(`BROWSER_JAVASCRIPT_ERROR: ${cut(result.exceptionDetails.exception?.description || result.exceptionDetails.text,1200)}`);
    return result.result?.value;
  }
  async function page(state, operation, args = {}, command) {
    const pageId = state.pageId;
    const ctx = await context(state,args.frameId);
    if (state.pageId !== pageId) error('BROWSER_PAGE_STALE: snapshot again.');
    const result = await evaluate(state,`(${browserPage.toString()})(${JSON.stringify(operation)},${JSON.stringify({ ...args,pageId,lease:state.lease })})`,ctx,command);
    if (state.pageId !== pageId) error('BROWSER_PAGE_STALE: page changed while reading.');
    return result;
  }
  async function release(state) {
    if (tabs.get(state.tabId) !== state) return;
    // Revoke first: no in-flight continuation can send more input while detach yields.
    tabs.delete(state.tabId);
    await Promise.all([cleanup(removeIndicator(state)),cleanup(chrome.debugger.detach({tabId:state.tabId}))]);
    await save();
  }
  async function revoke() {
    await ready(); policy = { read:false,write:false };
    await Promise.all([...tabs.values()].map(release));
  }
  async function attach(tabId, command) {
    if (tabs.size >= 32 && !tabs.has(tabId)) error('BROWSER_TAB_LIMIT: release an unused tab first.');
    const previous = tabs.get(tabId);
    if (previous && !owns(previous, command)) error('BROWSER_TAB_OWNED: another conversation owns this attachment. browser_snapshot can inspect this same tab without attach; opening a duplicate is unnecessary for DOM review.');
    const state = previous || newState(tabId,command.owner);
    if (!previous) tabs.set(tabId,state);
    let acquired = false;
    try {
      await currentTab(state,command);
      if (!previous) {
        await save(); // Crash before/after attach never grants an automatic reattach.
        await chrome.debugger.attach({ tabId },'1.3');
        acquired = true;
      }
      if (!state.initialized) await initialize(state);
      await page(state,'overlay');
      const tab = await currentTab(state,command);
      return { tabId:handle(tabId), pageId:state.pageId, url:tab.url, title:cut(tab.title,500), attached:true };
    } catch (cause) {
      if (!previous) {
        // A preflight/attach refusal owns no debugger to detach. In particular, the
        // active-tab renderer may already own it; cleanup must not cancel that work.
        if (acquired) await release(state);
        else { if (tabs.get(tabId) === state) tabs.delete(tabId); await save(); }
      }
      throw cause;
    }
  }
  async function waitForCreatedDocument(tabId,url,command) {
    // The requested navigation starts in tabs.create, independently of our debugger.
    // Wait for a committed document, not every subresource or a temporary blank page.
    await new Promise((resolve,reject) => {
      let done = false;
      const finish = cause => {
        if(done)return;done=true;clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(changed);chrome.tabs.onRemoved.removeListener(removed);
        cause?reject(cause):resolve();
      };
      const check = () => getTab(tabId).then(tab => {
        if (!tab.url || tab.pendingUrl && tab.pendingUrl !== tab.url) return;
        if (tab.url === 'about:blank' && (url !== 'about:blank' || tab.status === 'loading')) return;
        pageURL(tab.url);finish();
      }).catch(finish);
      const changed = changedId => {if(changedId===tabId)void check();};
      const removed = removedId => {if(removedId===tabId)finish(new Error('BROWSER_TAB_CLOSED: the created tab was closed. Do not recreate it automatically.'));};
      const timer=setTimeout(()=>finish(new Error('BROWSER_CREATED_TAB_LOADING: attach this tab after it loads.')),Math.max(1,Math.min(5000,command.expiresAt-Date.now())));
      chrome.tabs.onUpdated.addListener(changed);chrome.tabs.onRemoved.addListener(removed);void check();
    });
  }
  async function owned(command) {
    const state = tabs.get(command.args.tabId);
    if (!state) {
      await getTab(command.args.tabId);
      error('BROWSER_TAB_NOT_OWNED: the tab still exists but has no live attachment. Chrome may have ended debugging or the extension restarted. Explicitly attach this same tab, then take a fresh observation. Do not open a replacement.');
    }
    if (!owns(state, command)) error('BROWSER_TAB_OWNED: another conversation owns this tab. browser_snapshot can inspect it without taking its attachment.');
    // Releasing only revokes this caller's existing lease. Do not inspect or
    // reinitialize a page that became protected, navigated, or closed meanwhile.
    if (command.tool === 'browser_tabs' && command.args.action === 'release') { alive(state,command); return state; }
    await currentTab(state,command);
    if (!state.initialized) {
      try { await initialize(state); } catch { await release(state); error('BROWSER_DETACHED: Chrome ended this debugger attachment. Attach again deliberately.'); }
    }
    return state;
  }
  async function point(state,args,command) {
    await authorize(command);
    if (args.ref) {
      if (!args.ref.startsWith(`${state.pageId}:`)) error('BROWSER_REF_STALE');
      const frameId = state.refFrames?.get(args.ref);
      if (!frameId) error('BROWSER_REF_STALE: use a current snapshot ref.');
      const frames = await frameList(state);
      const parents = [];
      let child = state.frames.get(frameId);
      while (child && child.id !== frames[0]?.frameId) {
        const parent = state.frames.get(child.parentId);
        if (!parent || parents.length >= 20) error('BROWSER_FRAME_UNAVAILABLE: snapshot again.');
        const ctx = await context(state,parent.id);
        const owner = await send(state,'DOM.getFrameOwner',{frameId:child.id},parent.sessionId,command);
        const node = await send(state,'DOM.resolveNode',{backendNodeId:owner.backendNodeId,executionContextId:ctx.id},parent.sessionId,command);
        parents.push({objectId:node.object.objectId,sessionId:parent.sessionId}); child = parent;
      }
      const transform = async (parent,value) => {
        const result = await send(state,'Runtime.callFunctionOn',{objectId:parent.objectId,functionDeclaration:browserFramePoint.toString(),arguments:[{value}],returnByValue:true},parent.sessionId,command);
        if (result.exceptionDetails) error(`BROWSER_FRAME_INPUT: ${cut(result.exceptionDetails.exception?.description || result.exceptionDetails.text)}`);
        return result.result.value;
      };
      try {
        if (!args.noScroll) for (const parent of [...parents].reverse()) await transform(parent,null);
        let result = await page(state,'point',{ ref:args.ref,frameId,noScroll:args.noScroll },command);
        const sessionId = state.frames.get(frameId)?.sessionId;
        let inputPoint = result;
        for (const parent of parents) {
          result = await transform(parent,result);
          if (parent.sessionId === sessionId) inputPoint = result;
        }
        // An OOPIF owns a separate widget. Dispatch in that widget's viewport after
        // verifying every parent hit target; background root hit-test data may lag scrolling.
        return sessionId ? {...inputPoint,__sessionId:sessionId} : result;
      } finally {
        for (const parent of parents) await send(state,'Runtime.releaseObject',{objectId:parent.objectId},parent.sessionId).catch(() => {});
      }
    }
    const shot = state.screenshot;
    if (!shot || shot.id !== args.screenshotId || shot.pageId !== state.pageId || shot.fullPage || !Number.isFinite(args.x) || !Number.isFinite(args.y)) error('BROWSER_SCREENSHOT_STALE: coordinate input needs a current viewport screenshotId and x/y.');
    const metrics = (await send(state,'Page.getLayoutMetrics',{},undefined,command)).cssVisualViewport;
    if (!metrics || ['pageX','pageY','clientWidth','clientHeight','scale'].some(key => metrics[key] !== shot.viewport[key])) error('BROWSER_VIEWPORT_CHANGED: take another screenshot.');
    if (args.x >= shot.width || args.y >= shot.height) error('BROWSER_COORDINATES_OUTSIDE_IMAGE');
    return { x:args.x / shot.scale,y:args.y / shot.scale };
  }
  function keyEvents(chord) {
    if (typeof chord !== 'string' || !chord) error('BROWSER_KEY_REQUIRED');
    const parts = chord.split('+'); let modifiers = 0;
    for (const name of parts.slice(0,-1)) {
      const bit = ({control:2,ctrl:2,shift:8,alt:1,meta:4,command:4})[name.toLowerCase()];
      if (!bit) error('BROWSER_KEY_INVALID: use Control/Shift/Alt/Meta plus one key.');
      modifiers |= bit;
    }
    const supplied = parts.at(-1);
    const special = { Enter:['Enter',13], Tab:['Tab',9], Escape:['Escape',27], Backspace:['Backspace',8], Delete:['Delete',46], ArrowLeft:['ArrowLeft',37], ArrowRight:['ArrowRight',39], ArrowUp:['ArrowUp',38], ArrowDown:['ArrowDown',40], Home:['Home',36], End:['End',35], PageUp:['PageUp',33], PageDown:['PageDown',34], Space:['Space',32] };
    const aliases = {return:'Enter',esc:'Escape',spacebar:'Space',left:'ArrowLeft',right:'ArrowRight',up:'ArrowUp',down:'ArrowDown'};
    const key = Object.keys(special).find(name => name.toLowerCase() === supplied.toLowerCase()) || aliases[supplied.toLowerCase()] || supplied;
    const named = special[key];
    if (!named && key.length !== 1) error('BROWSER_KEY_INVALID: use a character, Enter, Tab, Escape, Backspace, Delete, ArrowLeft/Right/Up/Down, Home, End, PageUp/Down or Space, optionally prefixed by Control/Shift/Alt/Meta. Named keys are case-insensitive.');
    const actual = key === 'Space' ? ' ' : key;
    const code = named?.[0] || (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : '');
    const vk = named?.[1] || key.toUpperCase().charCodeAt(0);
    return { key:actual,code,windowsVirtualKeyCode:vk,modifiers,...(!(modifiers & 7) && (actual.length === 1 || key === 'Enter') ? { text:key === 'Enter' ? '\r' : actual } : {}) };
  }
  async function action(state,args,command) {
    const a = args.action;
    if (a === 'dialog') {
      if (typeof args.accept !== 'boolean' || !state.dialog) error('BROWSER_DIALOG_REQUIRED: inspect pending dialog and specify accept.');
      await input(state,'Page.handleJavaScriptDialog',{ accept:args.accept,promptText:args.text || '' },command);
    } else if (a === 'key') {
      const key = keyEvents(args.key);
      if (args.ref) {
        await authorize(command);
        await page(state,'focus',{ref:args.ref,frameId:state.refFrames?.get(args.ref),keyTarget:true},command);
      }
      await input(state,'Input.dispatchKeyEvent',{ type:'keyDown',...key },command);
      const { text:_text,...up } = key;
      // Releasing the key has the same exact tab custody even if keyDown navigated it.
      try {
        if (args.holdMs) await new Promise(resolve => setTimeout(resolve,Math.min(2000,Math.max(0,args.holdMs))));
      } finally { await send(state,'Input.dispatchKeyEvent',{ type:'keyUp',...up }); }
    } else if (a === 'fill' || a === 'type') {
      if (typeof args.text !== 'string' || !args.ref) error('BROWSER_TEXT_TARGET_REQUIRED: pass text and an editable ref.');
      await authorize(command);
      await page(state,'focus',{ref:args.ref,frameId:state.refFrames?.get(args.ref),replace:a === 'fill'},command);
      if (a === 'fill' && !args.text) {
        await input(state,'Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8},command);
        await send(state,'Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
      } else await input(state,'Input.insertText',{text:args.text},command);
    } else if (a === 'select') {
      if (!args.ref || !Array.isArray(args.values)) error('BROWSER_SELECT_REQUIRED: pass ref and values.');
      await authorize(command); await currentTab(state,command);
      await page(state,'select',{ref:args.ref,frameId:state.refFrames?.get(args.ref),values:args.values},command);
    } else {
      const from = await point(state,args,command);
      if (a === 'scroll') {
        await input(state,'Input.dispatchMouseEvent',{type:'mouseWheel',...from,deltaX:args.deltaX || 0,deltaY:args.deltaY || 0},command);
      } else {
        await input(state,'Input.dispatchMouseEvent',{type:'mouseMoved',...from},command);
        if (a === 'click') {
          const button = args.button || 'left';
          for (let count = 1; count <= (args.clickCount || 1); count++) {
            await input(state,'Input.dispatchMouseEvent',{type:'mousePressed',...from,button,clickCount:count},command);
            await send(state,'Input.dispatchMouseEvent',{type:'mouseReleased',...from,button,clickCount:count});
          }
        } else if (a === 'drag') {
          const to = await point(state,{ref:args.toRef,x:args.toX,y:args.toY,screenshotId:args.screenshotId},command);
          if (to.__sessionId !== from.__sessionId) error('BROWSER_DRAG_FRAME: use one viewport screenshot for a drag across frame widgets.');
          // Resolving the destination may scroll. Require a stable viewport for both ends.
          const checkedFrom = await point(state,{...args,noScroll:true},command);
          if (checkedFrom.x !== from.x || checkedFrom.y !== from.y) error('BROWSER_DRAG_MOVED: choose endpoints in one viewport screenshot.');
          await input(state,'Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',clickCount:1},command);
          try {
            for (let step = 1; step <= 12; step++) await input(state,'Input.dispatchMouseEvent',{type:'mouseMoved',...from,x:from.x+(to.x-from.x)*step/12,y:from.y+(to.y-from.y)*step/12,button:'left',buttons:1},command);
          } finally { await send(state,'Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left',clickCount:1}).catch(() => {}); }
        } else if (a !== 'hover') error('BROWSER_ACTION_UNKNOWN');
      }
    }
    state.screenshot = null;
    return { tabId:handle(state.tabId),pageId:state.pageId,accepted:true,message:'Input dispatched; observe the page to verify the effect.' };
  }
  async function screenshot(state,args,command) {
    const pageId = state.pageId;
    const metrics = await send(state,'Page.getLayoutMetrics');
    const viewport = metrics.cssVisualViewport;
    const rect = args.fullPage ? metrics.cssContentSize : {x:viewport.pageX,y:viewport.pageY,width:viewport.clientWidth,height:viewport.clientHeight};
    if (!(rect.width > 0 && rect.height > 0) || rect.width > 100000 || rect.height > 100000) error('BROWSER_CAPTURE_DIMENSIONS');
    const scale = Math.min(1,1600/Math.max(rect.width,rect.height));
    const width = Math.round(rect.width*scale),height = Math.round(rect.height*scale);
    const result = await send(state,'Page.captureScreenshot',{format:'jpeg',quality:80,fromSurface:true,captureBeyondViewport:args.fullPage === true,clip:{...rect,scale}},undefined,command);
    if (state.pageId !== pageId) error('BROWSER_PAGE_STALE: screenshot crossed navigation.');
    if (!result.data || result.data.length > 1_600_000) error('BROWSER_SCREENSHOT_TOO_LARGE');
    const shot = {id:id(),pageId,width,height,scale,viewport,fullPage:args.fullPage === true}; state.screenshot = shot;
    return { value:{tabId:handle(state.tabId),pageId,screenshotId:shot.id,width,height,scale,fullPage:shot.fullPage},image:{mimeType:'image/jpeg',data:result.data} };
  }
  async function diagnostics(state,tool,args) {
    const network = tool === 'browser_network';
    if (network && args.requestId) {
      const row = state.network.get(args.requestId);
      if (!row) error('BROWSER_REQUEST_EXPIRED: request is not in the retained buffer.');
      let body;
      if (args.body) {
        if (row.encodedBytes > 500000) body = { unavailable:'Response exceeds the 500 KB capture limit.' };
        else try {
          const data = await send(state,'Network.getResponseBody',{requestId:row.nativeId},row.sessionId);
          body = { text:cut(data.body,20000),base64Encoded:data.base64Encoded === true,truncated:data.body.length > 20000 };
        } catch { body = { unavailable:'Chrome no longer retains this response body, or it has not completed.' }; }
      }
      const { nativeId:_native,sessionId:_session,...value } = row;
      return { ...value,...(body ? {body}: {}) };
    }
    const rows = network ? [...state.network.values()] : state.console;
    const matching = rows.filter(row => row.seq > (args.after || 0) &&
      (!args.filter || JSON.stringify(row).toLowerCase().includes(args.filter.toLowerCase())) &&
      (network || !args.level || args.level === 'all' || row.level === args.level)).sort((a,b) => a.seq-b.seq);
    const selected = matching.slice(0,args.limit || 50);
    const values = []; let size = 0;
    for (const row of selected) {
      const { nativeId:_native,sessionId:_session,requestHeaders:_rq,responseHeaders:_rs,postData:_post,...brief } = row;
      const value = network ? brief : row;
      size += JSON.stringify(value).length;
      if (size > 24000) break;
      values.push(value);
    }
    if (args.clear) { if (network) state.network.clear(); else state.console = []; }
    return { entries:values,nextCursor:values.at(-1)?.seq || args.after || 0,truncated:values.length < matching.length,dropped:network ? state.networkDropped : state.consoleDropped,capture:'Since debugger attachment; older events are unavailable.' };
  }
  async function inspect(command) {
    const args = command.args;
    await authorize(command, false);
    const tab = await getTab(args.tabId);
    pageURL(tab.url);
    const documentId = args.frameId?.startsWith('document:') ? args.frameId.slice('document:'.length) : undefined;
    // Chrome's documentId is opaque, unlike our own page UUID. Preserve its bytes.
    if (args.frameId && (!documentId || args.frameId.length > 100)) error('BROWSER_FRAME_UNAVAILABLE: unattached inspection uses document: frameIds. Omit frameId to read the current top document.');
    // This fixed reader does not claim a debugger, retain references, change focus,
    // touch an overlay or evaluate model-authored JavaScript. Chrome supplies document proof.
    let result, timer;
    try {
      result = await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId: args.tabId, ...(documentId ? { documentIds: [documentId] } : { frameIds: [0] }) },
          world: 'ISOLATED', func: browserPage,
          args: ['inspect', { selector: args.selector, format: args.format, filter: args.filter, maxNodes: args.maxNodes || 300, maxChars: args.maxChars || 16000 }]
        }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('BROWSER_INSPECTION_TIMEOUT: Chrome did not return the DOM observation. The tab and its debugger were left unchanged.')),
          Math.max(1, Math.min(8000, command.expiresAt - Date.now()))); })
      ]);
    } finally { clearTimeout(timer); }
    if (command.epoch !== epoch || command.expiresAt <= Date.now()) error('BROWSER_EXPIRED: the DOM inspection result expired. No input was dispatched.');
    await authorize(command, false);
    const captured = result[0];
    if (documentId && captured?.documentId !== documentId) error('BROWSER_FRAME_UNAVAILABLE: the requested document is no longer available. Omit frameId to inspect the current top document.');
    if (typeof captured?.result?.error === 'string') error(cut(captured.result.error, 1000));
    if (!captured?.documentId || !captured.result || typeof captured.result.text !== 'string') error('BROWSER_INSPECTION_UNAVAILABLE: Chrome returned no DOM observation for that document.');
    const { refs: _refs, ...value } = captured.result;
    return { value: { ...value, tabId: handle(args.tabId), documentId: captured.documentId,
      frameId: `document:${captured.documentId}`, inspectionOnly: true,
      message: 'DOM inspection only; no action refs were created. Attach an eligible tab for browser input.' } };
  }
  async function execute(command) {
    if (command.epoch !== epoch || command.expiresAt <= Date.now()) error('BROWSER_EXPIRED: no operation dispatched.');
    const {tool,args} = command;
    const writes = ['browser_action','browser_navigate','browser_evaluate'].includes(tool) || tool === 'browser_tabs' && ['new','close'].includes(args.action);
    if (!(writes ? policy.write : policy.read)) error('BROWSER_PERMISSION_REVOKED');
    if (tool === 'browser_tabs') {
      if (args.action === 'list') {
        const list = await chrome.tabs.query({});
        const matched=list.filter(t=>(/^https?:/.test(t.url || t.pendingUrl || '') || t.url === 'about:blank')&&(!args.filter || `${t.title} ${t.url} ${t.pendingUrl || ''}`.toLowerCase().includes(args.filter.toLowerCase())));
        const values=[];let size=0;
        for(const tab of matched.slice(args.offset || 0,(args.offset || 0)+(args.limit || 100))) {
          const attached=owns(tabs.get(tab.id),command),claimed=tabs.has(tab.id),protectedPage=protectedTab(tab.id,tab.url,command.conversationId);
          const navigating=!tab.url || !!tab.pendingUrl && tab.pendingUrl!==tab.url;
          const value={tabId:handle(tab.id),title:cut(tab.title,300),url:cut(tab.url,2000),urlTruncated:(tab.url?.length || 0)>2000,active:tab.active,pinned:tab.pinned,
            pendingUrl:tab.pendingUrl?cut(tab.pendingUrl,2000):undefined,pendingUrlTruncated:(tab.pendingUrl?.length || 0)>2000,status:tab.status || 'unknown',
            owned:attached,claimed,protected:protectedPage,access:{
              snapshot:navigating?'loading':attached?'interactive':tab.url==='about:blank'?'attach-required':'inspect',
              input:protectedPage?'protected':claimed&&!attached?'other-owner':!policy.write?'disabled':navigating?'loading':attached?'available':'attach-required'
            }};
          size+=JSON.stringify(value).length;if(size>24000)break;values.push(value);
        }
        const nextOffset=(args.offset || 0)+values.length;
        return {value:{browserId,tabs:values,total:matched.length,truncated:nextOffset<matched.length,nextOffset:nextOffset<matched.length?nextOffset:null,
          guidance:'Use browser_snapshot on this Desktop connector to inspect an existing HTTP(S) tab, including protected or foreign-owned tabs. access.input describes interaction separately. External browser plugins use separate tabs and handles.'}};
      }
      if (args.action === 'attach') return {value:await attach(args.tabId,command)};
      if (args.action === 'new') {
        const url = pageURL(args.url || 'about:blank');
        if (tabs.size >= 32) error('BROWSER_TAB_LIMIT: release an unused attachment before opening another tab.');
        await authorize(command);
        const tab = await chrome.tabs.create({url,active:false});
        // Creation is already accepted. Preserve that receipt even when attachment fails.
        // In particular, an unavailable debugger must not strand the requested URL on blank.
        try {
          await waitForCreatedDocument(tab.id,url,command);
          await authorize(command);
          const value = await attach(tab.id,command);
          return {value:{...value,created:true,navigationRequested:url,message:'Snapshot this tab to inspect the current destination.'}};
        } catch (cause) {
          return {value:{tabId:handle(tab.id),created:true,attached:false,navigationRequested:url,attachmentError:cut(cause?.message || cause,1000),
            message:'The tab was created and its requested navigation started; attachment did not complete. Do not repeat new. Inspect this tab if it still exists; attach the same tab only when interaction is needed and available.'}};
        }
      }
      const state = await owned(command);
      if (args.action === 'release') { await release(state); return {value:{tabId:handle(state.tabId),released:true}}; }
      if (args.action === 'close') { await authorize(command); await currentTab(state,command); await chrome.tabs.remove(state.tabId); await release(state); return {value:{tabId:handle(state.tabId),closed:true}}; }
      error('BROWSER_TABS_ACTION_UNKNOWN');
    }
    const existing = tabs.get(args.tabId);
    if (tool === 'browser_snapshot' && (args.mode === 'inspect' || !owns(existing, command))) return inspect(command);
    const state = await owned(command);
    if (tool === 'browser_snapshot') {
      if (state.dialog) return {value:{tabId:handle(state.tabId),pageId:state.pageId,dialog:state.dialog,text:'A JavaScript dialog is open. Use browser_action dialog before inspecting the DOM.'}};
      const frames = await frameList(state),frameId = args.frameId || frames[0]?.frameId;
      const {refs,...value} = await page(state,'snapshot',{...args,frameId});
      // Each snapshot replaces refs only in its own frame; other inspected frames remain valid.
      state.refFrames ||= new Map();
      for (const [ref,frame] of state.refFrames) if (frame === frameId || !ref.startsWith(`${state.pageId}:`)) state.refFrames.delete(ref);
      for (const ref of refs) state.refFrames.set(ref,frameId);
      return {value:{...value,tabId:handle(state.tabId),pageId:state.pageId,frameId,frames,dialog:state.dialog}};
    }
    if (tool === 'browser_screenshot') return screenshot(state,args,command);
    if (tool === 'browser_action') return {value:await action(state,args,command)};
    if (tool === 'browser_navigate') {
      if (args.action === 'url') {
        const url = pageURL(args.url);
        const result = await input(state,'Page.navigate',{url},command);
        if (result.errorText) error(`BROWSER_NAVIGATION_FAILED: ${cut(result.errorText)}`);
      } else if (args.action === 'reload') await input(state,'Page.reload',{},command);
      else {
        const history = await send(state,'Page.getNavigationHistory');
        const next = history.entries[history.currentIndex + (args.action === 'back' ? -1 : 1)];
        if (!next) error('BROWSER_HISTORY_EMPTY');
        pageURL(next.url);
        await input(state,'Page.navigateToHistoryEntry',{entryId:next.id},command);
      }
      invalidate(state);
      return {value:{tabId:handle(state.tabId),accepted:true,message:'Navigation requested. Snapshot again when the destination loads.'}};
    }
    if (tool === 'browser_evaluate') {
      const ctx = await context(state,args.frameId,true);
      await authorize(command); await currentTab(state,command);
      const value = await evaluate(state,`(async()=>{const value=await (${args.expression});return (${boundedBrowserValue.toString()})(value);})()`,ctx,command);
      state.screenshot = null;
      return {value:{tabId:handle(state.tabId),pageId:state.pageId,...value}};
    }
    if (tool === 'browser_console' || tool === 'browser_network') return {value:await diagnostics(state,tool,args)};
    error('BROWSER_TOOL_UNKNOWN');
  }
  const headers = value => {
    const result = {}; let size = 0;
    for (const [key,val] of Object.entries(value || {}).slice(0,50)) {
      if (/authorization|cookie|token|api.?key/i.test(key)) { result[key] = '[redacted]'; continue; }
      const text = cut(val,1000); size += key.length+text.length;
      if (size > 6000) break; result[cut(key,100)] = text;
    }
    return result;
  };
  async function event(source,method,params) {
    await ready(); const state = tabs.get(source.tabId); if (!state) return;
    if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe') {
      if (state.sessions.size >= 32) return;
      state.sessions.add(params.sessionId);
      await initialize(state,params.sessionId).catch(() => state.sessions.delete(params.sessionId));
    } else if (method === 'Target.detachedFromTarget') {
      state.sessions.delete(params.sessionId); invalidate(state);
    } else if (method === 'Runtime.executionContextCreated') {
      const ctx = params.context;
      if (ctx?.auxData?.isDefault && ctx.auxData.frameId) state.contexts.set(`${ctx.auxData.frameId}:main`,{id:ctx.id,sessionId:source.sessionId});
    } else if (method === 'Runtime.executionContextsCleared') {
      for (const [key,ctx] of state.contexts) if (ctx.sessionId === source.sessionId) state.contexts.delete(key);
      invalidate(state);
    } else if (method === 'Runtime.executionContextDestroyed') {
      for (const [key,ctx] of state.contexts) if (ctx.id === params.executionContextId && ctx.sessionId === source.sessionId) state.contexts.delete(key);
    } else if (method === 'Page.frameNavigated') {
      invalidate(state);
      if (params.frame?.id) state.frames.set(params.frame.id,{...params.frame,sessionId:source.sessionId});
      // Reinstall the indicator after real document navigation, without a timer or page activation.
      if (!params.frame?.parentId && !source.sessionId && /^https?:/.test(params.frame?.url)) void page(state,'overlay').catch(() => {});
    } else if (method === 'Page.navigatedWithinDocument') {
      invalidate(state);
    } else if (method === 'Page.javascriptDialogOpening') {
      state.dialog = {type:params.type,message:cut(params.message,2000),defaultPrompt:cut(params.defaultPrompt,1000)};
    } else if (method === 'Page.javascriptDialogClosed') state.dialog = null;
    else if (['Runtime.consoleAPICalled','Runtime.exceptionThrown','Log.entryAdded'].includes(method)) {
      const data = params.exceptionDetails || params.entry || params;
      let level = params.exceptionDetails ? 'error' : data.level || data.type || 'info';
      level = ({warn:'warning',log:'info',verbose:'debug'})[level] || level;
      const message = params.args ? params.args.slice(0,10).map(a => cut(a.value ?? a.description ?? a.type,1200)).join(' ') : cut(data.exception?.description || data.text,2500);
      state.console.push({seq:++state.seq,pageId:state.pageId,level,message:cut(message,3000),url:cut(data.url,1000),timestamp:Date.now()});
      if (state.console.length > 200) { state.console.shift(); state.consoleDropped++; }
    } else if (method.startsWith('Network.') && params.requestId) {
      const key = `${source.sessionId || 'main'}:${params.requestId}`;
      let row = state.network.get(key);
      if (method === 'Network.requestWillBeSent') {
        row = {requestId:key,nativeId:params.requestId,sessionId:source.sessionId,pageId:state.pageId,url:cut(params.request?.url,2000),method:cut(params.request?.method,20),type:cut(params.type,30),requestHeaders:headers(params.request?.headers),postData:cut(params.request?.postData,4000),startedAt:params.timestamp,seq:++state.seq};
        state.network.set(key,row);
        if (state.network.size > 200) {state.network.delete(state.network.keys().next().value);state.networkDropped++;}
      } else if (row) {
        row.seq = ++state.seq;
        if (method === 'Network.responseReceived') Object.assign(row,{status:params.response?.status,mimeType:cut(params.response?.mimeType,100),responseHeaders:headers(params.response?.headers),fromCache:params.response?.fromDiskCache === true});
        if (method === 'Network.loadingFinished') Object.assign(row,{finished:true,encodedBytes:params.encodedDataLength,durationMs:Math.round((params.timestamp-row.startedAt)*1000)});
        if (method === 'Network.loadingFailed') Object.assign(row,{failed:cut(params.errorText,1000),finished:true});
      }
    }
  }
  async function detached(source) {
    await ready(); const state = tabs.get(source.tabId); if (!state) return;
    tabs.delete(source.tabId); await save();
    await cleanup(removeIndicator(state));
  }
  async function pumpOnce() {
    await ready();
    const enabled = await chrome.permissions.contains({permissions:['debugger','tabs']});
    if (receipt) {
      const ack = await transport('/browser-control',{method:'POST',body:JSON.stringify({action:'result',browserId,...receipt})});
      if (!ack.ok && ack.status !== 409) return;
      receipt = null; await save();
    }
    const poll = await transport('/browser-control',{method:'POST',body:JSON.stringify({action:'poll',browserId,name:/Edg\//.test(navigator.userAgent) ? 'Edge' : 'Chrome / Chromium',enabled})});
    if (!poll.ok) { if (poll.status === 401 || poll.status === 426) await revoke(); return; }
    policy = poll.data.policy;
    if (epoch !== poll.data.epoch) { await Promise.all([...tabs.values()].map(release)); epoch = poll.data.epoch; await save(); }
    if (!enabled || !policy?.read) { await revoke(); return; }
    for (const request of poll.data.requests || []) {
      const owners = [...new Set([...tabs.values()].map(state => state.owner).filter(owner => owner.startsWith('request:')))];
      const claim = await transport('/browser-control',{method:'POST',body:JSON.stringify({action:'claim',browserId,id:request,epoch,owners})});
      if (!claim.ok || !claim.data.command) continue;
      let result;
      try { result = await execute(claim.data.command); }
      catch (cause) { result = {error:cut(cause?.message || cause,1500)}; }
      if (new TextEncoder().encode(JSON.stringify(result)).length > 1_800_000) result = {error:'BROWSER_RESULT_TOO_LARGE: operation may have completed; inspect before repeating.'};
      receipt = {id:request,epoch,result}; await save();
      const ack = await transport('/browser-control',{method:'POST',body:JSON.stringify({action:'result',browserId,...receipt})});
      if (!ack.ok && ack.status !== 409) return;
      receipt = null; await save();
    }
  }
  function pump() {
    if (pumping) {again = true;return pumping;}
    pumping = (async () => { do {again = false;await pumpOnce();} while (again); })().finally(() => {pumping = null;});
    return pumping;
  }
  return {pump,event,detached,revoke,execute,ready};
}
