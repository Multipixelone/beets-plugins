# Beets Harmony verification plan

## Claim

For an interactive album-mode import that lacks an acceptable MusicBrainz release, Beets Harmony can identify the correct Spotify edition, hand it to Harmony, discover the resulting MusicBrainz release, and continue the same beets task without writing metadata before MusicBrainz acceptance or changing normal beets behavior on failure.

The highest-risk false conclusions are:

- selecting the wrong Spotify edition automatically;
- applying Spotify rather than MusicBrainz metadata;
- mutating the beets task before a validated MusicBrainz proposal exists;
- blocking or changing imports when credentials, services, terminal features, or compatibility support are unavailable;
- treating an ambiguous or stale MusicBrainz search result as the newly submitted release.

## Evidence path

### 1. Pure album and matching behavior

Use immutable fixtures and deterministic unit tests to prove normalization, hard gates, ranking, and explanations independently of network and beets internals.

Required scenarios:

- single-disc exact match;
- multi-disc ordering and boundary mismatch;
- Various Artists per-track credit agreement and disagreement;
- featured artists and non-ASCII credits;
- missing durations below and at the 80% boundary;
- duration differences immediately below, at, and above three seconds;
- original, deluxe, remastered, expanded, clean, explicit, regional, and bonus-track variants;
- physical-versus-digital media conflict;
- tied or near-tied candidates;
- sparse and path-derived input refusing automatic selection.

### 2. Spotify protocol behavior

Mock HTTP at the client boundary. Do not use live Spotify in CI.

Cover:

- token acquisition and in-memory expiry;
- missing credentials and one-warning-per-session behavior;
- `401` refresh with one retry;
- `429` honoring `Retry-After`;
- timeout, malformed JSON, and API errors;
- bounded search and pagination;
- albums exceeding one track page;
- relinked or unavailable tracks;
- missing or forbidden optional track-detail/ISRC calls;
- redaction in verbose diagnostics.

### 3. MusicBrainz protocol behavior

Mock URL relationship lookup, direct release validation, polling time, and indexed fallback.

Cover:

- existing Linked Release found before handoff;
- Submitted Release found immediately and after several scheduled polls;
- deadline reached without issuing unnecessary calls;
- multiple URL-related releases with exactly one, none, or several passing validation;
- delayed or misleading barcode/title search results;
- HTTP `503`, malformed relationships, and rate-limit spacing;
- exact Spotify URL canonicalization variants;
- User-Agent presence and no parallel polling.

### 4. Terminal handoff behavior

Capture output bytes rather than relying on a real clipboard or camera.

Verify:

- canonical encoded Harmony URL with `region=US`;
- visible URL is always printed;
- OSC 52 uses selector `c` and the correct base64 payload;
- OSC 52 disabled, redirected output, non-TTY, and `TERM=dumb` remain safe;
- Segno renders the same URL;
- QR or OSC exceptions leave the plain URL and import flow intact;
- Harmony URL characters are encoded exactly once.

A separate manual smoke test through foot, Zellij, and SSH establishes real clipboard behavior because no portable feature probe can prove the complete terminal path.

### 5. Beets integration behavior

Use beets' terminal-session fixtures, fake metadata providers, and a real temporary library/source tree.

Cover:

- no MusicBrainz candidates activates assistance automatically;
- medium-or-weaker recommendations offer `[H]armony seed`;
- strong recommendations do not offer it;
- singleton, quiet, non-TTY, and unsupported task modes do nothing;
- cancellation returns to the unchanged beets prompt;
- `Ctrl-C` preserves importer abort behavior;
- no tags, files, library rows, task candidates, or proposal state change before validated resumption;
- the pinned compatibility adapter installs a validated proposal and normal beets applies it;
- unknown beets versions copy the MBID and return to `i` plus paste;
- sequential unmatched albums cannot leak state into one another.

### 6. Packaging evidence

The Nix derivation must install the `beetsplug.harmony` namespace, requests access, and Segno into the same Python environment as beets. Activation remains explicit.

Repository checks after implementation:

```text
nix flake check --print-build-logs
nix build .#packages.x86_64-linux.default --print-build-logs
```

Run the focused Python test suite inside the flake environment before the full Nix checks. Long Nix validation follows the repository's delegated `agent-run-long` workflow.

## Manual smoke path

Use a known album whose Spotify URL already links to MusicBrainz. This safely exercises task capture, Spotify selection, terminal handoff rendering, direct URL lookup, proposal installation, and fallback behavior without creating a junk MusicBrainz release.

A real new-release submission is opt-in release acceptance, not routine CI. When performed, use a legitimate missing release and record only the resulting MBID and observed outcome—never credentials or tokens.

## Verification ownership and budget

- Matching and normalization: implementation owner, pure tests.
- Spotify and MusicBrainz clients: implementation owner, mocked protocol tests.
- Beets compatibility adapter: implementation owner, pinned-version integration test plus unknown-version fallback test.
- Terminal path: implementation owner for byte-level tests; operator for one foot/Zellij/SSH smoke test.
- Nix package and combined beets output: independent background validation lane using repository CI commands.

The minimum release evidence is the focused suite, one pinned-beets integration test covering successful resumption, one fallback integration test, and successful Nix checks/build. Live Spotify and MusicBrainz writes are not required for every change.
