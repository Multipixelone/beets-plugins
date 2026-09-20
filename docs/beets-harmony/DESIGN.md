# Beets Harmony v1 design

## Goal

Keep an unmatched album inside its current interactive `beet import` task while locating the corresponding Spotify release, handing it to Harmony for human-reviewed MusicBrainz creation, and resuming the same import with MusicBrainz metadata.

The plugin removes the need to point a second command at the source directory or move files between tools. MusicBrainz remains the mandatory tagging authority.

## Non-goals

- Creating MusicBrainz releases without the web editor and human review.
- Applying Spotify metadata to files or library items.
- Acting as a general beets metadata source.
- Supporting singleton-track imports, parallel handoffs, persisted handoff state, or a separate CLI.
- Running a local Harmony server or reproducing Harmony's seed-generation logic.
- Supporting non-interactive or quiet imports.

## User flow

1. Beets performs its normal MusicBrainz lookup.
2. If there are no MusicBrainz candidates, assistance starts automatically. If the best MusicBrainz recommendation is `medium` or weaker, beets offers `[H]armony seed`.
3. The plugin snapshots the exact active album task and searches Spotify.
4. An Exact Match is selected automatically. Otherwise, a numbered candidate prompt allows the user to accept a candidate, edit the query, enter a Spotify album URL or ID, inspect mismatch details, or cancel back to beets.
5. The plugin checks whether the exact Spotify URL already has a Linked Release in MusicBrainz. If so, it skips Harmony.
6. Otherwise it presents a hosted Harmony URL as visible text, an OSC 52 clipboard write, and a terminal QR code.
7. The user opens Harmony, taps **Import into MusicBrainz**, reviews and submits the release, then returns to the terminal and presses Enter.
8. The plugin discovers and validates the Submitted Release, then resumes the active import with a MusicBrainz proposal.
9. If seamless resumption is unavailable for the installed beets version, the plugin OSC-copies the MBID and returns to the normal prompt with instructions to press `i` and paste it.

At every point, `c` cancels only assistance and returns to beets. `Ctrl-C` retains normal beets semantics and aborts the import session.

## Supported tasks and editions

V1 handles album-mode tasks, including singles and EPs represented as releases. It does not run for singleton-track tasks.

A digital Source Album may qualify for automatic Spotify selection. A CD, vinyl, or other physical Source Album always requires explicit confirmation because Spotify describes a digital edition. The user can correct medium and other Edition Identity fields in the MusicBrainz editor.

Only one album task is assisted at a time. Beets owns interrupted-import recovery; the plugin stores no persistent workflow state.

## Spotify discovery

The plugin uses a narrow official Spotify Web API client rather than enabling beets' Spotify metadata source. This prevents Spotify candidates from entering normal beets matching.

The client implements only:

- Client Credentials authentication;
- bounded album search;
- exact album lookup;
- album-track pagination;
- optional batched track details when the endpoint is available.

Credentials are read lazily from `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`. Tokens remain in memory until shortly before expiry. A `401` refreshes once and retries once; a `429` honors `Retry-After`; ISRC enrichment is optional. Credentials, tokens, and authorization headers are always redacted.

The initial query preserves edition-bearing words. Punctuation and artist-credit formatting may be normalized, but markers such as “Deluxe,” “Remastered,” or anniversary years are never silently removed. Sparse tags or path-derived text may prefill an editable query but cannot establish an Exact Match.

## Album model and matching

The plugin creates an immutable local album snapshot from the current task:

```text
album artist
album title
date/year
medium hints
tracks:
  disc number
  track number
  title
  artist credits
  measured duration
  source path
```

Automatic selection uses hard gates rather than a single opaque score:

- normalized album artist and title agree;
- ordered track count and titles agree;
- at least 80% of local tracks have known durations;
- each compared duration differs by no more than three seconds;
- disc structure agrees for multi-disc releases;
- edition markers do not conflict;
- no competing candidate is similarly plausible;
- Various Artists releases also agree on per-track artist credits.

Candidates passing the hard gates are ranked with soft evidence such as date, album type, duration coverage, and title/credit similarity. The score ranks candidates but cannot override a hard conflict. Matching constants remain internal in v1 and are tuned from verbose rejection diagnostics rather than exposed as configuration.

