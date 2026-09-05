const webext = globalThis.browser ?? globalThis.chrome;

/**
 * Status UI, and the one place that answers "where did the stream stop?".
 *
 * Everything this browser observes has to survive three hand-offs before the desktop app
 * has it: this extension reads it off the page, the service worker delivers it, and the
 * app records it into a session for this chat. All three used to fail the same way from
 * here — nothing happens — so "Reaching the app" opens onto those three stages stated
 * separately, and names the one that did not complete.
 *
 * It opens itself when something is wrong and stays shut when nothing is, because a panel
 * that is always expanded is a panel nobody reads.
 */

const $ = (id) => document.getElementById(id);
const RENDER_STREAM_KEY = 'renderStreamEnabled';
const SHOW_TIMES_KEY = 'showStreamTimes';
const REPLACE_WORKER_DRAFTS_KEY = 'replaceWorkerDrafts';
const POLL_MS = 1500;

let overwriteEnabled = true;
let showTimes = false;
let replaceWorkerDrafts = false;
let latest = { status: null, tab: null };
let openedOnFailure = false;

// ------------------------------------------------------------------ formatting

/** Ids are long and only their ends identify them, so keep both ends rather than one. */
function shorten(value, keep = 6) {
  const text = String(value || '');
  if (text.length <= keep + 5) return text;
  return `${text.slice(0, keep)}…${text.slice(-4)}`;
}

