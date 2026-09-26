{ pkgs, src, version, electronVersion }:

let
  inherit (pkgs) lib;
  sharpVersion = (builtins.fromJSON (builtins.readFile (src + "/package-lock.json"))).packages."node_modules/sharp".version;
  electron = pkgs.electron_44-bin.overrideAttrs (_: {
    version = electronVersion;
    src = pkgs.fetchurl {
      url = "https://github.com/electron/electron/releases/download/v${electronVersion}/electron-v${electronVersion}-linux-x64.zip";
      hash = "sha256-BFhqDsRsMoP72u+FUw9WH3HwteE2rQy572NoNhVgl4A=";
    };
  });
  tunnelVersion = "v0.0.15";
  tunnel = pkgs.fetchurl {
    url = "https://github.com/openai/tunnel-client/releases/download/${tunnelVersion}/tunnel-client-${tunnelVersion}-linux-amd64.zip";
    hash = "sha256-jINtxdaNaLZj2aXFso/5+ngNn3o//7HDBogLjzL6tfE=";
  };
  ripgrepVersion = "15.2.0";
  ripgrep = pkgs.fetchurl {
    url = "https://github.com/BurntSushi/ripgrep/releases/download/${ripgrepVersion}/ripgrep-${ripgrepVersion}-x86_64-unknown-linux-musl.tar.gz";
    hash = "sha256-M+FbzxYkslzdKlWBOkei+V2+EmJoID52qmpYXR57FJw=";
  };
  mainWrapper = pkgs.writeText "chat-on-steroids-main.js" ''
    const path = require('node:path');
    const { app } = require('electron');
    Object.defineProperty(process, 'resourcesPath', {
      get: () => path.join(__dirname, 'resources'),
      configurable: false,
    });
    app.setVersion('${version}');
    require('./out/main/index.js');
  '';
in
pkgs.buildNpmPackage {
  pname = "chat-on-steroids";
  inherit version src;
  nodejs = pkgs.nodejs_24;
  npmDeps = pkgs.importNpmLock { npmRoot = src; };
  npmConfigHook = pkgs.importNpmLock.npmConfigHook;
  npmRebuildFlags = [ "--ignore-scripts" ];
  env = {
    ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
  };
  nativeBuildInputs = with pkgs; [
    copyDesktopItems makeWrapper unzip
  ];
  buildInputs = [ pkgs.stdenv.cc.cc.lib ];
  # Sharp's vendored libvips binary fails during initialization if patchelf
  # rewrites it. Keep the lockfile binaries intact and supply libstdc++ below.
  dontPatchELF = true;
  dontStrip = true;
  postBuild = ''
    node scripts/make-icon.mjs
  '';
  installPhase = ''
    runHook preInstall
    npm prune --omit=dev --ignore-scripts
    find node_modules/@img -mindepth 1 -maxdepth 1 \
      ! -name colour ! -name sharp-linux-x64 ! -name sharp-libvips-linux-x64 \
      -exec rm -rf {} +
    appDir=$out/lib/chat-on-steroids
    mkdir -p "$appDir/resources" "$out/bin"
    cp -r out node_modules package.json "$appDir/"
    cp -r extension "$appDir/resources/"
    install -Dm444 LICENSE THIRD-PARTY-NOTICES.txt -t "$appDir/resources"
    install -Dm444 build/runtime-icon.png "$appDir/resources/runtime-icon.png"
    mkdir -p "$appDir/resources/tunnel" "$appDir/resources/rg"
    unzip -q ${tunnel} -d "$appDir/resources/tunnel"
    printf '%s\n' '${tunnelVersion}' > "$appDir/resources/tunnel/VERSION"
    chmod +x "$appDir/resources/tunnel/tunnel-client" "$appDir/resources/tunnel/cloudflared"
    mkdir -p "$TMPDIR/ripgrep"
    tar -xzf ${ripgrep} -C "$TMPDIR/ripgrep"
    install -Dm555 "$TMPDIR/ripgrep/ripgrep-${ripgrepVersion}-x86_64-unknown-linux-musl/rg" \
      "$appDir/resources/rg/rg"
    printf '%s\n' '${ripgrepVersion}' > "$appDir/resources/rg/VERSION"

    substituteInPlace "$appDir/package.json" \
      --replace-fail '"main": "out/main/index.js"' '"main": "main.js"'
    install -Dm444 ${mainWrapper} "$appDir/main.js"
    makeWrapper ${lib.getExe electron} "$out/bin/chat-on-steroids" \
      --add-flags "$appDir" \
      --set ELECTRON_FORCE_IS_PACKAGED 1 \
      --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]} \
      --inherit-argv0

    install -Dm444 build/icon.png \
      "$out/share/icons/hicolor/1024x1024/apps/chat-on-steroids.png"
    runHook postInstall
  '';
  desktopItems = [
    (pkgs.makeDesktopItem {
      name = "chat-on-steroids";
      desktopName = "Chat On Steroids";
      comment = "Local coding bridge for ChatGPT over MCP";
      exec = "chat-on-steroids %U";
      icon = "chat-on-steroids";
      categories = [ "Development" ];
      startupWMClass = "chat-on-steroids";
    })
  ];
  doInstallCheck = true;
  installCheckPhase = ''
    "$out/lib/chat-on-steroids/resources/rg/rg" --version | grep -F "ripgrep ${ripgrepVersion}"
    "$out/lib/chat-on-steroids/resources/tunnel/tunnel-client" --version | grep -F "${lib.removePrefix "v" tunnelVersion}"
    COS_NIX_APP_DIR="$out/lib/chat-on-steroids" \
      LD_LIBRARY_PATH=${lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]} \
      ELECTRON_RUN_AS_NODE=1 ${lib.getExe electron} -e '
        const b = process.env.COS_NIX_APP_DIR + "/node_modules/";
        const sharp = require(b + "sharp");
        const Parser = require(b + "tree-sitter");
        const parser = new Parser();
        parser.setLanguage(require(b + "tree-sitter-bash"));
        require(b + "node-pty");
        if (process.versions.electron !== "${electronVersion}" ||
            sharp.versions.sharp !== "${sharpVersion}" ||
            parser.parse("echo nix").rootNode.type !== "program") process.exit(1);
      '
  '';
  meta = {
    description = "ChatGPT desktop workspace with local MCP tools";
    homepage = "https://github.com/totec448-spec/chat-on-steroids";
    license = lib.licenses.mit;
    mainProgram = "chat-on-steroids";
    platforms = [ "x86_64-linux" ];
    sourceProvenance = with lib.sourceTypes; [ fromSource binaryNativeCode ];
  };
}
