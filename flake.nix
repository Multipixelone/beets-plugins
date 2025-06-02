{
  description = "Multipixelone beets plugins";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
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
      # python definitions & modules
      beets = pkgs.beetsPackages.beets-minimal;
      pythonPackages = pkgs.python3Packages;

      # packages
      tcp = pkgs.callPackage ./tcp.nix {inherit beets pythonPackages;};
      stylize = pkgs.callPackage ./stylize.nix {inherit beets pythonPackages;};
      savedformats = pkgs.callPackage ./savedformats.nix {inherit beets pythonPackages;};
      userrating = pkgs.callPackage ./userrating {inherit beets pythonPackages version;};
      plexsync = pkgs.callPackage ./plexsync {inherit beets pythonPackages;};

      # beets & plugins
      beets-plugins = pkgs.beets.override {
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
          plexsync = {
            enable = true;
            propagatedBuildInputs = [plexsync];
          };
          filetote = {
            enable = true;
            propagatedBuildInputs = [pkgs.beetsPackages.filetote];
          };
          alternatives = {
            enable = true;
            propagatedBuildInputs = [pkgs.beetsPackages.alternatives];
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
        userrating = userrating;
        plexsync = plexsync;

        default = beets-plugins;
      };
      devShells.default = env;
    });
}
