## Scope

- Applies to the entire `beets-plugins` repository.
- Prefer minimal, targeted changes; avoid broad refactors unless requested.

## Repository layout

- `flake.nix` — central wiring for all package/plugin builds and dev shell.
- `plugins/*.nix` — package definitions for individual beets plugins: `autofix`, `savedformats`, `stylize`, `tcp`, `xtractor`, `yearfixer` (`tcp` is currently commented out in `flake.nix`).
- `plugins/plexsync/` — local packaging + `temperature.patch` for the `beets-plexsync` plugin, plus Nix expressions for vendored Python deps (`agno`, `brave-search`, `exa-py`, `jiosaavn-python`, `tavily-python`).
- `plugins/userrating/` — vendored Python plugin source, tests, and Nix packaging.
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

For `plugins/userrating/` Python changes, also run its tests when feasible.

## PR/commit notes

- Explain _why_ a packaging/patch change is needed (upstream breakage, Python compatibility, namespace fix, etc.).
- Include which checks were run and their outcome.

## Album renderer visual baseline

- Deployment: <https://albums.nyc.finnrut.is/?data=data.json>
- Checked in Chrome on 2026-10-06: page loaded as “Album similarity graph” with `data.json`.
- Dataset status: 177 albums, 663 links, 32 sound communities; 176 covers in view and 0 unavailable.
- The page exposes controls for album search, similarity edges, physics, node rendering and size, color/grouping, and fitting/pausing the graph.

## Local album renderer workflow for Astra

The renderer source is in `plugins/embed/viewer/`. Local library data is available
at `beets-album-graph/albums.json`, with its thumbnails in
`beets-album-graph/covers/`.

1. From the repository root, start the packaged viewer:

   ```sh
   nix run .#beets-album-graph -- --data beets-album-graph/albums.json --covers beets-album-graph/covers
   ```

   Wait for the server to print:

   ```text
   Album graph: http://127.0.0.1:8765/?data=data.json
   ```

   Keep that process running while inspecting the page.

2. Use the **Google Chrome extension** through the browser-control tools to open
   <http://127.0.0.1:8765/?data=data.json>. Inspect the local version in Chrome:
   read the page state and capture a screenshot to see the graph, covers, and
   controls. Use the local URL for design work and troubleshooting.

3. Confirm that the album export loads and cover images appear. The server maps
   `/data.json` to the selected `albums.json` file and `/covers/` to the selected
   thumbnail directory. If the page fails to load, inspect the server output;
   if the UI or graph fails, inspect Chrome's console errors and the visible
   page state. The graph requires WebGL 2.

4. Make frontend changes in `plugins/embed/viewer/` (`index.html`, `style.css`,
   `app.mjs`, and related modules). The Nix command serves built assets and has
   no hot reload: stop the previous server, rerun the command after edits, and
   reload the Chrome tab to inspect the rebuilt version.

5. If port 8765 is occupied, reuse the existing viewer when appropriate or pass
   `--port 8766` and open <http://127.0.0.1:8766/?data=data.json> instead.