function ago(at) {
  if (!at) return '';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

/** One capture row: ok, no, wait or off, plus whatever it wants to say on the right. */
function row(name, state, meta) {
  $(`r-${name}`).className = `row ${state}`;
  const value = $(`d-${name}`);
  value.textContent = meta === null || meta === undefined ? '' : meta;
}

function idRow(name, state, meta, full) {
  row(name, state, meta);
  const value = $(`d-${name}`);
  value.title = full || '';
  value.disabled = !full;
}

function stage(name, state, meta) {
  $(`s-${name}`).className = `stage ${state}`;
  $(`n-${name}`).textContent = meta || '';
}

// -------------------------------------------------------------------- pipeline

/** How the app describes what it placed a call on, in its own words. */
const ATTRIBUTION = {
  request_id: 'exact request id',
  unattributed: 'request id not resolved',
  agent: 'agent key',
  turn: 'tool block on the page',
  generation: 'the only chat generating',
  inferred: 'not placed in a chat'
};

/**
 * The three stages, from evidence each layer produced independently.
 *
 * Deliberately not one flag set by whoever ran last: "picked up" is the page's own count,
 * "sent to app" is the service worker's delivery log, and "app processed" is the app
 * naming a session for this chat on the feed the page polls. A stage is only green when
 * the layer that owns it said so.
 */
function pipeline(info, ready) {
  const page = info && info.page;
  const sent = info && info.delivery;
  const pending = info ? info.pending : 0;
  const read = page ? page.events : 0;

  if (!info || !info.isChat) return { read: ['off'], sent: ['off'], proc: ['off'], why: ['', ''] };
  if (!info.recorder) {
    return { read: ['failed'], sent: ['off'], proc: ['off'], why: ['bad', 'No recorder in this tab. Reload the page.'] };
  }
  if (read === 0) {
    return { read: ['running'], sent: ['off'], proc: ['off'], why: ['', 'Waiting for the first message.'] };
  }

  const readStage = ['done', String(read)];
  if (!ready) {
    return {
      read: readStage,
      sent: ['failed', pending ? `${pending} held` : ''],
      proc: ['off'],
      why: ['bad', 'The app is not reachable. Nothing is leaving this browser.']
    };
  }
  if (sent && sent.ok === false) {
    return {
      read: readStage,
      sent: ['failed', String(sent.error || 'failed')],
      proc: ['off'],
      why: ['bad', `The app rejected the last delivery (${sent.error || 'failed'}).`]
    };
  }
  // Refused by the extension itself, before anything could be queued for the app. `pending`
  // counts only what the service worker already owns, so a document it is rejecting outright
  // reported nothing pending and this drawer went on to say "Delivered" — which is what it
  // said all through the 2026-08-21 blackout while the tab was reading ChatGPT perfectly and
  // sending none of it. The page is the only layer that knows, so it is the layer that says so.
  if (page.blocked) {
    return {
      read: readStage,
      sent: ['failed', page.queued ? `${page.queued} held in page` : String(page.blocked)],
      proc: ['off'],
      why: [
        'bad',
        'The extension is not accepting this tab’s observations (' +
          String(page.blocked) +
          '). Reload the ChatGPT tab.'
      ]
    };
  }
  if (pending > 0) {
    return {
      read: readStage,
      sent: ['running', `${pending} queued`],
      proc: ['off'],
      why: ['', 'Queued here. Retrying delivery to the app.']
    };
  }

  const sentStage = ['done', sent && sent.total ? String(sent.total) : ''];
  if (!page.session) {
    return {
      read: readStage,
      sent: sentStage,
      proc: ['running'],
      why: ['', 'Delivered. The app has not opened a session for this chat yet.']
    };
  }

  const calls = Array.isArray(page.trace) ? page.trace : [];
  const placed = calls.filter((call) => call.app === 'request_id').length;
  const missed = calls.filter((call) => call.app && call.app !== 'request_id');
  if (missed.length > 0) {
    return {
      read: readStage,
      sent: sentStage,
      proc: ['failed', `${placed}/${calls.length}`],
      why: [
        'bad',
        `The app could not place ${missed.length === 1 ? 'a call' : `${missed.length} calls`} by request id — it fell back to ${ATTRIBUTION[missed[0].app] || missed[0].app}.`
      ]
    };
  }
  return {
    read: readStage,
    sent: sentStage,
    proc: ['done', calls.length ? `${placed}/${calls.length}` : ''],
    why: ['', calls.length ? 'Every tool call matched end to end.' : 'Recording into the app.']
  };
}

/** One row per request id: three dots, the tool, the id. Newest first. */
function paintCalls(page) {
  const box = $('calls');
  box.textContent = '';
  const rows = page && Array.isArray(page.trace) ? page.trace.slice(0, 5) : [];
  for (const entry of rows) {
    const line = document.createElement('div');
    line.className = 'call';
    const pips = document.createElement('span');
    pips.className = 'pips';
    for (const state of [
      entry.read ? 'on' : '',
      entry.sent ? 'on' : '',
      entry.app ? (entry.app === 'request_id' ? 'on' : 'bad') : ''
    ]) {
      const pip = document.createElement('span');
      pip.className = `pip ${state}`;
      pips.append(pip);
    }
    const tool = document.createElement('span');
    tool.className = 'tool';
    tool.textContent = entry.tool || 'tool call';
    const id = document.createElement('span');
    id.className = 'id';
    id.textContent = shorten(entry.requestId, 5);
    line.title = `${entry.requestId} — picked up ${entry.read ? 'yes' : 'no'} · sent ${entry.sent ? 'yes' : 'no'} · app ${ATTRIBUTION[entry.app] || 'no record'}`;
    line.append(pips, tool, id);
    box.append(line);
  }
}

// ------------------------------------------------------------------- rendering

function paintHeader(status) {
  const connected = status && status.connected === true;
  const paired = status && status.paired === true;
  const incompatible = connected && status.compatible === false;
  // Disconnected on purpose. This has to say so plainly rather than describing it as a
  // connection that has not finished yet, which is what it looked like back when the next
  // poll would silently undo it.
  const off = status && status.disconnected === true && !paired;
  const ready = connected && paired && !incompatible;

  $('pill').className = `pill ${ready ? '' : incompatible ? 'bad' : 'off'}`;
  $('state').textContent = incompatible
    ? 'Version mismatch'
    : off
      ? 'Disconnected'
      : !connected
        ? 'App not running'
        : ready
          ? `Connected · Port ${status.port}`
          : `Port ${status.port} · connecting`;

  $('retryBtn').hidden = ready || incompatible;
  $('retryBtn').textContent = off ? 'Connect' : 'Try again';
  $('unpairBtn').hidden = !paired || incompatible;
  return ready;
}

function paintAlert(status, info) {
  const page = info && info.page;
  const incompatible = status && status.connected === true && status.compatible === false;
  const pairError = status && status.pairError;
  const error = page && page.lastError;
  const text = incompatible
    ? 'The app and this extension speak different bridge protocols.'
    : pairError && pairError.message
      ? pairError.message
      : pairError && pairError.error === 'secure_storage_unavailable'
        ? 'Secure credential storage is unavailable. Open Chat On Steroids for setup instructions.'
    : error && Date.now() - error.at < 10 * 60 * 1000
      ? error.text
      : '';
  $('alert').textContent = text;
  $('alert').hidden = !text;
}

function detail(list, term, value, bad) {
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
  if (bad) dd.className = 'bad';
  dd.title = dd.textContent;
  list.append(dt, dd);
}

/**
 * Only what changes the reading of the three stages.
 *
 * An earlier draft of this drawer listed twenty-eight fields, which is a different thing
 * from being informative: nothing in it told you which layer had stopped.
 */
function paintDetails(status, info) {
  if (!$('more').open) return;
  const grid = $('grid');
  grid.textContent = '';
  const page = info && info.page;
  const sent = info && info.delivery;

  detail(grid, 'app', status ? `v${status.appVersion || '?'} · port ${status.port || '—'}` : null);
  detail(
    grid,
    'extension',
    status ? `v${status.extensionVersion} · protocol ${status.extensionProtocol}` : null,
    status && status.compatible === false
  );
  detail(grid, 'chat id', (info && info.conversationId) || null);
  detail(grid, 'app session', (page && page.session) || null, Boolean(page && !page.session));
  detail(grid, 'tab', info ? `${info.tab} · epoch ${info.epoch ?? '—'}` : null);
  detail(
    grid,
    'ownership',
    info ? (info.terminal ? 'retired' : info.bound ? 'bound' : 'unbound') : null,
    Boolean(info && info.terminal)
  );
  detail(grid, 'recorder', page ? `fiber v${page.recorderVersion} · run ${page.runId}` : 'not attached', !page);
  detail(grid, 'turn', page ? (page.generating ? `${shorten(page.turnId, 8)} · live` : 'idle') : null);
  detail(grid, 'observed', page ? `${page.events} events · ${page.calls} calls` : null);
  detail(
    grid,
    'in this browser',
    info ? `${info.pending} held · ${info.pendingAll} total` : null,
    Boolean(info && info.pendingAll)
  );
  detail(
    grid,
    'last delivery',
    sent && sent.at ? `${sent.ok ? 'ok' : sent.error || 'failed'} · ${sent.events} · ${ago(sent.at)} ago` : null,
    Boolean(sent && sent.ok === false)
  );
  detail(grid, 'delivered', sent ? sent.total : null);
  detail(grid, 'page sends', page ? `${page.sends} · ${page.failures} failed` : null, Boolean(page && page.failures));
}

async function refresh() {
  const [status, info] = await Promise.all([
    webext.runtime.sendMessage({ type: 'status' }),
    webext.runtime.sendMessage({ type: 'tabStatus' }).catch(() => null)
  ]);
  latest = { status, tab: info };

  const ready = paintHeader(status);
  const isChat = Boolean(info && info.isChat);
  const page = info && info.page;

  row('tab', isChat ? 'ok' : 'off', isChat ? '' : 'none open');
  row('rec', !isChat ? 'off' : info.recorder ? 'ok' : 'no', !isChat ? '' : info.recorder ? (page.generating ? 'answering' : '') : 'reload');

  const chatId = info && info.conversationId;
  idRow('chat', !isChat ? 'off' : chatId ? 'ok' : 'wait', !isChat ? '' : chatId ? shorten(chatId, 8) : 'new chat', chatId);

  const requestId = page && page.requestId;
  idRow('req', !isChat ? 'off' : requestId ? 'ok' : 'wait', !isChat ? '' : requestId ? shorten(requestId, 9) : 'none yet', requestId);

  const state = pipeline(info, ready);
  stage('read', ...state.read);
  stage('sent', ...state.sent);
  stage('proc', ...state.proc);
  $('why').textContent = state.why[1];
  $('why').className = `why ${state.why[0]}`;
  paintCalls(page);

  const broken = state.why[0] === 'bad';
  const flowing = state.proc[0] === 'done';
  row(
    'app',
    !isChat ? 'off' : broken ? 'no' : flowing ? 'ok' : 'wait',
    !isChat ? '' : broken ? 'blocked' : flowing ? ago(info.delivery && info.delivery.at) || 'live' : 'waiting'
  );
  // Opens itself the first time something is actually wrong, so the panel that explains
  // the failure is already open when the popup is opened to look at one.
  if (broken && !openedOnFailure) {
    openedOnFailure = true;
    $('stream').open = true;
  }

  paintAlert(status, info);
  paintDetails(status, info);
}

// -------------------------------------------------------------------- controls

function syncOverwrite() {
  $('overwriteToggle').checked = overwriteEnabled;
}

async function loadPreferences() {
  const stored = await webext.storage.local.get([RENDER_STREAM_KEY, SHOW_TIMES_KEY, REPLACE_WORKER_DRAFTS_KEY]);
  overwriteEnabled = stored[RENDER_STREAM_KEY] !== false;
  showTimes = stored[SHOW_TIMES_KEY] === true;
  replaceWorkerDrafts = stored[REPLACE_WORKER_DRAFTS_KEY] === true;
  syncOverwrite();
  $('timeToggle').checked = showTimes;
  $('replaceDraftToggle').checked = replaceWorkerDrafts;
  // The browser-control row reflects a browser permission rather than a stored preference, so
  // it has to be read on open. Without this it only ever painted after somebody clicked it.
  await syncBrowserControl();
}

/** Puts one value on the clipboard and says so in place, without moving anything. */
async function copyInto(button, text) {
  if (!text) return;
  const was = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'copied';
  } catch {
    button.textContent = 'copy failed';
  }
  setTimeout(() => {
    if (button.textContent === 'copied' || button.textContent === 'copy failed') button.textContent = was;
  }, 900);
}

