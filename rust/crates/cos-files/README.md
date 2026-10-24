# cos-files

The Core file tools (unit C1.4): `read`, `view_image`, `find` and `save_image`. The crate ports
the file half of `src/main/mcp/tools-core.ts`, `search.ts`, `codex/read-backend.ts`,
`codex/view-image.ts` and the parts of `codex/filesystem.ts` that `read` uses. Every model path
resolves through `cos_fs::resolve`, and every answer and refusal has the TypeScript wording.

## Use

`cos-core` registers the tools on the Core surface:

```rust
for tool in cos_files::tools(FileToolsDeps::default()) {
    tools.add(SurfaceId::Core, tool);
}
```

Each handler is synchronous file work and runs on Tokio's blocking pool, so a slow disk or a
10-second search never holds a runtime worker.

## What each tool does

- `read` lists a folder one level deep (folders first, then names in `localeCompare` order),
  returns text as numbered lines inside the 256 KiB default and 512 KiB call budgets, expands
  `*`, `?` and `**` globs, honours `path:12-40` ranges, returns PNG, JPEG, GIF and WebP files
  as images through the `view_image` loader, and answers binary files and missing permissions
  with metadata. A missing path lists the nearest folder that exists.
- `view_image` returns an image only after it decodes to pixels (`cos_fs::validate_image_bytes`,
  shared with code mode): the PNG, GIF and WebP decoders of the `image` crate, and `zune-jpeg`
  in strict mode for JPEG (libvips `failOn: 'warning'` in TypeScript). Decoded size is capped at
  16 Mi pixels.
- `find` searches file names with the bounded breadth-first walk of `search.ts`, and file
  contents with ripgrep's engine in process (see below).
- `save_image` gives the two refusals Track 1 can reach: a call with no chat, and a chat
  without the browser extension. Saving needs the browser plane (E2.x).

## Why `find` does not start `rg`

TypeScript ran the bundled `rg` once per content search. This crate links the crates `rg` is
built from (`ignore`, `grep-searcher`, `grep-regex`) and configures them as `rg 15.2.0` is with
the flags `search.ts` passes. `examples/find_backends.rs` runs both on the golden fixture and
compares hits, `files_scanned` and stop reasons:

```sh
cargo run --release -p cos-files --example find_backends -- --rg <path to rg.exe> --runs 50
```

On 2026-10-20 (Ryzen 7 7800X3D, Windows 11, release build, no other build running) all 13
cases were equal. The golden `find-content` search took 9.6 ms median through an `rg` process
(range 7.6 to 12.6 ms, n=50, two repeats) and 0.87 ms in process through the kernel (range 0.73
to 1.27 ms). Starting the process is the `rg` cost. In process, reading the 609 KB fixture file
is most of it: the same search of one small file takes 0.33 ms.

## Deliberate differences from TypeScript

- When `find` stops at `max_results`, `files_scanned` counts the files searched until then.
  TypeScript killed `rg` and lost its summary when the kill landed first, so it reported either
  0 or the full count.
- `find` content hits across several files come in walk order. `rg` searched in parallel, so
  TypeScript's order across files was not fixed.
- A matching line cut at 300 UTF-16 units drops a surrogate pair whole instead of leaving half
  of it.
- An excluded folder is not entered at all. `rg --iglob '!**/<name>/**'` entered it and ignored
  every entry, which gives the same files.

## Not ported here

- The workspace a chat learns from absolute paths (`resolveIn`). Every call is Unattributed in
  Track 1, so a relative path is refused as TypeScript refuses it for a chat with no folder.
- `/user-skills` paths and linked Skill aliases. They belong to the unit that ports
  `skill-access.ts`.
- The success path of `save_image` (`image-export.ts`), which needs a chat and the browser.

## Proof

- `tests/golden.rs` replays all 52 recorded `read`, `view_image`, `find` and `save_image`
  calls of the corpus through the real kernel on the recorder's fixture project, and compares
  each whole result, identity notice included. A later read sees the files the recorded patch
  cases left.
- `tests/read.rs`, `tests/find.rs` and `tests/view_image.rs` hold the cases of
  `read-backend.test.ts`, `search.test.ts`, `codex-view-image-parity.test.ts` and the `read`
  and `find` cases of `mcp.test.ts`.
