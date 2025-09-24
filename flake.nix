{
  description = "Multipixelone beets plugins";

  # inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  # FIXME revert to normal nixos-unstable when https://github.com/NixOS/nixpkgs/pull/445208 is merged
  inputs.nixpkgs.url = "github:doronbehar/nixpkgs/pkg/beetsPackages.alternatives";
  inputs.flake-utils.url = "github:numtide/flake-utils";

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }:
    flake-utils.lib.eachDefaultSystem (system: let
      # use git commit as version (i don't like this impl but i'll be brave)
      version = toString (self.shortRev or self.dirtyShortRev or self.lastModified or "unknown");
      pkgs = nixpkgs.legacyPackages.${system};
      pins = import ./npins;
      # python definitions & modules
      # beets = pkgs.beets.overrideAttrs (final: prev: {
      # Combine the existing patches with your new one.
      # patches = (prev.patches or []) ++ [./convert.patch];
      # version = pins.beets.revision;
      # src = pins.beets;
      # });
      beets = pkgs.beets;
      pythonPackages = pkgs.python3Packages;

      # packages
      tcp = pkgs.callPackage ./tcp.nix {inherit beets pythonPackages;};
      stylize = pkgs.callPackage ./stylize.nix {inherit pins beets pythonPackages;};
      savedformats = pkgs.callPackage ./savedformats.nix {inherit beets pythonPackages;};
      xtractor = pkgs.callPackage ./xtractor.nix {inherit pkgs beets pythonPackages;};
      yearfixer = pkgs.callPackage ./yearfixer.nix {inherit beets pythonPackages;};
      autofix = pkgs.callPackage ./autofix.nix {inherit beets pythonPackages;};
      userrating = pkgs.callPackage ./userrating {inherit beets pythonPackages version;};
      plexsync = pkgs.callPackage ./plexsync {inherit beets pythonPackages;};

      # beets & plugins
      beets-plugins = beets.override {
        # FIXME use mapattrs to make this cleaner
        pluginOverrides = {
          tcp = {
            enable = true;
            propagatedBuildInputs = [tcp];
          };
          stylize = {
            enable = true;
            propagatedBuildInputs = [stylize];
          };
          savedformats = {
            enable = true;
            propagatedBuildInputs = [savedformats];
          };
          xtractor = {
            enable = true;
            propagatedBuildInputs = [xtractor];
          };
          yearfixer = {
            enable = true;
            propagatedBuildInputs = [yearfixer];
          };
          autofix = {
            enable = true;
            propagatedBuildInputs = [autofix];
          };
          plexsync = {
            enable = true;
            propagatedBuildInputs = [plexsync];
          };
          # FIXME when https://github.com/gtronset/beets-filetote/issues/211 is closed
          # filetote = {
          #   enable = true;
          #   propagatedBuildInputs = [
          #     (pkgs.beetsPackages.filetote.overrideAttrs
          #       {
          #         version = pins.beets-filetote.revision;
          #         src = pins.beets-filetote;
          #       })
          #   ];
          # };
          alternatives = {
            enable = true;
            propagatedBuildInputs = [
              (pkgs.beetsPackages.alternatives.overrideAttrs
                {
                  version = pins.beets-alternatives.revision;
                  src = pins.beets-alternatives;
                })
            ];
          };
        };
      };

      # devEnv
      env = pkgs.mkShell {
        venvDir = "./.venv";
        buildInputs = [
          beets-plugins
          pythonPackages.python
          pythonPackages.venvShellHook
          pkgs.autoPatchelfHook
        ];
        name = "beetsplug";
        DIRENV_LOG_FORMAT = "";
      };
    in {
      packages = {
        tcp = tcp;
        stylize = stylize;
        savedformats = savedformats;
        xtractor = xtractor;
        yearfixer = yearfixer;
        autofix = autofix;
        userrating = userrating;
        plexsync = plexsync;

        default = beets-plugins;
      };
      devShells.default = env;
    });
}