for (const id of ['d-chat', 'd-req']) {
  $(id).addEventListener('click', (event) => {
    event.preventDefault();
    void copyInto(event.currentTarget, event.currentTarget.title);
  });
}

$('copyBtn').addEventListener('click', (event) => {
  const cells = [...$('grid').children].map((node) => node.textContent);
  const lines = [$('why').textContent];
  for (let index = 0; index < cells.length; index += 2) lines.push(`${cells[index]}: ${cells[index + 1]}`);
  void copyInto(event.currentTarget, lines.join('\n'));
});

$('more').addEventListener('toggle', () => paintDetails(latest.status, latest.tab));

$('retryBtn').addEventListener('click', async () => {
  $('retryBtn').disabled = true;
  await webext.runtime.sendMessage({ type: 'pair' });
  $('retryBtn').disabled = false;
  await refresh();
});

$('unpairBtn').addEventListener('click', async () => {
  await webext.runtime.sendMessage({ type: 'unpair' });
  await refresh();
});

$('overwriteToggle').addEventListener('change', async () => {
  const previous = overwriteEnabled;
  overwriteEnabled = $('overwriteToggle').checked === true;
  syncOverwrite();
  try {
    await webext.storage.local.set({ [RENDER_STREAM_KEY]: overwriteEnabled });
    // The toggle is the action. Enabling it immediately pulls the latest app timeline into
    // every known ChatGPT tab; there is deliberately no second "Overwrite now" button.
    if (overwriteEnabled) await webext.runtime.sendMessage({ type: 'overwriteNow' });
  } catch {
    overwriteEnabled = previous;
    syncOverwrite();
  }
});

