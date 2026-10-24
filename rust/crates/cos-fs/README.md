# cos-fs

The filesystem sandbox of the Rust Core. Every model-supplied path that a file tool or a command's
working folder uses goes through `resolve` or `resolve_from`. The functions return the virtual
path the model sees (`/project/src/main.rs`) and the canonical host path, or a `SandboxError`.
The `Display` text of a `SandboxError` is the refusal text of `src/main/sandbox.ts`, character for
character.

## Use

```rust
let file = cos_fs::resolve(&grants.roots, &args.path, Access::Read)?;   // must exist
let target = cos_fs::resolve(&grants.roots, path, Access::Create)?;     // may be missing
let cwd = cos_fs::resolve(&grants.roots, workdir, Access::WorkingFolder)?; // existing folder
let rel = cos_fs::resolve_from(&grants.roots, &base.virtual_path, "src/a.rs", Access::Read)?;
```

`Access::Create` is the only access that accepts a path that does not exist yet
(`allowMissing`). `Access::WorkingFolder` also requires a folder and refuses anything else with
`workdir must be a folder`. Resolution canonicalizes paths, so it does blocking IO. Run it on a
blocking thread.

The crate also holds these items:

- `validate_new_root`, `unique_root_name` and `normalise_root_name` for approving a folder.
- `stray_virtual_path` for the `exec_command` check that finds a virtual path in command text.
- `Glob`, which ports `globToRegExp` from `search.ts`.
- `line_delta` and `format_delta`, which port `diffstat.ts`.
- The parts of `fsops.ts` that the file tools use: `sniff_binary_bytes`,
  `is_excluded_folder_name`, `format_bytes`, `clamp`, `image_mime`, `validate_image_structure`
  and the read and image limits.
- `validate_image_bytes`, which ports `validateImageBytes` (`codex/view-image.ts`): signature,
  structure and a full decode. `view_image` (cos-files) and code mode (cos-codemode) both return
  an image only after it passes.
- `canonical`, which ports `realpath.native` (`rawfs.ts`).

## Proof

- `tests/sandbox.rs` contains the cases of `test/sandbox.test.ts` and
  `test/wsl-sandbox-portable.test.ts`. It also has Windows escapes that the TypeScript suite does
  not test: device and UNC spellings of an approved folder, `::$DATA` and other streams, reserved
  names, trailing dots, junctions, dangling links, and a replaced root.
- `tests/golden.rs` replays 27 path decisions from `rust/golden` and compares each with the
  recorded text or virtual path. They include every sandbox refusal the corpus records:
  traversal, outside, unknown root, relative, native, `/`, and missing file or folder.
- `tests/helpers.rs` covers glob, diffstat, stray paths, and the bounds and image helpers.
- `differential/run.mjs` runs the TypeScript `resolvePath` and this crate on the same disk, with
  links, over about 200 inputs. It prints every difference. Run it from the repository root:

  ```sh
  cd rust && cargo build -p cos-fs --example probe && cd ..
  node rust/crates/cos-fs/differential/run.mjs --probe rust/target/debug/examples/probe.exe
  ```

## Deliberate differences from TypeScript

TypeScript allows two escapes. This crate refuses both.

- **A create through a dangling link.** `realpath` reports a link whose target is gone as a
  missing path, so `allowMissing` accepted it, and the write followed the link out of the root.
  This crate refuses a create through such a link with
  `Path contains a link that could not be resolved`. That is the same text TypeScript already
  uses for WSL links. A read still says `Not found: ...`.
- **A sibling whose name differs only by JavaScript case folding.** TypeScript lowercases both
  canonical paths before it compares them. NTFS stores `kit` and `Kit` with KELVIN SIGN (U+212A)
  as two different folders, but JavaScript lowercases both names to `kit`. A junction inside root
  `kit` that points to the sibling therefore passed as inside. This crate compares canonical
  paths exactly, because the OS returns every folder name as stored. Lexical checks on
  configured or typed spellings still ignore case, as TypeScript does.

## Not ported

`text-match.ts` and the write, edit, append, hash, listing and base64 functions of `fsops.ts`
are not ported. No file tool calls them in the TypeScript app. Only `fsops.test.ts` and
`text-match.test.ts` use them.
