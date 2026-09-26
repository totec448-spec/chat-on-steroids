# Build and test

Use Node 24 LTS and the committed `package-lock.json`. Run `npm ci` after cloning or changing dependencies. On Linux and macOS, `nix develop` supplies Node 24 and the build tools; then run the same npm commands as other contributors.

```sh
nix develop                    # optional; Linux and macOS
npm ci
npm run verify                # privacy, notices, types and tests
npm run build                 # Electron main, preload and renderer
```

`npm run verify` runs the ordinary Vitest suite and then the desktop and shutdown suites with one worker. Those last suites exercise native windows and must not compete with other tests. Run a focused test with `npm test -- test/name.test.ts` while working.

## Nix outputs

```sh
nix build .#bundle            # compiled app and extension in result/
nix build .#app               # runnable x86_64 Linux package
nix run .#app                 # launch the x86_64 Linux package
nix flake check               # bundle, types, packaging and Linux app checks
```

The Nix bundle uses dependencies from the committed npm lockfile. It contains the compiled app, extension, package metadata and license. It is an intermediate build artifact. The x86_64 Linux app also includes the pinned Electron, native modules, tunnel client and ripgrep; its build checks those runtimes under Electron. Nix uses upstream release checksums and follows the packaging conventions in nixpkgs. Windows, macOS and Linux installer formats still use the target-OS package script below. `nix flake check` does not replace the full `npm run verify` test gate.

The build uses Node 24 LTS. Vite stays on 7 because electron-vite 5 declares Vite 5–7 support; Node types stay on 24 to match Electron. The node-pty prerelease supplies the native prebuild layout checked by the package script. Tunnel and ripgrep versions and checksums live in `scripts/packaging-versions.mjs`.

## Native packages

```sh
node scripts/package.mjs --platform linux --arch x64
node scripts/package.mjs --platform darwin --arch arm64
node scripts/package.mjs --platform win32 --arch x64
```

Use the command matching the machine you are building on. Add `--dir` for an unpacked application. Omit `--platform` and `--arch` to use the current host, or pass `--arch x64,arm64` to prepare both architectures. The script builds once, stages checksum-verified target resources and native dependencies, then calls electron-builder for each requested architecture. Artifacts go to `release/` and are never published by this command.

CI runs the same verification command on Windows, macOS and Linux. Release CI builds all six native targets, smokes the packaged runtimes and checks the output archives. Publishing remains a separate tagged workflow.