/**
 * Browser control is the one switch that changes what the extension is allowed to do.
 *
 * Chrome only shows a permission prompt from a real user gesture, which is why this lives in
 * the popup rather than in a settings round trip: the click that turns it on *is* the consent.
 * Turning it off both revokes the permissions and drops any live session, so "off" means the
 * capability is gone, not merely unused.
 */
/**
 * Chrome answers a callback and returns nothing; Firefox returns a promise and ignores the
 * callback. Waiting only for the callback waits forever on Firefox, which this extension
 * supports, so whichever the browser actually hands back is accepted.
 */
/*
 * What browser control still asks for at runtime.
 *
 * `debugger` is deliberately absent, and this is the whole reason the switch used to be
 * unusable: Chrome does not accept `debugger` in optional_permissions. It drops the entry when
 * the manifest loads, so a later request for it comes back "Only permissions specified in the
 * manifest may be requested" — verified against Chrome 152. Every request here failed on that
 * one entry, the failure was swallowed, and the toggle simply snapped back off. `debugger` is a
 * required permission now; site and tab access stay optional, which is what actually decides
 * whether this extension can read a page.
 */
const BROWSER_CONTROL_PERMISSIONS = {
  permissions: ['tabs', 'tabGroups'],
  origins: ['<all_urls>']
};

/**
 * Shows why browser control could not be switched on, or clears it.
 *
 * A permission refusal used to be invisible: the switch flipped back and said nothing, so a
 * request Chrome was never going to grant looked like a broken control. The message is the
 * browser's own wherever there is one, because a summary loses the detail that makes it fixable.
 */