## Harmony handoff

The canonical hosted URL is:

```text
https://harmony.pulsewidth.org.uk/release?url=<encoded-spotify-url>&region=US&category=default
```

The handoff requests Harmony's `category=default` provider set. This produces deterministic normal-provider enrichment for the selected Spotify release. V1 does not use `category=preferred`, because it depends on cookies in the receiving browser, or `category=all`, because Harmony explicitly does not recommend it. Harmony requires one **Import into MusicBrainz** tap; no supported query parameter safely removes it.

The plugin always prints the URL. If enabled, it also emits OSC 52 using clipboard selector `c` and renders a terminal QR code with Segno. OSC 52 is a direct short escape sequence, not a separate library. Clipboard and QR failures are warnings and never block or fail the import.

After presentation, the plugin waits at:

```text
Submit the release in MusicBrainz.
[Enter] submitted; begin lookup
[c] cancel assistance and return to beets
```

## MusicBrainz discovery

Before Harmony, and again after acknowledged submission, the primary lookup is the exact Spotify URL relationship:

```text
GET /ws/2/url?resource=<spotify-url>&inc=release-rels&fmt=json
```

Every returned release is fetched directly and validated against the selected Spotify release and Source Album. Exactly one validated release is required.

Post-submission polling uses absolute offsets from the acknowledgement time:

```text
0, 2, 5, 10, 20, 30, 60, 120 seconds
```

Polling stops at first success, sends one request at a time, uses a meaningful project User-Agent, and respects MusicBrainz rate limits. `poll_timeout` is a deadline, not a promise to issue every request.

After direct URL polling times out, the plugin may use indexed barcode and artist/title/date searches. Indexed results are always validated and are never accepted merely because they rank first. Ambiguity or continued absence falls back to an MBID prompt.

## Beets integration

Stable integration points:

- `before_choose_candidate` supplies the `[H]armony seed` prompt choice;
- `import_task_before_choice` identifies the automatic no-MusicBrainz-candidate path;
- the active task supplies `items`, `paths`, and source metadata.

The pinned beets implementation accepts only `importer.Action` from a custom `PromptChoice` callback, despite newer documentation describing proposal returns. Seamless proposal installation therefore lives behind a narrowly tested, version-gated compatibility adapter. The adapter is allowed to touch private candidate/proposal state only after a unique MusicBrainz proposal has been validated. Unknown versions fail to the ordinary `i` plus pasted-MBID workflow.

The plugin never writes tags, changes source files, or mutates library items before a MusicBrainz proposal is accepted. Normal beets code performs all metadata application and file operations.

Non-TTY, quiet, and unsupported task modes do not activate assistance or block input.

## Configuration

```yaml
plugins:
  - musicbrainz
  - harmony

harmony:
  spotify_market: US
  poll_timeout: 120
  osc52: true
  qr: true

musicbrainz:
  external_ids:
    discogs: true
    bandcamp: true
    spotify: true
    deezer: true
    tidal: true
```

The external-ID settings are recommended but never modified by the plugin. Missing Spotify credentials produce one concise warning per import session; subsequent tasks silently retain normal beets behavior.

## Logging

- Default: concise prompts, selected outcome, and actionable failures.
- `-v`: request summaries and match acceptance/rejection reasoning.
- `-vv`: response diagnostics with secrets and authorization data redacted.

## Source layout

```text
plugins/harmony/
├── beetsplug/harmony/
│   ├── __init__.py
│   ├── album.py
│   ├── spotify_api.py
│   ├── matching.py
│   ├── musicbrainz.py
│   ├── handoff.py
│   ├── beets_compat.py
│   └── errors.py
├── tests/
├── pyproject.toml
└── default.nix
```

`__init__.py` owns plugin configuration and orchestration. `album.py` normalizes the active task. API, matching, handoff, and compatibility concerns remain independently testable. `errors.py` contains the small typed nonfatal error vocabulary used to enforce fail-open behavior.

## Packaging

The plugin is GPL-3.0. It is included in the repository's default combined beets Nix package, with activation remaining explicit through the beets plugin list.

Runtime dependencies are beets, its existing HTTP dependency, and Segno. No Spotipy, OSC 52 library, Harmony client, persistence layer, background worker, or separate command is added.
