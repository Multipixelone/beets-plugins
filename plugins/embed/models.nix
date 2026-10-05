{ lib, fetchurl, linkFarm }:
let
  # One pinned manifest drives both fetches and the stored model identities.
  manifest = builtins.fromJSON (builtins.readFile ./beets_embed/models.json);
in
linkFarm "beets-embedding-models" (lib.mapAttrsToList (name: asset: {
  inherit name;
  path = fetchurl { inherit (asset) url hash; };
}) manifest.assets)
