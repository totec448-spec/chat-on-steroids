/** Fixed DOM reader/target helper in an isolated world. No extension token enters the page. */
export function browserPage(operation, args) {
  const key = '__cosBrowserControl';
  // Inspection must not overwrite another caller's interactive references or overlay.
  const inspection = operation === 'inspect';
  let state = inspection ? { refs: new Map(), next: 0, pageId: args.pageId } : globalThis[key];
  if (!state || state.pageId !== args.pageId) {
    const overlay = state?.overlay?.isConnected ? state.overlay : null;
    state = globalThis[key] = { pageId: args.pageId, refs: new Map(), next: 0, overlay };
  }
  const compact = (value, max = 200) => String(value ?? '').slice(0, max * 4).replace(/\s+/g, ' ').trim().slice(0, max);
  const textOf = (element, excludeControls = false) => {
    if (!element) return '';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text = '', node, count = 0;
    while (text.length < 800 && count++ < 100 && (node = walker.nextNode())) {
      if (excludeControls && node.parentElement?.closest('select,textarea')) continue;
      text += node.nodeValue.slice(0, 800 - text.length);
    }
    return compact(text);
  };
  const fail = message => { throw new Error(message); };
  const visible = (element, subtree = false) => {
    const style = getComputedStyle(element);
    return !element.closest('[inert]') && style.display !== 'none' && style.visibility !== 'hidden' &&
      (element.getClientRects().length > 0 || subtree && style.display === 'contents');
  };
  const resolve = ref => {
    const element = state.refs.get(ref);
    if (!element?.isConnected || !visible(element)) fail('BROWSER_REF_STALE: snapshot again; the element is gone or hidden.');
    if (element.matches(':disabled,[aria-disabled="true"]')) fail('BROWSER_ELEMENT_DISABLED');
    return element;
  };
  const label = element => {
    const ids = compact(element.getAttribute('aria-labelledby'), 500).split(' ').filter(Boolean);
    const labelled = ids.map(id => textOf(element.getRootNode().getElementById?.(id))).join(' ');
    return compact(element.getAttribute('aria-label') || labelled ||
      (element.labels ? Array.from(element.labels).slice(0, 5).map(node => textOf(node, true)).join(' ') : '') ||
      element.getAttribute('alt') || element.getAttribute('title') || element.getAttribute('placeholder') ||
      (element.tagName === 'INPUT' && ['button','submit','reset'].includes(element.type) ? element.value : '') || textOf(element));
  };

  if (operation === 'overlay') {
    state.overlay?.remove();
    const host = document.createElement('div');
    host.setAttribute('data-cos-browser-control', args.lease);
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;display:block!important;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const glow = document.createElement('div');
    glow.style.cssText = 'position:fixed;inset:0;box-shadow:inset 0 0 20px #3984ff99,inset 0 0 52px #3984ff55;pointer-events:none;';
    shadow.append(glow); document.documentElement.append(host); state.overlay = host;
    return true;
  }
  if (operation === 'removeOverlay') { state.overlay?.remove(); state.overlay = null; return true; }

  if (operation === 'snapshot' || inspection) {
    let root = document.body || document.documentElement;
    if (args.selector) {
      let scopeError;
      try { root = document.querySelector(args.selector); }
      catch { scopeError = 'BROWSER_SELECTOR_INVALID: selector must be valid CSS.'; }
      if (!scopeError && !root) scopeError = 'BROWSER_SELECTOR_NOT_FOUND: the requested subtree is absent. Inspect the page or choose a current selector.';
      if (scopeError) {
        // scripting.executeScript does not serialize a thrown page exception as a result.
        if (inspection) return { error: scopeError };
        fail(scopeError);
      }
    }
    // An explicit new snapshot replaces refs, preventing ref reuse after node replacement.
    state.refs.clear();
    const lines = []; let chars = 0, visited = 0, emitted = 0, elements = 0, truncated = false;
    const append = line => {
      if (emitted >= args.maxNodes || chars + line.length + 1 > args.maxChars) { truncated = true; return false; }
      lines.push(line); chars += line.length + 1; emitted++; return true;
    };
    const filter = (args.filter || '').toLocaleLowerCase();
    const dom = args.format === 'dom';
    const details = node => {
      const attributes = [];let attributeChars = 0, seen = 0;
      for (const attribute of node.attributes) {
        if (++seen > 100) {truncated = true;break;}
        if (!/^(?:id|class|role|name|type|href|src|title|placeholder|contenteditable|tabindex|disabled|hidden|aria-[\w-]+|data-[\w-]+)$/.test(attribute.name)) continue;
        const name = attribute.name.slice(0,100), value = attribute.value.slice(0,300);
        if (name.length < attribute.name.length || value.length < attribute.value.length) truncated = true;
        const text = `${name}=${JSON.stringify(value)}`;
        if (attributes.length >= 16 || attributeChars + text.length > 1600) {truncated = true;break;}
        attributes.push(text);attributeChars += text.length;
      }
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      const box = [rect.left,rect.top,rect.width,rect.height].map(v=>Math.round(v*10)/10);
      const css = ['display','visibility','position','overflow','pointer-events','opacity'].map(name=>`${name}=${compact(style.getPropertyValue(name),80)}`).join(' ');
      return `<${node.tagName.toLowerCase()}${attributes.length?' '+attributes.join(' '):''}> rect=${JSON.stringify(box)} ${css}`;
    };
    const implicit = { A: 'link', BUTTON: 'button', TEXTAREA: 'textbox', SELECT: 'combobox', CANVAS: 'canvas', IMG: 'img', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', SUMMARY: 'button' };
    const stack = [{ node: root, depth: 0, namedParent: false }];
    while (stack.length) {
      if (++visited > 15000 || emitted >= args.maxNodes || chars >= args.maxChars) { truncated = true; break; }
      const { node, depth, namedParent } = stack.pop();
      if (node.nodeType === Node.TEXT_NODE) {
        if (namedParent) continue; // The ancestor's accessible name already includes this text.
        const text = compact(node.nodeValue, 500);
        if (text && (!filter || text.toLocaleLowerCase().includes(filter))) {
          const line = `${'  '.repeat(Math.min(depth, 16))}${text}`;
          if (!append(line)) break;
        }
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || node === state.overlay ||
          ['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','HEAD'].includes(node.tagName) || !visible(node, true)) continue;
      let role = compact(node.getAttribute('role'), 50) || implicit[node.tagName];
      if (node.tagName === 'INPUT') role = ({ checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button' })[node.type] || 'textbox';
      const editingHost = node.isContentEditable && !node.parentElement?.isContentEditable;
      if (!role && (editingHost || node.tabIndex >= 0 || node.hasAttribute('onclick'))) role = editingHost ? 'textbox' : 'interactive';
      const named = role && ['button','link','textbox','checkbox','radio','combobox','slider','img','heading','interactive'].includes(role);
      let name = '';
      if (role || dom) {
        name = role ? label(node) : '';
        const detail = dom ? details(node) : '';
        // Native option popups need no DOM visibility or individual ref: select
        // consumes the parent ref and exact values. Bound discovery at its owner.
        const options = [];
        if (node.tagName === 'SELECT') {
          for (let i = 0; i < Math.min(node.options.length, 200); i++) {
            const option = node.options[i];
            const flags = [option.selected ? 'selected' : '', node.disabled || option.disabled || option.parentElement?.disabled ? 'disabled' : ''].filter(Boolean);
            // Values are opaque input identifiers: whitespace must survive exactly.
            if (option.value.length > 1000) { flags.push('value truncated'); truncated = true; }
            options.push(`option ${JSON.stringify(compact(option.label))} value=${JSON.stringify(option.value.slice(0, 1000))}${flags.length ? ` (${flags.join(', ')})` : ''}`);
          }
          if (node.options.length > options.length) truncated = true;
        }
        const matches = !filter || `${role || ''} ${name} ${detail}`.toLocaleLowerCase().includes(filter);
        if (matches || options.some(option => option.toLocaleLowerCase().includes(filter))) {
          const id = role && !inspection ? `${args.pageId}:${args.frameId}:e${++state.next}` : null;
          const flags = [node.matches(':disabled,[aria-disabled="true"]') ? 'disabled' : '', node.checked ? 'checked' : '', node.getAttribute('aria-expanded') ? `expanded=${node.getAttribute('aria-expanded')}` : '', document.activeElement === node ? 'focused' : ''].filter(Boolean);
          const value = ['INPUT','TEXTAREA','SELECT'].includes(node.tagName) && node.type !== 'password' ? compact(node.value, 200) : '';
          const href = node.tagName === 'A' ? compact(node.getAttribute('href'), 300) : '';
          const line = `${'  '.repeat(Math.min(depth, 16))}${id ? `[${id}] ` : ''}${detail ? detail+' ' : ''}${role ? `${role} ${JSON.stringify(name)}` : ''}${value ? ` value=${JSON.stringify(value)}` : ''}${href && !dom ? ` href=${JSON.stringify(href)}` : ''}${flags.length ? ` (${flags.join(', ')})` : ''}`;
          if (!append(line)) break;
          elements++;
          if (id) state.refs.set(id, node);
          for (const option of options) {
            if ((matches || option.toLocaleLowerCase().includes(filter)) && !append(`${'  '.repeat(Math.min(depth + 1, 16))}${option}`)) break;
          }
        }
      }
      if (node.tagName === 'SELECT') continue; // Options were emitted with their owning ref above.
      // Named containers (headings, cards, comboboxes) can contain independently
      // actionable links/editors. Traverse them without duplicating their label text.
      if (depth >= 40) { truncated = true; continue; }
      // Reverse iteration avoids allocating a full array for a huge DOM parent.
      const roots = node.shadowRoot ? [node, node.shadowRoot] : [node];
      for (const root of roots) {
        let child = root.lastChild, count = 0;
        // A name supplied by ARIA/labels does not include the container's body.
        // Only suppress text actually represented by a short content-derived name.
        const consumesText = named && ['button','link','heading','img'].includes(role) && name === textOf(node) && name.length < 200;
        while (child && stack.length < 15000 && count++ < 15000) { stack.push({ node: child, depth: depth + (role || dom ? 1 : 0), namedParent: namedParent || !!consumesText }); child = child.previousSibling; }
        if (child) truncated = true;
      }
    }
    return { title: compact(document.title, 500), url: location.href.slice(0, 8192), readyState: document.readyState,
      visibility: document.visibilityState, focused: document.hasFocus(), pointerLocked: !!document.pointerLockElement,
      text: lines.join('\n'), truncated, visited, elements, refs: [...state.refs.keys()] };
  }

  const element = resolve(args.ref);
  if (operation === 'point') {
    const before = element.getBoundingClientRect();
    if (!args.noScroll && (before.left < 0 || before.top < 0 || before.right > innerWidth || before.bottom > innerHeight)) element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = element.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) fail('BROWSER_ELEMENT_OFFSCREEN: inspect the target before dragging.');
    // Inline/multiline links and partly covered controls need a point in an actual
    // client rect, not the empty/covered center of the combined bounding box.
    let blocker = '';
    const boxes = element.getClientRects();
    for (let i = 0; i < Math.min(boxes.length,20); i++) {
      const box = boxes[i];
      const left = Math.max(0,box.left), top = Math.max(0,box.top);
      const width = Math.min(innerWidth,box.right)-left, height = Math.min(innerHeight,box.bottom)-top;
      if (width <= 0 || height <= 0) continue;
      for (const [fx,fy] of [[.5,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]]) {
        const x = left+width*fx, y = top+height*fy;
        let hit = document.elementFromPoint(x,y);
        while (hit?.shadowRoot?.elementFromPoint(x,y) && hit.shadowRoot.elementFromPoint(x,y) !== hit) hit = hit.shadowRoot.elementFromPoint(x,y);
        if (hit && (hit === element || element.contains(hit))) return {x,y};
        if (!blocker && hit) blocker = `${hit.tagName.toLowerCase()} ${JSON.stringify(label(hit))}`;
      }
    }
    fail(`BROWSER_ELEMENT_OBSTRUCTED: target ${JSON.stringify(label(element))} is covered${blocker ? ` by ${blocker}` : ''}. No click was dispatched. Inspect a fresh snapshot or screenshot.`);
  }
  if (operation === 'focus') {
    if (!args.keyTarget && !(element.matches('input,textarea') || element.isContentEditable)) fail('BROWSER_NOT_EDITABLE');
    if (element.readOnly) fail('BROWSER_ELEMENT_READONLY');
    if (element.matches('input[type="file"]')) fail('BROWSER_FILE_INPUT: use an explicit file upload workflow.');
    element.focus({ preventScroll: true });
    let focused = document.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    if (focused !== element) fail('BROWSER_FOCUS_FAILED');
    if (args.replace) {
      if (element.matches('input,textarea') && typeof element.select === 'function') {
        try { element.select(); if (element.selectionStart !== 0 || element.selectionEnd !== element.value.length) fail('BROWSER_SELECTION_FAILED'); }
        catch { fail('BROWSER_INPUT_TYPE: this input cannot select text. Use browser_evaluate with its native setter.'); }
      } else {
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      }
    }
    return true;
  }
  if (operation === 'select') {
    if (element.tagName !== 'SELECT') fail('BROWSER_NOT_SELECT');
    const values = args.values;
    if (!element.multiple && values.length !== 1) fail('BROWSER_SELECT_VALUES');
    const options = Array.from(element.options);
    if (values.some(value => !options.some(option => option.value === value && !option.disabled && !option.parentElement?.disabled))) fail('BROWSER_OPTION_UNAVAILABLE');
    for (const option of options) option.selected = values.includes(option.value);
    element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
    return { values: options.filter(o => o.selected).map(o => o.value) };
  }
  fail('BROWSER_OPERATION_UNKNOWN');
}

/** Bounded serialization runs at the producer, before CDP copies a value into the worker. */
export function boundedBrowserValue(value) {
  let budget = 20000, truncated = false;
  const seen = new WeakSet();
  const read = (v, depth) => {
    if (budget <= 0) { truncated = true; return '[truncated]'; }
    if (v === null || typeof v === 'boolean' || typeof v === 'number') { budget -= 20; return v; }
    if (typeof v === 'string') { const result = v.slice(0, Math.max(0, Math.min(budget, 12000))); budget -= result.length; if (result.length < v.length) { truncated = true; return result + '…[truncated]'; } return result; }
    if (typeof v !== 'object') return String(v).slice(0, 100);
    if (seen.has(v)) return '[circular]';
    if (depth >= 5) { truncated = true; return '[depth limit]'; }
    seen.add(v);
    if (v instanceof Node) return { node: v.nodeName, text: read(v.nodeValue?.slice(0,1000), depth + 1) };
    const result = Array.isArray(v) ? [] : Object.create(null);
    let count = 0;
    for (const key in v) {
      if (!Object.prototype.hasOwnProperty.call(v,key)) continue;
      if (++count > 100 || budget <= 0) { truncated = true; result[Array.isArray(v) ? result.length : '__truncated'] = true; break; }
      const descriptor = Object.getOwnPropertyDescriptor(v,key);
      budget -= key.length + 4;
      const item = descriptor && 'value' in descriptor ? read(descriptor.value, depth + 1) : '[accessor]';
      // Never assign an attacker-controlled sparse array index (JSON would expand its holes).
      if (Array.isArray(result)) result.push(item);
      else { if (key.length > 200) truncated = true; result[key.slice(0,200)] = item; }
    }
    return result;
  };
  const result = read(value,0);
  return { value: result, truncated: truncated || budget <= 0 };
}

/** Called on the actual iframe element in its parent's isolated world. */
export function browserFramePoint(point) {
  if (!point) { this.scrollIntoView({block:'center',inline:'center',behavior:'instant'}); return true; }
  const rect = this.getBoundingClientRect();
  const transform = getComputedStyle(this).transform;
  if (transform !== 'none') {
    const matrix = new DOMMatrixReadOnly(transform);
    if (!matrix.is2D || matrix.b || matrix.c || matrix.a <= 0 || matrix.d <= 0) throw new Error('BROWSER_FRAME_TRANSFORM: use screenshot coordinates for this transformed frame.');
  }
  const x = rect.left + (this.clientLeft + point.x) * rect.width / this.offsetWidth;
  const y = rect.top + (this.clientTop + point.y) * rect.height / this.offsetHeight;
  let hit = document.elementFromPoint(x,y);
  while (hit?.shadowRoot?.elementFromPoint(x,y) && hit.shadowRoot.elementFromPoint(x,y) !== hit) hit = hit.shadowRoot.elementFromPoint(x,y);
  if (hit !== this || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('BROWSER_FRAME_OBSTRUCTED: inspect a fresh screenshot.');
  return {x,y};
}
