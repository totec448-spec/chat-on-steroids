# cos-codemode

Code mode `exec` (unit C1.7). It ports `src/main/mcp/code-mode-{tool,runtime,worker}.ts`. The
model sends JavaScript that calls the surface's own tools. Only what the script passes to
`text(...)` or `image(...)` reaches the model.

## How a call runs

1. The tool refuses with `CALLER_IDENTITY_REQUIRED` unless the caller has an exact chat and a
   request id, or "Allow unattributed calls" is on.
2. `run` checks the source (`CODE_MODE_CODE_LIMIT`, `CODE_MODE_BUSY`,
   `CODE_MODE_UNSUPPORTED_PRAGMA`), then starts a thread with a fresh QuickJS-ng interpreter
   (`rquickjs` 0.14.0, QuickJS-ng 0.16.2, MIT).
3. The script runs as a module with top-level `await`. It sees `tools`, `ALL_TOOLS`, `text`,
   `image` and `exit`, and on Windows Desktop also `sky` and `nodeRepl`. QuickJS-ng globals that
   the TypeScript runtime's QuickJS lacks are deleted, so both global objects are the same.
   `ALL_TOOLS` and `tools` hold `CallContext::nested_tools`: what the surface lists under the
   live permissions, except `exec`, with the listed descriptions.
4. Each `tools.<name>(args)` goes through `CallContext::nested_invoker`. The kernel rechecks the
   live grants and the arguments and records the child with `nested: true`. A child is polled
   beside the script, so one that is ready at once answers before the script's next request,
   as a TypeScript microtask does. A child still running when the script ends moves to its own
   Tokio task and finishes after `exec` answers, as in TypeScript; it holds its script's place
   among the 4 until then.
5. The result holds the `CODE_MODE_<REASON>` diagnostics first, then the emissions in order.
   An emitted image passes `cos_fs::validate_image_bytes`, the check `view_image` applies:
   signature, structure and a full decode, on a blocking thread.

The limits are `LIMITS`, the values of `CODE_MODE_LIMITS`: 64,000 source characters, 32 MiB heap,
2 s of CPU on the interpreter thread, 60 s in total, 32 calls, 8 at once, 40,000 bytes of text,
4 images, and 4 scripts at once in the process. A source without top-level `await` that throws
reports `CODE_MODE_PARSE_ERROR`, because quickjs-emscripten returns that throw as an evaluation
error. The port keeps this.

## Differences from the TypeScript runtime

- Engine differences: QuickJS-ng throws `RangeError: Maximum call stack size exceeded` where
  QuickJS throws `InternalError: stack overflow`. Under a 2 MiB heap, some memory bombs reach
  the CPU budget first on QuickJS (`CODE_MODE_CPU_LIMIT`) and run out of memory first on
  QuickJS-ng.

## Tests

- `tests/corpus.rs` runs the scripts in `tests/corpus/corpus.json` and compares each result and
  each child call with the TypeScript runtime's. To record the corpus again, run this command
  from the repository root after `npm ci`:

  ```sh
  npx vitest run --config rust/crates/cos-codemode/tests/corpus/vitest.config.mjs
  ```

  `cases.mjs` holds the scripts and the fixture tools. A case marked `known` is an engine
  difference. The test prints it and does not fail on it.
- `tests/golden.rs` sends the recorded `exec` calls (`base` 84 to 94, `unattributed` 06 to 16)
  to a real kernel and compares the whole `tools/call` result with the golden corpus.
- `tests/tool.rs` covers caller proof, nested records and refusals, `ALL_TOOLS`, and the
  unknown-tool note.
- `tests/image.rs` covers emitted images that have the right signature but do not decode.
- `tests/limits.rs` covers the limit of 4 scripts at once, a script that answers before its
  unawaited child finishes, and the wall-time stop of a script that is still computing.