function showBrowserControlError(message) {
  const node = document.getElementById('browserControlError');
  if (!node) return;
  node.textContent = message ?? '';
  node.hidden = !message;
}

/** The reason the last permission call failed, for the popup to show rather than hide. */
let lastPermissionError = null;

function browserPermissions(method) {
  lastPermissionError = null;
  return new Promise((resolve) => {
    const api = webext?.permissions;
    if (!api?.[method]) return resolve(false);
    try {
      const returned = api[method](BROWSER_CONTROL_PERMISSIONS, (granted) => {
        // Kept, not discarded: a refusal the user cannot see reads as a broken switch, which is
        // exactly how a permission Chrome would never grant went unnoticed.
        lastPermissionError = webext.runtime.lastError?.message ?? null;
        resolve(Boolean(granted));
      });
      if (returned && typeof returned.then === 'function') {
        returned.then(
          (granted) => resolve(Boolean(granted)),
          (error) => {
            lastPermissionError = error?.message ?? String(error);
            resolve(false);
          }
        );
      }
    } catch {
      resolve(false);
    }
  });
}

async function syncBrowserControl() {
  // Whether the browser knows this permission at all, which is not the same as holding it.
  // `chrome.debugger` does not exist until the permission is granted, so testing for that
  // object would hide the switch that grants it and make the feature unreachable — measured
  // in a real Edge run, where the popup saw no debugger API before granting.
  const supported = await new Promise((resolve) => {
    try {
      const returned = webext.permissions.contains({ permissions: ['debugger'] }, (held) => {
        resolve(!webext.runtime.lastError && typeof held === 'boolean');
      });
      if (returned && typeof returned.then === 'function') {
        returned.then(() => resolve(true), () => resolve(false));
      }
    } catch {
      resolve(false);
    }
  });
  $('browserControlToggle').closest('.row').hidden = !supported;
  if (!supported) return;
  try {
    const status = await webext.runtime.sendMessage({ type: 'browser_status' });
    const on = status?.granted === true;
    $('browserControlToggle').checked = on;
    $('browserControlToggle').closest('.row')?.classList.toggle('on', on);
    // A worker that answers with a failure is not the same as one that says "not granted", and
    // the switch cannot show the difference. It showed off for both, which is how a worker that
    // could not load the driver at all looked exactly like a permission nobody had granted.
    showBrowserControlError(
      status?.ok === false && status?.error
        ? `Browser control is unavailable: ${status.error}`
        : null
    );
  } catch (error) {
    $('browserControlToggle').checked = false;
    showBrowserControlError(
      `Browser control could not be read from the extension worker: ${error?.message ?? String(error)}`
    );
  }
}

$('browserControlToggle').addEventListener('change', async () => {
  const wanted = $('browserControlToggle').checked === true;
  try {
    if (wanted) {
      if (!(await browserPermissions('request'))) {
        $('browserControlToggle').checked = false;
        showBrowserControlError(
          lastPermissionError
            ? `Browser control could not be enabled: ${lastPermissionError}`
            : 'Browser control could not be enabled. The browser declined the permission request.'
        );
      } else {
        showBrowserControlError(null);
      }
    } else {
      showBrowserControlError(null);
      // Stop first, then revoke: revoking under a live session would leave a debugger
      // attachment this extension can no longer address, and the banner with it.
      await webext.runtime.sendMessage({ type: 'browser_detach' }).catch(() => null);
      await browserPermissions('remove');
    }
  } finally {
    await syncBrowserControl();
  }
});

$('replaceDraftToggle').addEventListener('change', async () => {
  const previous = replaceWorkerDrafts;
  replaceWorkerDrafts = $('replaceDraftToggle').checked === true;
  try {
    await webext.storage.local.set({ [REPLACE_WORKER_DRAFTS_KEY]: replaceWorkerDrafts });
  } catch {
    replaceWorkerDrafts = previous;
    $('replaceDraftToggle').checked = replaceWorkerDrafts;
  }
});

$('timeToggle').addEventListener('change', async () => {
  showTimes = $('timeToggle').checked === true;
  await webext.storage.local.set({ [SHOW_TIMES_KEY]: showTimes });
});

// A popup is open for seconds at a time and the three stages move within those seconds.
void loadPreferences();
void refresh();
setInterval(() => void refresh().catch(() => undefined), POLL_MS);
