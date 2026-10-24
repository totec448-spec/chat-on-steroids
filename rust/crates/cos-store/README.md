# cos-store

The user-data folder of Chat On Steroids, in Rust, compatible with the TypeScript app's folder.

| Rust | Replaces | What it does |
|---|---|---|
| `AppPaths`, `LaunchArgs` | Electron `userData`, `isBackgroundLaunch` | Finds the folder (`%APPDATA%\chat-on-steroids` by default, or `--user-data-dir=<path>`) and reads `--background`. |
| `ConfigStore` | `src/main/config.ts`, `mergeSettings` in `src/main/ipc.ts` | Loads `config.json`, repairs or rejects each field as `configSchema` does, keeps an unusable file's bytes, saves atomically, and merges the Settings form's `{ base, patch }` save. |
| `BridgePortOverride` | `bridgePortSelection` in `src/main/bridge-ports.ts` | Reads `CLF_BRIDGE_PORTS`. While it holds ports, a Settings save that edits the bridge port is refused. |
| `DurableStore`, `Durable<T>` | `src/main/durable.ts` | Reads and writes `state/<name>.json`: temp file then rename, one write at a time per file, 300 ms coalescing, strict reads for authority ledgers, recovery copies. `revision()` (`durableRevision`) changes each time a write, a removal or a recovery reaches disk. |
| `Logger` | `src/main/logger.ts` | The 500-line Activity ring, credential masking, `app.log` with one 4 MiB rotation, crash snapshots. |
| `Instance` | `app.requestSingleInstanceLock`, `second-instance` | One running app per folder. A later launch sends its command line to the first and exits. |

## How it is proven

`oracle/*.oracle.ts` run the TypeScript modules themselves (under vitest, without Electron) over
the same inputs and record the results in `tests/oracle/*.json`. The tests under `tests/` feed
the same inputs to this crate and require the same values and the same file bytes. To record
again, from the repository root (it needs `node_modules`):

```sh
node rust/crates/cos-store/oracle/regenerate.mjs
```

The same run writes `src/shipped.json`: the first-launch and recovery configs and the superseded
Goal prompts, exported from the app rather than copied by hand.

## Known differences from the TypeScript app

- A string cut by length in UTF-16 units drops half of a split surrogate pair, which JavaScript
  keeps as a lone surrogate (`mcp.instructions`, log lines).
- A config file that cannot be used is copied byte for byte. TypeScript writes the decoded text,
  which differs only for invalid UTF-8.
- Temp files are flushed to disk before the rename. TypeScript does not flush, so a power cut
  could leave an empty file there.
- `serde_json` refuses some JSON that `JSON.parse` takes: numbers beyond `f64`, lone surrogate
  escapes and nesting deeper than 128. Such a file reads as unreadable instead.
- The single-instance lock is this crate's own (`instance.lock` and `instance.json`), so it does
  not see an Electron build running on the same folder.
- While the owner runs, a later launch that cannot use `instance.json` (someone deleted it, or
  it names a dead port) waits 5 seconds and then fails with an error that says another process
  holds the folder. It never becomes a second owner. The folder works again once the owner
  exits.
- On Windows the owner keeps `instance.lock` open without delete sharing, so nobody can delete
  or rename the lock file or the folder while the owner runs. On macOS and Linux the lock is an
  advisory `flock` on the file, and the OS does not stop a delete. If someone deletes
  `instance.lock` or the whole folder under a running owner, the next launch creates a new
  `instance.lock`, takes it and runs as a second owner on the same path.
- `Durable::revision` belongs to one ledger handle. A new `DurableStore` and its ledgers take the
  place of `initDurableStore`: each revision read before then differs from the new ones.
- `save_settings` takes the `CLF_BRIDGE_PORTS` override as an argument
  (`BridgePortOverride::from_env()`), where TypeScript reads the environment on each save.

## Deliberate differences from the TypeScript app

- A Settings save keeps `ui.lastSeenVersion`. The TypeScript handler (`settings:save` in
  `src/main/ipc.ts`) rebuilds `ui` without it, so What's New shows again after each Settings
  save. The Settings differential test applies this difference to the recorded TypeScript
  result, and it fails if TypeScript starts to keep the value.
