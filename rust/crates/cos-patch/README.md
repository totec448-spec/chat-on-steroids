# cos-patch

The `apply_patch` tool of the Rust Core (unit C1.5). It applies a Codex V4A patch, passed as the
`patch` string, to files inside the approved roots. It answers the way the TypeScript app does:
the same result text, the same refusals and the same files on disk.

## Use

`cos-core` registers the tool on the Core surface:

```rust
tools.add(SurfaceId::Core, cos_patch::tool());
```

The kernel lists the tool when Create, Edit, Move or Delete files is on. The tool checks each
hunk itself. Add needs Create, Delete needs Delete files, an Update that changes text needs Edit,
and a Move needs Move. An Add over an existing file, or a Move onto an existing file, also needs
Edit. With Edit on, Add over an existing file overwrites it, as Codex does.

## How a call runs

1. Parse the patch with the Codex grammar. A parse error is refused as
   `apply_patch verification failed: invalid patch: ...` or `... invalid hunk at line N, ...`.
2. Resolve every path through `cos-fs` (`resolve_from`). A relative path starts at the first
   approved root that is not `/skills`. A native path inside a root is accepted. A sandbox
   refusal refuses the whole patch with the `cos-fs` text.
3. Dry-run every hunk against the disk. A hunk on a path that an earlier hunk changed reads what
   that hunk would have left. Nothing is written when the dry run fails.
4. Snapshot the touched files (at most 64 MiB), then apply the hunks in order. If a hunk fails,
   restore each path that still holds exactly what this patch wrote, and report anything that
   could not be restored.
5. Answer in Codex's exec format (`Exit code`, `Wall time`, `Output`), truncated to 10,000
   tokens. Every host path in the text is replaced with its virtual path. The recorder gets one
   `FileChange` per committed change.

The work runs on a Tokio blocking thread, because sandbox resolution and file IO block.

## Vendored code

`src/codex/` and `src/output.rs` contain code from OpenAI Codex, `codex-rs/apply-patch` (and
the exec output formatter and truncation), at commit `1a4096e273e80da30947e57fdfa45be92858ca91`
of <https://github.com/openai/codex>. That code is licensed under the Apache License 2.0.
`codex/LICENSE` and `codex/NOTICE` are the upstream files. `rust/about.hbs` reproduces the
NOTICE in `rust/THIRD-PARTY-NOTICES.txt`, and `tests/notice.rs` fails if the two drift. Each
vendored file names its source file and lists what was changed. The crate is therefore
`MIT AND Apache-2.0`.

Only the parts the tool needs are vendored. `invocation.rs` (tree-sitter-bash interception of
`apply_patch` inside a shell command) belongs to `exec_command`. This tool takes the patch text
itself, so a heredoc command around the patch is refused by the grammar, as the corpus records.

## Proof

- `tests/golden.rs` replays all 22 recorded `apply_patch` calls of `rust/golden` through a real
  kernel. It compares each whole answer, including the identity notice, and the files on disk.
- `tests/behavior.rs` covers the cases of the TypeScript tests: the permission split, rollback,
  repeated paths, dry-run refusals, native and relative paths, source excerpts, BOM and Unicode
  matching, and binary files.
- `differential/run.mjs` runs 78 cases through the TypeScript tool (the app's MCP server under
  vitest, with no Electron window) and through this crate, each on a fresh identical tree. It
  compares every answer and every file left on disk. Run it from the repository root after
  `npm ci`:

  ```sh
  node rust/crates/cos-patch/differential/run.mjs
  ```

  Exit 0 means every case is equal.

## Differences from TypeScript

- Context matching trims whitespace as Rust does, as upstream Codex does. JavaScript's `trim`
  also removes U+FEFF and keeps U+0085, so a context line that differs from the file only by one
  of those two characters matches differently.
- Node's `CODE: description, syscall 'path'` text for an OS error is rebuilt from a table of
  common codes. It can appear only when a file changes between the dry run and the write.
- Not ported, because Track 1 has no owner for them: the chat workspace (a relative path always
  starts at the first root), `WORKSPACE_REQUIRED` for multi-agent runs, the read-only user Skill
  folders under `/skills`, review assets for the timeline, and the
  `tool apply_patch (N file(s), exit X)` activity log line.
