## Scope

- Applies to the entire `beets-plugins` repository.
- Prefer minimal, targeted changes; avoid broad refactors unless requested.

## Repository layout

- `flake.nix` — central wiring for all package/plugin builds and dev shell.
- `plugins/*.nix` — package definitions for individual beets plugins: `autofix`, `savedformats`, `stylize`, `tcp`, `xtractor`, `yearfixer` (`tcp` is currently commented out in `flake.nix`).
- `plexsync/` — local packaging + `temperature.patch` for the `beets-plexsync` plugin, plus Nix expressions for vendored Python deps (`agno`, `brave-search`, `exa-py`, `jiosaavn-python`, `tavily-python`).
- `userrating/` — vendored Python plugin source, tests, and Nix packaging.
- `renovate.json` — Renovate configuration for automated dependency updates.
- `.github/workflows/`:
  - `ci.yml` — on push/PR, runs `nix flake check --print-build-logs` and `nix build .#packages.x86_64-linux.default --print-build-logs` as separate jobs.
  - `flake-update.yml` — scheduled `flake.lock` update PR every 3 days.

## Environment and tooling

- This is a Nix flake project (`.envrc` uses `use flake`).
- Prefer running commands in the flake/dev-shell environment.
- Keep changes reproducible through Nix (avoid ad-hoc host-only assumptions).

## Change conventions

- When adding or changing a plugin package:
  1. Update/create its Nix expression.
  2. Wire it in `flake.nix` (`let` bindings, `packages`, and `pluginOverrides` when applicable).
  3. Ensure namespace/package handling still works for `beetsplug` plugins.
- Keep metadata (`description`, `license`, `maintainers`) consistent with nearby package definitions.
- Preserve existing style in touched files (formatting/comments may be intentionally pragmatic).

## Validation checklist

Run the same checks as CI when changes affect build/package behavior:

```bash
nix flake check --print-build-logs
nix build .#packages.x86_64-linux.default --print-build-logs
```

For `userrating/` Python changes, also run its tests when feasible.

## PR/commit notes

- Explain _why_ a packaging/patch change is needed (upstream breakage, Python compatibility, namespace fix, etc.).
- Include which checks were run and their outcome.
