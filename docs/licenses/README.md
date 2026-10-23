# License supplements

`flora-colossus` 2.0.0 declares MIT in its npm manifest but omits a license file from the
distributed package. Its npm gitHead (`134ea667085bfd7f0a4c63420076eb97d41f1ad9`) also has
no LICENSE at the repository root. `flora-colossus-LICENSE` preserves the explicit MIT grant
published by its author at https://github.com/MarshallOfSound/flora-colossus/blob/main/LICENSE,
retrieved 2026-09-07. It retains the upstream copyright and complete permission/warranty text.

`atkinson-hyperlegible-next/LICENSE` is the SIL Open Font License 1.1 text shipped with
`@fontsource-variable/atkinson-hyperlegible-next` 5.2.6. The renderer bundles that package's four
Latin and Latin Extended WOFF2 files unmodified in `src/renderer/fonts/`, so the package itself is
not a dependency.

Other dependency notices are collected directly from the installed packages. The @img native
packages publish composite library attribution in their README files; those are also preserved.
The platform-specific `@napi-rs/canvas-*` binary packages declare MIT but omit the repository
license from their npm tarballs. `napi-rs-canvas-LICENSE` is the complete MIT license shipped by
their parent `@napi-rs/canvas` package from the same release and repository.
The packaging pipeline separately supplies the target-specific tunnel, ripgrep, image-library
and Electron/Chromium notices alongside those binaries.
