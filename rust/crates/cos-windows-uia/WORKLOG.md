# Windows UI Automation tier 1 — parity and verification

The crate cos-windows-uia runs on the single desktop thread of `cos-windows-desktop`, in-process. It stores exact COM UIA handles in bounded snapshots and never reconstructs an element by scanning a reused RuntimeId.

The API is UiaState::new(), warm(), find(request) and act(request, host). find returns window/snapshotId/elements/visited/truncated/document_text/selected_text/focused_element. act returns the native {runtimeKey,name,route} object, whose route is uia or sendinput. UiaInputHost (implemented in worker-2 desktop crate) owns assert_input_owner(request), assert_focused(window), and click(x,y,button,count). Every native action carries a positive id/window and its entire app/related-window ownership envelope. The desktop dispatcher owns helper generation and batching.

## Existing TypeScript test mapping

| Prior suite | Rust policy and test evidence |
| --- | --- |
| computer-browser-uia | Synthetic ControlTree proves current BrowserRootView wins over stale tabs, ambiguous/missing roots reject, traversal is bounded to 128 siblings, and old tab descendants are revoked |
| computer-windows-accessibility | 96 exact cached snapshots; ControlView query/role traversal (max 10,000 visits; max 100 results; max depth 64); selected/focused text and real UIA supported patterns |
| computer-windows-accessibility | Semantic Invoke > Toggle > Select for a single primary click, physical fallback only for click; zero-bounds semantic controls retained; disabled and read-only patterns rejected; banker's rounding for exact pixel centers |
| computer-stale-ref / computer-generation | Snapshot/window/root/ancestry checks here; helper generation and public indexes owned by worker-2 |
| computer-partial-batch / computer-windows-input | Actual uia/sendinput route returned per action; partial batch and physical-input bounds owned by worker-2 host |
| windows-api | Result field and action route shape preserved; facade parity owned by worker-2 |

Browser class Chrome_WidgetWin_1 alone never proves a browser: select BrowserRootView only when the live window process matches a known browser token. A Chromium desktop app or a native dialog retains its own UIA root. The action resolves exactly the stored native UIA element handle, compares the current root, checks the element ancestry within depth 64, and rechecks owner authority before the native mutation. Explicit semantic actions never fall back to pointer clicks. Text provider priority is Document, then focused native editor, then other native editor; browser toolbar editors never supply page text. Selection and document share an 8,000 UTF-16-unit budget.

## Dependencies

This crate is MIT. uiautomation =0.25.1 is Apache-2.0; windows =0.62.2 and serde_json =1.0.154 are MIT OR Apache-2.0. The unmodified upstream uiautomation src/core.rs:38 unconditionally imports crate::inputs::MouseButton; disabling the input feature while enabling only pattern fails with Rust E0432. Enable pattern and input features for successful compilation, but use no native mouse/keyboard routines from uiautomation. Physical input authority remains the UiaInputHost trait. Lockfile and dependency license gate are centrally maintained by the foundation/prime owner.

## Integration evidence to be supplied by coordinator

Rust fmt, test and Clippy checks exercise Windows behavior at the compiled-library tier. Safe run-owned native WPF provider verification exercises the real COM bridge without physical foreground/input effects. Full native desktop dispatcher, MCP/control UI before-and-after journeys, packaging, notices, and full npm suite are coordinator-owned acceptance gates and must be reported separately.

### Local evidence, Windows 11 MSVC Rust 1.99.0

- cargo fmt --manifest-path rust/Cargo.toml -p cos-windows-uia -- --check: PASS.
- cargo test --manifest-path rust/Cargo.toml -p cos-windows-uia: 8 unit PASS; one opt-in native fixture test ignored by default.
- cargo clippy --manifest-path rust/Cargo.toml -p cos-windows-uia --all-targets -- -D warnings: PASS.
- cargo test --manifest-path rust/Cargo.toml -p cos-windows-uia --test native_semantic -- --ignored --nocapture: **1 PASS for the initial ASCII fixture**. It compiled and launched one owned hidden WPF fixture, exercised Rust MTA UIA observation, pattern invoke/toggle/click/set_value, verified actual UI state and action route fields, and checked unsupported/disabled refusals; no physical input. Its RAII fixture guard stopped the child and removed fixture build files; no run-specific fixture folder survived.
- node_modules/.bin/vitest.cmd run test/computer-browser-uia.test.ts: **1 PASS** for the original PowerShell root/snapshot synthetic provider oracle.
- npm run verify:privacy: PASS before initial source commit.

Observed test development issue: the WPF fixture's default console codepage encoded Arabic/editor Unicode incorrectly on redirected output. Setting Console.OutputEncoding on a WindowsApplication without a console also failed. The latest fixture uses direct Console.OpenStandardOutput with explicitly UTF-8 encoded bytes and asserts a native ValuePattern roundtrip of Arabic, an em dash, and emoji. **The revised Unicode fixture requires another run on the designated native window lane; its runtime success has not yet been verified.**

The foundation-managed deny.toml is absent from this isolated branch at this pin, so cargo deny was not run here; the coordinator's integrated license gate is pending. Full TS native accessibility WPF test, runtime end-to-end helper dispatcher, and MCP/UI parity are also coordinator-owned outstanding gates.

## Managed-client parity

The TypeScript helper observed through the managed `System.Windows.Automation` client, whose
client-side proxies and default HWND provider name and read some Win32 controls differently from
native UIA. `src/managed.rs` reproduces the rules the golden corpus records, with their source
files in dotnet/wpf: an HWND edit with no name is named by its window text and gives its text as
`document_text`; a title bar takes the window's title and is not focusable; the system menu bar is
"System Menu Bar" (the English resource). Desktop golden case 04 now matches; the replay test
`recorded_observations_of_the_recorder_target_match_the_corpus` asserts all four window cases.
The text and selection reads are bounded `SendMessageTimeoutW` queries (`WM_GETTEXT`,
`EM_GETSEL`), never input. "System Menu Bar" is not localized.
