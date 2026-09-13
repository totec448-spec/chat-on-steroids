# Native image-library licenses, source and replacement

The sharp/libvips packages include separately licensed native libraries. Their README.md
and versions.json files identify the components and versions for each target platform.
This supplement preserves full license texts omitted from the published native npm packages:

- LGPL-3.0.txt: https://ftp.gnu.org/gnu/Licenses/lgpl-3.0.txt
- GPL-3.0.txt: https://ftp.gnu.org/gnu/Licenses/gpl-3.0.txt
- MPL-2.0.txt: https://www.mozilla.org/media/MPL/2.0/index.815ca599c9df.txt

Retrieved 2026-09-08. These are unmodified license texts. Including GPLv3 here supplies
the text incorporated by LGPLv3; it does not relicense Chat On Steroids as GPL software.

Upstream build/source projects:
- sharp: https://github.com/lovell/sharp
- Unix libvips builds: https://github.com/lovell/sharp-libvips
- Windows libvips builds: https://github.com/libvips/build-win64-mxe
- libvips source: https://github.com/libvips/libvips

The current dependency set uses sharp 0.35.4 / libvips 8.18.6. The release pipeline
places `Chat-On-Steroids-Native-Sources.tar.gz` beside the matching installers at:
https://github.com/totec448-spec/chat-on-steroids/releases
Use the source archive and checksums from the same release as your installer.

It contains original component archives, locked Rust dependency sources, build repositories,
patches, source license/copyright notices, a URL/SHA-256 inventory, and build/replacement
instructions. Source remains under its original individual licenses, including LGPLv3 and
MPL 2.0 where identified. `sources.json` distinguishes the Windows and Unix versions.
Optional/development sources are retained as an inclusive set; this does not imply that
every listed component is linked into every target. `COMPONENT-NOTICES.txt` preserves
notices from those source distributions, in addition to each target's actual native README.

You may modify these libraries and debug those modifications, including by reverse
engineering the combined application for that purpose. The application imposes no
additional restriction on those rights. Libraries are ordinary files under
`app.asar.unpacked`. See `SOURCE-BUILD.md` in the source download for exact revisions,
rebuilding and replacement. On macOS a modified application copy needs a new local
ad-hoc seal; no publisher key is required by this release.

Electron/Chromium notices ship separately as `LICENSE.electron.txt` and
`LICENSES.chromium.html` in application resources. Electron 44.3.0's source, dependency
revisions and build scripts are at https://github.com/electron/electron/tree/v44.3.0
(including its DEPS file). Tunnel and ripgrep retain their own notices.
