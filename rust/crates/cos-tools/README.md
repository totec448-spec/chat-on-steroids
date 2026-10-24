# cos-tools

The model-facing tool kernel (unit C1.2). It ports `src/main/mcp/{kernel,surfaces,tools,
call-context,tool-declarations,instructions,coding-instructions}.ts` and `inbound.ts`. A tool
crate implements `Tool`. The transport (`cos-mcp`) calls `Kernel::server_info`, `Kernel::list`
and `Kernel::call`. Neither sees the other.

## What the kernel serves

- `initialize`: `ServerInfo` per surface. The instructions follow the live config: roots and
  whether each is a Git work tree, permissions, plans, workers, the host platform, the skills
  folder, connector names with this computer's suffix, and the user's own instructions.
- `tools/list`: each element is served from `declarations.json`, which
  `scripts/golden/extract-declarations.mjs` writes from the golden corpus. Key order is the
  order the TypeScript server sent. `{{roots}}` in `read`'s path description is the only
  placeholder. Run the script again after the corpus changes. A test fails when the file is
  stale.
- `tools/call`, in this order:
  1. Derive `Grants` from the config snapshot and observe exposure.
  2. A tool this surface does not list is `UnknownTool` (JSON-RPC `-32602`). Nothing is
     recorded.
  3. Validate the arguments against the declared schema, then run `Tool::refine`. A failure is
     an `isError` result `Input validation error: Invalid arguments for tool <name>: ...` in
     zod 4's words. It is not recorded and gets no identity notice.
  4. Wait on `Admission`.
  5. Resolve the caller through `Attribution`. While `ChatPolicy::needs_proof` (a chat is
     blocked, or strict chat allowlisting is on), a call with a request id but no proven chat
     waits for its proof (`Attribution::resolve_proven`), so it cannot run as "no proven chat"
     and land in a blocked chat's timeline afterwards.
  6. Ask `ChatPolicy::refusal` (`CHAT_BLOCKED`, `CHAT_NOT_TRUSTED`; nested calls too), check
     `ToolSpec::requires` (`TOOL_DISABLED`, `FEATURE_DISABLED`), then run the handler.
  7. Map `ToolError` to an `isError` result and an outcome, and log `tool <name> ok in N ms`,
     `rejected` or `failed`.
  8. Append the identity notice when the caller is unattributed. On Core it is also merged
     into `structuredContent.supplemental_context`.
  9. Await `CallRecorder::record`, then answer.

## Writing a tool

- Return `Err(ToolError::Refused(..))` for every refusal, `Err(ToolError::Identity(..))` when
  the chat identity is missing, and `Err(ToolError::Internal(..))` when the tool breaks its own
  contract. Use `ToolError::from_io` for OS errors. It never echoes a host path.
- `Args` receives what zod's parse returns: unknown keys stripped, schema defaults filled, and
  integral numbers as integers.
- Implement `Tool::refine` for a check the schema cannot express. Return each issue with
  `ArgIssue::new(path, message)`, where `path` is dotted (`plan`) or empty for the arguments
  object. The kernel runs it only when no type error stopped the schema walk, as zod does.
  These recorded refinements must be ported by their tools:

  | Tool | Path | Message |
  | --- | --- | --- |
  | `exec_command` | (root) | `exec_command requires exactly one of cmd or cmds` |
  | `update_plan` | `plan` | `At most one step may be in_progress.` |
  | `browser_tabs` | `tabId` | `Required for this action` |
  | `browser_navigate` | `url` | `URL required` |
  | `browser_action` | `ref`, `text` | `Editable/select ref required`, `Text required (empty fill clears the field)` |

- Declare `Tool::STRING_CHECKS` for what zod checked on a string property that its JSON Schema
  lost: a `pattern`'s flags (`tabId` is `/^[a-f\d-]{36}:\d+$/i`, and JSON Schema drops the `i`)
  and a custom format or pattern message (`pageId`'s "Copy the top-level pageId ..."). The
  schema walk checks `pattern` with JavaScript's meaning (ASCII classes, the declared flags) in
  the property's place, so its issue keeps zod's order and survives another property's type
  error. A property with a `format` is checked by its format, not by the regex zod published
  for it.

- Name a connector with `cx.connectors.name(surface)`, which carries this computer's
  connector suffix, and find the connectors configured on one Secure Tunnel ID with
  `cx.connectors.sharing_tunnel(surface)`. Both come from the same config snapshot as
  `cx.grants`.
- Identity is the tool's decision, from `cx.caller` and `cx.grants.allow_unattributed`. With
  "Allow unattributed calls" off, the corpus records these refusals for a call with no chat:
  `update_plan` (also refused with the option on when there is no request id), code mode
  `exec`, `save_image` (it must know which chat's image to save), browser tools, and
  coordinate or indexed input. `read`, `apply_patch` and `exec_command` run and are filed as
  Unattributed.
- Code mode offers `cx.nested_tools()`, the tools the surface lists now except `exec`, and
  calls them through `cx.nested_invoker()`, whose calls may outlive the parent call. A child rechecks the live grants and its arguments
  (refused as `INVALID_ARGUMENTS: <path>: <message>`), is recorded with `nested: true`, and
  gets no identity notice. `exec`, `session_finish` and `agents` `finish` refuse with
  `DIRECT_CALL_REQUIRED`.

## Exposure

Exposure is per surface and only widens while the settings stay the same. A config whose
effective capabilities or feature switches differ from the last one a request saw forgets
exposure first, as the TypeScript settings save does (`forgetExposedSurface` in
`src/main/ipc.ts`). A revoked tool is therefore unlisted on the next request, and a call from
a cached list gets `-32602`. `TOOL_DISABLED` remains for a call whose grants changed under a
concurrent request. `find` is decided once per exposure, from the first grants a surface sees.

## Tests

- `tests/golden.rs` compares `tools/list` (byte for byte) and `initialize` of every variant
  and surface with the corpus, and replays every recorded call through stand-in tools that
  answer what the real tool answered, with the refinements and string checks above.
- `tests/kernel.rs` covers exposure, grants and their texts, the pipeline, error mapping, the
  identity notice, nested calls, admission, counters and clocks.
