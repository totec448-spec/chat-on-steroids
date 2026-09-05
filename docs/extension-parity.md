# How our browser control compares to ChatGPT's extension

Read against the installed ChatGPT extension `hehggadaopoacecdllhhajmbjkdcmajg`, version
1.2.27268.51612. Recorded because "are we behind theirs?" is a question that otherwise gets
answered from impression.

The first attempt at this was inconclusive and said so: grepping their bundle for CDP method
names found five, which looked like a minification problem. It was not. The reason is in the
design, and it is the most important difference between the two extensions.

## They relay arbitrary CDP; we expose a fixed vocabulary

From their `background.js`:

```js
function mn(e){
  if(e.method==="Target.getTargets") return chrome.debugger.getTargets().then(r=>({targetInfos:r}));
  const t = typeof e.target.targetId=="string" ? {targetId:e.target.targetId} : e.target;
  return chrome.debugger.sendCommand(t, e.method, e.commandParams);
}
```

The method name and its parameters arrive in a message and go straight to the protocol. There is
no allowlist — only `Target.getTargets` is intercepted, and that for convenience rather than
safety. So no CDP method appears as a literal anywhere in their code, and none can: the surface
is whatever the other end asks for.

Ours is the opposite shape. `browser-driver.js` accepts eighteen named actions — navigate, back,
forward, reload, observe, elements, click, click_ref, double_click, move, drag, scroll, type,
keypress, set_value, wait, attach, detach — each validated, each with its own timeout, and the
protocol calls behind them are ours to choose. A caller cannot reach `Page.setDownloadBehavior`
or `Network.setCookies` through it, because there is no path that would carry the request.

Neither shape is automatically better. Theirs is more powerful and bounded only by trust in the
far end; ours is bounded by what we implemented and can be audited by reading one file.

## Permissions

| | ChatGPT | ours |
|---|---|---|
| `debugger` | required at install | optional, granted from the popup |
| `<all_urls>` | required at install | optional |
| `tabs`, `tabGroups` | required | optional |
| `bookmarks`, `history`, `topSites`, `sessions` | required | not requested |
| `downloads`, `nativeMessaging`, `notifications` | required | not requested |
| `webNavigation`, `contextMenus`, `sidePanel` | required | not requested |

Installing theirs grants debugger access and every-site access up front. Ours asks for nothing
beyond `storage`, `scripting`, `alarms` and the ChatGPT/loopback hosts until browser control is
switched on deliberately.

`webNavigation` is the only one of their extras that would serve browser control, and only as an
alternative to what we already get from `Page.getFrameTree` over the protocol we are attached to
anyway.

## What each refuses to drive

We keep a refusal list, checked before every command:

```
chatgpt.com, chat.openai.com, chrome:, edge:, about:, devtools:,
chrome-extension:, moz-extension:, view-source:, file:
```

ChatGPT's tabs come first on purpose: a model that can drive the page holding its own
conversation can edit the transcript it is being judged by. `file:` keeps it off the local disk,
and the browser-internal schemes keep it out of settings and other extensions.

Their bundle carries no comparable list — the two `blocked` strings in it are unrelated, and the
single `chrome://extensions` reference is a link, not a guard.

## What this comparison does not establish

Only that the capability is there and how each is bounded. It is a reading of their shipped code
against ours, not a side-by-side run of the same task through both. Their agent may well be
better at *choosing* actions; nothing here measures that.

Our side is separately proven to work: `npm run verify:browser` drives a real page in real Chrome
152 and in Edge, and asserts among other things that a click arrives with `isTrusted: true`,
inside an iframe as well as the main frame, and that one screenshot pixel is one CSS pixel.
