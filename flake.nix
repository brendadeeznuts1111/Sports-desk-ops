{
  # Hermetic toolchain + reproducibility checks. See docs/supply-chain.md ("Hermetic build").
  #
  # What is reproduced (a JS repo has no compile step, so "build" = runtime + install + tests):
  #   .#bun          the pinned Bun: fetched by the zip sha256 in toolchain/bun.pin.json, the
  #                  extracted binary asserted == the pinned upstream sha256, then ELF-patched
  #                  for the Nix glibc (so its own hash differs from upstream, by design).
  #   .#nodeModules  fixed-output derivation: `bun install --frozen-lockfile` from bun.lock +
  #                  the package.json files (+ the workspace bin targets bun links). Its NAR hash is pinned below, so any
  #                  machine that rebuilds it must produce byte-identical node_modules.
  #   .#regression   the offline regression suite from toolchain/steps/regression-suite.step.json
  #                  run in the Nix sandbox (no network) with .#bun; output is the normalized
  #                  result text (same normalizer as scripts/supply-chain/rerun.py).
  #
  #   nix build .#regression && nix build .#regression --rebuild   # 2nd build must be bit-identical
  description = "sportsdesk-ops hermetic Bun toolchain, reproducible node_modules, offline regression suite";

  # nixos-26.05 as of 2026-11-15; flake.lock pins the same rev + narHash.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/f1e5c356f35d07e7b71a6b5e6c9338e0b029e0c0";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      lib = pkgs.lib;
      pin = builtins.fromJSON (builtins.readFile ./toolchain/bun.pin.json);
      plat = pin.platforms."linux-x64";

      bun = pkgs.stdenvNoCC.mkDerivation {
        pname = "bun-pinned";
        version = pin.version;
        src = pkgs.fetchurl {
          url = plat.url;
          sha256 = plat.zipSha256;
        };
        nativeBuildInputs = [
          pkgs.unzip
          pkgs.autoPatchelfHook
        ];
        dontConfigure = true;
        dontBuild = true;
        dontStrip = true;
        unpackPhase = "unzip -q $src";
        installPhase = ''
          got=$(sha256sum ${plat.binaryPath} | cut -d' ' -f1)
          if [ "$got" != "${plat.binarySha256}" ]; then
            echo "upstream bun binary sha256 $got != pin ${plat.binarySha256}" >&2
            exit 1
          fi
          echo "upstream bun binary sha256 == pin ($got)"
          install -Dm755 ${plat.binaryPath} $out/bin/bun
          mkdir -p $out/share/bun-pin
          echo "$got" > $out/share/bun-pin/upstream-binary.sha256
        '';
      };

      workspacePackageJsons = map (d: ./packages + "/${d}/package.json") (
        builtins.filter (d: builtins.pathExists (./packages + "/${d}/package.json")) (
          builtins.attrNames (lib.filterAttrs (_: t: t == "directory") (builtins.readDir ./packages))
        )
      );

      lockSrc = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.unions (
          [
            ./bun.lock
            ./package.json
            ./bunfig.toml
            # bun links workspace "bin" entries only if their targets exist; these are symlinks
            # into the root bin/, cli/ and one scripts/ file
            ./packages/sportsdesk-ops/bin
            ./bin
            ./cli
            ./scripts/nsh_desk_cli.ts
          ]
          ++ workspacePackageJsons
        );
      };

      nodeModules = pkgs.stdenvNoCC.mkDerivation {
        name = "sportsdesk-node-modules";
        src = lockSrc;
        nativeBuildInputs = [ bun ];
        impureEnvVars = lib.fetchers.proxyImpureEnvVars;
        SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
        dontConfigure = true;
        dontFixup = true; # fixup would patch shebangs -> store refs, illegal in a FOD
        buildPhase = ''
          export HOME=$TMPDIR BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache
          bun install --frozen-lockfile --no-progress
        '';
        installPhase = ''
          mkdir -p $out
          cp -a node_modules $out/node_modules
          for d in packages/*/node_modules; do
            [ -d "$d" ] && mkdir -p "$out/$(dirname "$d")" && cp -a "$d" "$out/$d"
          done
        '';
        outputHashMode = "recursive";
        outputHashAlgo = "sha256";
        outputHash = "sha256-064DfXmdiR0ey4YRjRe5XJBKJ+dYiZmYS/8o6R34Lbc=";
      };

      regression = pkgs.stdenv.mkDerivation {
        name = "sportsdesk-regression";
        src = self;
        nativeBuildInputs = [
          bun
          pkgs.jq
          pkgs.python3
          pkgs.git
          pkgs.which
          pkgs.procps # dx monitor reads the process table with ps
        ];
        dontConfigure = true;
        buildPhase = ''
          export HOME=$TMPDIR TZ=UTC LANG=C.UTF-8 NO_COLOR=1 FORCE_COLOR=0
          cp -a ${nodeModules}/node_modules ./node_modules
          for d in ${nodeModules}/packages/*/node_modules; do
            rel=''${d#${nodeModules}/}; cp -a "$d" "$rel"
          done
          chmod -R u+w node_modules packages
          patchShebangs --build bin toolchain scripts
          # flake sources carry no .git; tests that enumerate tracked files use `git ls-files`
          git init -q && git add -A && git -c user.name=nix -c user.email=nix@localhost commit -qm src
          mapfile -t files < <(jq -r '.argv[2:][]' toolchain/steps/regression-suite.step.json)
          set +e
          bun test "''${files[@]}" > test.log 2>&1
          echo $? > exit_code
          set -e
          python3 -c 'import sys; sys.path.insert(0, "scripts/supply-chain"); from rerun import norm_bun_test; sys.stdout.write(norm_bun_test(open("test.log").read()))' > regression.normalized.txt
        '';
        installPhase = ''
          mkdir -p $out
          cp regression.normalized.txt exit_code $out/
          sha256sum regression.normalized.txt | cut -d' ' -f1 > $out/normalized.sha256
        '';
      };
    in
    {
      packages.${system} = {
        inherit bun nodeModules regression;
        default = regression;
      };
      checks.${system} = { inherit regression; };
      devShells.${system}.default = pkgs.mkShell { packages = [ bun ]; };
    };
}
