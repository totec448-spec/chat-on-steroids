# Building and replacing the native image libraries

`sources.json` maps each archive to its URL, version, applicable OS and SHA-256. Verify
`SHA256SUMS.txt` before extracting. Keep embedded subprojects and notices. Source retains
its original licenses. The application consumes the published sharp 0.35.3/@img binaries
without modifying their machine code. Windows and Unix use different dependency versions
even though both report libvips 8.18.3.

## Source preparation

Extract component archives separately with one leading path component removed, as the
upstream recipes do with `tar --strip-components=1`. Archive filenames contain a URL hash
to avoid collisions; the inventory maps them to recipe downloads. The build repositories
retain platform settings, inline source edits, generated-file recipes, patches and scripts.

The original libimagequant v2.4.1 tag moved after the June builds. Use supplied commit
`4e82d9492db228a7a2057c442f7a6eb40508a0eb`, not today's tag. This reconstructs the historical
Windows recipe archive from that commit:

```sh
git archive --format=tar --prefix=libimagequant-2.4.1/ 4e82d9492db228a7a2057c442f7a6eb40508a0eb | gzip -n -6 > libimagequant-2.4.1.tar.gz
```

The resulting SHA-256 is `da531249038e17f0674cef6e5d4100e43bf8cdfb4f330bc2a590bff50cd91913`.
The supplied immutable commit archive has different directory/compression bytes and the same
historical source. TIFF and Unix Fontconfig come from mirrors at exact Git commits because
upstream archive endpoints were unavailable. Windows libxml2's recipe directory typo is
corrected to `2.15`; its original source-archive SHA-256 still matches.

## macOS and Linux

Use sharp-libvips commit `4da6d14c0d59866adfb9d8cf52bcaa53846dc4f6` (v1.3.2).
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

The actual release logs record Rust `1.98.0-nightly (096694416 2026-06-29)`, cargo-c
`0.10.23+cargo-0.97.1` and Meson `1.11.1`. Use that dated Rust toolchain rather than today's
floating nightly. Original librsvg 2.62.90 Cargo.lock and source-local workspace are in
its archive. After the recipe's feature edits, `cargo update --workspace` removed only
`color_quant 1.1.0`, `gif 0.14.2` and `image-webp 0.2.4`; it added/upgraded nothing.
Retained crates include that lock's dependency sources, checked against Cargo.lock hashes.
Retain the lock for `cargo vendor` / `--locked`; do not run an unrestricted update.
GVDB and libnsgif sources are embedded in their parent archives.

Original release logs: https://github.com/lovell/sharp-libvips/actions/runs/28432216836

## Windows

Use build-win64-mxe commit `bca68727eb1df12c5d2b204a13a392989d505774` (v8.18.3) and
MXE base `d973945bb92c7783d5afa41bb2b8d2e1a04eaba3` (`llvm-mingw-20260605`), both included.
The `container/` Dockerfiles, `build/`, `build.sh` and MXE settings define the Linux
cross-compilation environment. Sharp's `build/win.sh` selects the `web` variant,
`vips-dev-{ARCH}-web-8.18.3-static.zip`, without `-ffi`. The main libvips and C++ wrapper
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
  `libvips-42.dll` and `libvips-cpp-8.18.3.dll`.
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
