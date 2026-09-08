# Plugin notices and 2.0.8 source audit

Reviewed on 2026-09-08 for the full 2.0.8 source update, **Darkex by dark tibo**.
This review covers package notices, catalog license provenance, public source scope and
the automated validation pipeline. It does not establish clearance for every hosted-service
use, trademark, generated asset or native binary distribution.

## Findings

- All five downloadable catalog distributions were fetched from their recorded npm/PyPI
  URLs. Their archive integrity and retained license hashes match the inventory. Playwright
  supplies Apache-2.0; Blender, Fetch and Unity supply MIT. No separate NOTICE was present
  in those direct distributions. Transitive plugin dependencies are installed separately
  and retain their own package contents; these snapshots are not a complete dependency audit.
- Knowledge Memory 2026.8.31 omits LICENSE from its npm archive. Its retained supplement
  matches the package's exact upstream Git revision and preserves the MIT/Apache transition
  and documentation terms. The installed-plugin label now uses that reviewed information
  only for the exact package version. Custom/future versions do not inherit an old review.
  Snapshot projection also corrects older installed labels without reinstalling the plugin.
- HeyGen and Recraft are hosted services with separate terms, account permissions and usage
  requirements. The catalog does not represent either service as MIT software or grant rights
  to every generated output. Their official terms links were checked.
- Catalog SVGs are code-drawn illustrations with repository MIT attribution and a statement
  that they are not official logos. No remote artwork is fetched by the catalog UI.
- A clean Windows dependency installation supplies 88 production npm packages. The notice
  generator preserves their supplied license/notice files, native README attribution and
  the retained supplements, plus all seven catalog references. The flora-colossus supplement
  was compared against its upstream author's LICENSE.
- CI now validates this inventory, installed versions against the lockfile, missing production
  license material and catalog notice hashes. Optional packages absent on another target are
  permitted; an invalid installed manifest is not silently skipped. Packaging regenerates the
  notices on the packaging host and its runtime smoke check requires the output file.

## Native source and binary distribution

The native sharp/libvips distributions contain LGPL/MPL components. Release assembly now
requires a separate source artifact containing hash-verified component archives, Rust crate
sources, required runtime sources, build repositories, patches and notices. The inventory
is pinned to the actual sharp/@img package versions. Source downloads that change size or
SHA-256 fail the job; the resulting archive travels through the same candidate checksum and
publication gates as the installers. Installed notices link to that exact source asset.

Windows and Unix dependency versions were traced separately. Upstream release logs establish
the Unix Cargo resolution: only three unused crates were removed and none added/upgraded.
The Windows build/MXE recipes and dated Rust distribution identify its source/runtime set.
The source archive retains an inclusive dependency set; it does not assert every included
test, optional or other-target source is linked into every installer.

The audit caught a moved libimagequant v2.4.1 tag: today's source differs from the June
binaries. The original commit was recovered, and its historical archive reconstructed with
the exact Windows recipe SHA-256. The inventory uses that immutable original commit.
TIFF and Unix Fontconfig use exact-commit source mirrors, and the Windows libxml2 URL's
directory typo was corrected while preserving its original archive checksum.

Component, crate and runtime copyright/license notices are retained in the installed notice
inventory. Missing package license files were checked against exact source revisions or
packaged MPL declarations, with provenance preserved in `sources.json`. Electron/Chromium
notices are explicitly copied into application resources on every target; native smoke
requires them along with sharp, tunnel and ripgrep notices.

The selected LGPL route uses ordinary replaceable shared libraries under `app.asar.unpacked`.
The source download documents rebuild settings, DLL/shared-library locations and macOS
ad-hoc resealing, with no publisher-key requirement or application prohibition on modification
and reverse engineering for debugging those modifications. See
[source/build instructions](licenses/native/SOURCE-BUILD.md). The audit does not claim
bit-identical upstream compiler reproduction or a complete offline rebuild; neither is
treated as a substitute for required source, notices or replacement conditions.

## Primary sources

