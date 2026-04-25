<h1 align="center">beets-plugins</h1>
<div align="center">

[![Build](https://img.shields.io/github/actions/workflow/status/Multipixelone/beets-plugins/ci.yml?style=for-the-badge&logo=github&label=build&color=a6e3a1&labelColor=313244&logoColor=cdd6f4)](https://github.com/Multipixelone/beets-plugins/actions)
[![License](https://img.shields.io/github/license/Multipixelone/beets-plugins?style=for-the-badge&logo=creativecommons&color=b4befe&labelColor=313244&logoColor=cdd6f4)](LICENSE)
![beets](https://img.shields.io/badge/beets-plugins-fab387?style=for-the-badge&logo=musicbrainz&labelColor=313244&logoColor=cdd6f4)
![Nix](https://img.shields.io/badge/nix-flakes-89b4fa?style=for-the-badge&logo=nixos&labelColor=313244&logoColor=cdd6f4)

</div>

My collection of [beets](https://beets.io/) plugins for NixOS, packaged and built with Nix flakes.

## Plugins

- [`plexsync`](./plugins/plexsync/) — sync beets metadata to Plex-related workflows
- [`userrating`](./plugins/userrating/) — manage user ratings in beets
- [`yearfixer`](./plugins/yearfixer.nix) — package definition for year-related metadata fixes
- [`xtractor`](./plugins/xtractor.nix) — package definition for extraction utilities
- [`tcp`](./plugins/tcp.nix) — package definition for TCP-related plugin tooling
- [`stylize`](./plugins/stylize.nix) — package definition for style/format metadata helpers

## Development

```bash
nix flake check
nix build .#packages.x86_64-linux.default
```
