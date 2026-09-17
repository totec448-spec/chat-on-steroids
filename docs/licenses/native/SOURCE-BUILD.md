# Building and replacing the native image libraries

`sources.json` maps each archive to its URL, version, applicable OS and SHA-256. Verify
`SHA256SUMS.txt` before extracting. Keep embedded subprojects and notices. Source retains
its original licenses. The application consumes the published sharp 0.35.4/@img binaries
without modifying their machine code. Windows and Unix use different dependency versions
even though both report libvips 8.18.6. The inventory retains earlier source versions
as an inclusive set; use the current build revisions below and each target's versions.json.

## Source preparation

Extract component archives separately with one leading path component removed, as the
upstream recipes do with `tar --strip-components=1`. Archive filenames contain a URL hash
to avoid collisions; the inventory maps them to recipe downloads. The build repositories
retain platform settings, inline source edits, generated-file recipes, patches and scripts.

The libimagequant v2.4.1 tag moved after the older June builds. The current August
recipes use commit `ce5fdeb1ccd9db288950faa21fd09c42c0a59bbb`; its immutable archive
is included alongside the older source. Use that recorded current commit rather
than resolving the tag again. The commit archive has different directory/compression
bytes from the recipe's tagged archive, so adjust the cache filename/hash accordingly.
TIFF and Fontconfig include mirrored source archives where original download endpoints
were unavailable. Windows libxml2's recipe directory must resolve to `2.15`.

## macOS and Linux

Use sharp-libvips commit `6e5971d333377743163edc3ad9e5d0b897abcbc9` (v1.3.3).
Its `build.sh`, `build/posix.sh`, `versions.properties` and `platforms/` directories
describe configuration and installation. The entry points are:

```sh
./build.sh linux-x64
./build.sh linux-arm64v8
./build.sh darwin-x64
./build.sh darwin-arm64v8
```

Linux uses the supplied Dockerfiles; macOS uses Xcode command-line tools and Homebrew's
pkg-config. Supply the retained source bodies to the corresponding CURL download steps
instead of resolving moving tags again. Four external patches are included; the UltraHDR
PR patch is pinned to its byte-identical commit patch. Preserve all inline `sed` edits,
generated `vips.map`, static inner libraries, SONAME changes and linker flags in `posix.sh`.

The release logs record Rust `1.100.0-nightly (787af2b8c 2026-08-25)` and cargo-c
`0.10.25+cargo-0.99.0`. Use the 2026-08-26 Rust toolchain rather than today's floating
nightly. Original librsvg 2.62.91 Cargo.lock and source-local workspace are in
its archive. The published build records `Locking 0 packages` after the recipe's edits.
Retained crates include that lock's dependency sources, checked against Cargo.lock hashes.
Retain the lock for `cargo vendor` / `--locked`; do not run an unrestricted update.
GVDB and libnsgif sources are embedded in their parent archives.

Original release logs: https://github.com/lovell/sharp-libvips/actions/runs/32944388037

## Windows

Use build-win64-mxe commit `09cfccf20b91b441fbe97fa7a7ed8a597e55e830` (v8.18.6) and
MXE base `d973945bb92c7783d5afa41bb2b8d2e1a04eaba3` (`llvm-mingw-20260605`), both included.
The `container/` Dockerfiles, `build/`, `build.sh` and MXE settings define the Linux
cross-compilation environment. Sharp's `build/win.sh` selects the `web` variant,
`vips-dev-{ARCH}-web-8.18.6-static.zip`, without `-ffi`. The main libvips and C++ wrapper
remain DLLs; “static” describes their dependencies.

The pinned MXE recipes identify Rust nightly 2026-06-05 (`e7815e522`), LLVM 22.1.7,
and MinGW-w64 commit `b536c4fdb038a9c59a7e5fb36e7d1293c4dc61d6`. Their runtime sources
and the Rust standard-library lock's crate sources are included. The full LLVM source
archive is an inclusive delivery choice; use its compiler-rt, libc++, libc++abi and
libunwind recipes for the relevant runtimes. This does not assert that the whole compiler
is incorporated in the application. The dated Unix Rust standard-library source is
supplied separately, and readable standard-library/runtime notices accompany both sets.

The targets are `x86_64-w64-mingw32.static` and `aarch64-w64-mingw32.static`. With
the build repository's `build/` mounted at `/data`, the source collection command is:

```sh
make download-vips-web MXE_TARGETS=x86_64-w64-mingw32.static \
  MXE_PLUGIN_DIRS="plugins/llvm-mingw /data /data/plugins/mozjpeg /data/plugins/zlib-ng /data/plugins/web-deps /data/plugins/proxy-libintl"
```

Populate MXE's `pkg` cache from the retained inventory. Most archives match recipe
checksums directly; explicit mirror/commit substitutions in `sources.json` need the
corresponding filename/hash adjustment while preserving the recorded source commit.
Do not substitute another libimagequant fork. Preserve all build/MXE patches and settings.
GLib's GVDB and librsvg's workspace plus locked crates are included. Follow the retained
upstream build/packaging scripts after preparation; this archive is source, not a toolchain.

## Replacing the installed library

Close the app and work on a copy. Build for the same OS, CPU and Sharp/libvips ABI,
retaining exported interfaces and library names. Under application resources:

- Windows: `app.asar.unpacked/node_modules/@img/sharp-win32-{x64|arm64}/lib/`, with
  `libvips-42.dll` and `libvips-cpp-8.18.6.dll`.
- Linux: `app.asar.unpacked/node_modules/@img/sharp-libvips-linux-{x64|arm64}/lib/`.
- macOS: `app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-{x64|arm64}/lib/`
  under `Chat On Steroids.app/Contents/Resources`.

Replace the corresponding shared libraries and retain required SONAME links. Sharp is
also unpacked; its Apache-licensed binding source/build instructions are in the sharp
source distribution if an ABI change requires rebuilding it. No application hash check
or publisher-key requirement fences these files. On macOS seal the modified copy again:

```sh
codesign --force --deep --sign - "Chat On Steroids.app"
codesign --verify --deep --strict --verbose=2 "Chat On Steroids.app"
```

On Linux extract an AppImage or use an installed DEB copy to obtain ordinary writable
files. Normal OS access controls apply. Preserve source/license notices with modifications.
The application's MIT terms do not prohibit library modification or reverse engineering
for debugging those modifications.

The release pipeline tests the packaged Sharp runtime on each native OS/CPU. It does not
claim bit-identical compiler output or a full offline rebuild of all native dependencies;
those are separate reproducibility properties.
