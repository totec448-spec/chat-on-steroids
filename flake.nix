{
  description = "Development and source-bundle builds for Chat On Steroids";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      eachSystem = f: nixpkgs.lib.genAttrs systems (system: f (import nixpkgs { inherit system; }));
      package = builtins.fromJSON (builtins.readFile ./package.json);
      mkBundle = pkgs: pkgs.buildNpmPackage {
        pname = package.name + "-bundle";
        version = package.version;
        src = self;
        nodejs = pkgs.nodejs_24;
        npmDeps = pkgs.importNpmLock { npmRoot = self; };
        npmConfigHook = pkgs.importNpmLock.npmConfigHook;
        npmFlags = [ "--ignore-scripts" ];
        dontNpmPrune = true;
        nativeBuildInputs = [ pkgs.python3 pkgs.pkg-config ];
        buildPhase = ''
          runHook preBuild
          node scripts/make-icon.mjs
          npm run build
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          mkdir -p "$out"
          cp -r out extension "$out/"
          cp package.json LICENSE "$out/"
          runHook postInstall
        '';
      };
      mkCheck = pkgs: name: command: (mkBundle pkgs).overrideAttrs (_: {
        buildPhase = ''
          runHook preBuild
          ${command}
          runHook postBuild
        '';
        installPhase = ''
          mkdir -p "$out"
          touch "$out/${name}"
        '';
      });
      mkApp = pkgs: import ./nix/package.nix {
        inherit pkgs;
        src = self;
        version = package.version;
        electronVersion = package.devDependencies.electron;
      };
    in {
      devShells = eachSystem (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [ nodejs_24 python3 pkg-config gnumake stdenv.cc git ripgrep unzip zip ];
        };
      });
      packages = eachSystem (pkgs: {
        bundle = mkBundle pkgs;
        default = mkBundle pkgs;
      } // nixpkgs.lib.optionalAttrs (pkgs.stdenv.hostPlatform.system == "x86_64-linux") {
        app = mkApp pkgs;
      });
      checks = eachSystem (pkgs: {
        bundle = mkBundle pkgs;
        typecheck = mkCheck pkgs "typecheck" "npm run typecheck";
        packaging = mkCheck pkgs "packaging" "npm test -- test/packaging.test.ts";
      } // nixpkgs.lib.optionalAttrs (pkgs.stdenv.hostPlatform.system == "x86_64-linux") {
        app = mkApp pkgs;
      });
    };
}
