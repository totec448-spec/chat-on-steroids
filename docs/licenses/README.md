# License supplements

`flora-colossus` 2.0.0 declares MIT in its npm manifest but omits a license file from the
distributed package. Its npm gitHead (`134ea667085bfd7f0a4c63420076eb97d41f1ad9`) also has
no LICENSE at the repository root. `flora-colossus-LICENSE` preserves the explicit MIT grant
published by its author at https://github.com/MarshallOfSound/flora-colossus/blob/main/LICENSE,
retrieved 2026-09-07. It retains the upstream copyright and complete permission/warranty text.

`@hugeicons/core-free-icons` 4.3.2 likewise declares MIT and lists `LICENSE` in its published
file manifest, but the installed npm archive omits that file. `hugeicons-core-free-icons-LICENSE`
preserves the upstream Hugeicons MIT license from https://github.com/hugeicons/hugeicons/blob/main/LICENSE.md,
retrieved 2026-09-10. The upstream license explicitly applies its MIT terms to the free icons and
repository source code; paid Pro icon packs are governed separately and are not used here.

Other dependency notices are collected directly from the installed packages. The @img native
packages publish composite library attribution in their README files; those are also preserved.
The packaging pipeline separately supplies the target-specific tunnel, ripgrep, image-library
and Electron/Chromium notices alongside those binaries.