- [MIT license](https://opensource.org/license/mit): preservation of copyright and permission notices.
- [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0), section 4: license and applicable NOTICE retention;
  section 6: limits on trademark rights.
- [Memory's exact upstream LICENSE](https://github.com/modelcontextprotocol/servers/blob/a40bc270fb5ece62673f8a1196f57116d885c5eb/LICENSE):
  mixed contribution licensing during the upstream transition.
- [Catalog archive URLs, integrity and license hashes](licenses/plugins/inventory.json): exact direct-package evidence.
- [HeyGen terms](https://www.heygen.com/terms) and [Recraft terms](https://www.recraft.ai/legal/terms): separate service conditions.
- [LGPLv3](https://www.gnu.org/licenses/lgpl-3.0.html), section 4, and
  [MPL 2.0](https://www.mozilla.org/en-US/MPL/2.0/), sections 3.2 and 3.4:
  binary/source and notice duties. The GNU endpoint could not be re-fetched during this review;
  the retained publisher text and the earlier native supplement provenance were inspected.
- [Native supplement provenance](licenses/native/README.md) and
  [flora-colossus supplement provenance](licenses/README.md).

## Scope and validation record

The update was assembled in an isolated checkout based on current public main. It includes
the current source, tests, extension, packaging changes and public documentation. Recordings,
downloaded applications, screenshots, credentials, generated build directories and private
working notes are excluded. The original shared checkout is preserved.

The app, lockfile and companion version are 2.0.8. Release notes retain the requested name.
The existing browser, session, model-picker, plan, transcript and UI changes are included with
the plugin implementation; their regression suites run in the full CI gate.

A clean dependency install exposed concurrent Electron lazy downloads when multiple Vitest
workers first imported the module. Verification now resolves Electron once before starting
parallel tests. This prepares the dependency without launching the desktop application.

The first hosted CI run caught Git normalizing the upstream Playwright LICENSE's CRLF
bytes, invalidating its recorded hash on checkout. License snapshots and the generated
notice inventory now disable Git text conversion so the upstream bytes survive publication.
Local catalog package tests passed for all five downloadable entries, including Playwright
page-content verification independent of its inline/file snapshot presentation.

All three hosted CI jobs subsequently passed, including published-package integration checks
on Windows x64, macOS arm64 and Linux x64. The final release workflow additionally packages
and smoke-tests both CPU architectures on all three operating systems.

The next hosted pass exposed a race in the worker crash-order regression test on macOS and
Linux: it treated completion of the broker write as completion of the separate command-lease
write lane. The test now observes eventual on-disk command retirement after opening the broker
gate, while retaining the assertion that the command stays durable before that gate opens.
The production durability fence is unchanged.

The user's sent-image layout correction separates attachment tiles from the text bubble in
both pending and recorded messages. It removes reuse of the composer's fixed-size wrapper
and the conflicting image rules. The source change was also applied as a scoped patch to
the shared working tree. Typecheck and focused renderer regressions passed; a hidden Electron
render with the production CSS confirmed a transparent wrapper, 96px image tile and 8px gap
above the text-only bubble. No installed application was changed during this check.

A final desktop-launch review found runtime discovery using the inherited PATH while plugin
installation/startup independently used the SDK environment. Those callers now share one
minimal plugin environment. On macOS/Linux it preserves inherited PATH precedence and adds
the standard Homebrew/Node and user uv installation directories, without running shell
startup files or exposing the application's wider environment. Windows keeps its existing
path. Regression coverage checks desktop-style paths, precedence and idempotence.

Local validation: clean dependency installation; exact upstream archive/notice comparisons;
`npm run verify` passed 3,402 main tests and two shutdown tests (27 existing opt-in/platform
skips); production build passed. The new cross-platform live-plugin checks are tracked in the
PR's GitHub CI run. Source privacy and staged-file scope checks passed before publication.

CI also runs the opt-in published-package tests on Windows x64, macOS arm64 and Linux x64:
Memory writes/reads through the real CoS HTTP proxy and rejects a disabled cached call;
Fetch retrieves a loopback fixture; Playwright launches isolated headless Chromium and
navigates to a loopback page; Blender and Unity establish stdio connections and expose their
documented tools. Python 3.12 and uv 0.12.5 are provisioned explicitly. OAuth protocol tests
use local fixtures, not user accounts. Editor-side operations and paid hosted accounts remain
outside unattended CI, and these jobs do not test a packaged application's GUI runtime lookup.
