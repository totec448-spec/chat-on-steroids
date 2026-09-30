{
  description = "Chat On Steroids development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      package = builtins.fromJSON (builtins.readFile ./package.json);

      versionMajor = value:
        let
          match = builtins.match "[^0-9]*([0-9]+).*" value;
        in
        if match == null then
          throw "Could not read a major version from ${value}"
        else
          builtins.elemAt match 0;

      electronAttr = "electron_${versionMajor package.devDependencies.electron}";
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;

      developmentFor =
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          electron =
            if builtins.hasAttr electronAttr pkgs then
              pkgs.${electronAttr}
            else
              throw "nixpkgs does not provide ${electronAttr}, required by package.json";
          # Match the development runtime used by CI. @types/node follows
          # Electron's embedded Node version, not the host development runtime.
          nodejs = pkgs.nodejs_22;

          nodeModules = pkgs.importNpmLock.buildNodeModules {
            npmRoot = ./.;
            inherit nodejs;
            derivationArgs = {
              # Electron 44's npm install script downloads its own runtime even when
              # ELECTRON_SKIP_BINARY_DOWNLOAD is set. Keep dependency installation
              # offline/reproducible and point the JS package at nixpkgs Electron below.
              npmRebuildFlags = [ "--ignore-scripts" ];

              nativeBuildInputs = [ pkgs.pkg-config ];
              buildInputs = [ pkgs.vips ];
              env.SHARP_FORCE_GLOBAL_LIBVIPS = "1";

              preInstall = ''
                export PATH="$PWD/node_modules/.bin:$PATH"

                # Keep both Electron consumers on the nixpkgs runtime. The npm
                # package resolves through path.txt, while electron-vite directly
                # spawns node_modules/electron/dist/electron.
                printf '%s' electron > node_modules/electron/path.txt
                rm -rf node_modules/electron/dist
                ln -s ${electron.dist} node_modules/electron/dist

                # npm scripts are disabled above, so build the one native dependency
                # that intentionally uses nixpkgs libvips instead of a bundled copy.
                pushd node_modules/sharp >/dev/null
                node install/build.js
                popd >/dev/null
              '';
            };
          };
        in
        {
          inherit pkgs electron nodejs nodeModules;
        };
    in
    {
      devShells = forAllSystems (
        system:
        let
          development = developmentFor system;
          inherit (development) pkgs electron nodejs nodeModules;
          inherit (pkgs) lib;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.importNpmLock.hooks.linkNodeModulesHook
              nodejs
              nodejs.passthru.python
              electron
              pkgs.git
              pkgs.gnutar
              pkgs.pkg-config
              pkgs.vips
              pkgs.ripgrep
              pkgs.unzip
            ];

            npmDeps = nodeModules;
            ELECTRON_OVERRIDE_DIST_PATH = "${electron.dist}";
            SHARP_FORCE_GLOBAL_LIBVIPS = "1";
            LD_LIBRARY_PATH = lib.makeLibraryPath [
              pkgs.stdenv.cc.cc.lib
              pkgs.vips
            ];
          };
        }
      );

      checks = forAllSystems (system: {
        node-modules = (developmentFor system).nodeModules;
      });
    };
}
