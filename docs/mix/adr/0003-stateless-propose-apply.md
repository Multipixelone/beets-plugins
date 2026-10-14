# 0003 — Stateless propose / apply, appending to the original playlist

**Status:** accepted (2026-10-14)

## Decision

`mix-extend` is read-only and returns a numbered proposal. `mix-apply` takes explicit beets item IDs and appends them to the end of the **original** playlist. Nothing is persisted between the two steps, and rejections are not remembered.

## Why

- Finn wants the playlist he shuffles to keep growing, not a stale `morning eggs +` copy beside it.
- He'd rather delete an unwanted track in Plexamp than maintain rejection memory, so per-playlist rejection state isn't worth wiring.
- Passing IDs keeps apply idempotent (already-present IDs are skipped) and removes any proposal store, expiry, or cleanup.
- Appending without reordering matches shuffle listening.

## Consequences

- The caller (Kestrel, later a UI) holds the proposal and maps "all but 3, 7" to IDs.
- A previously deleted suggestion can be proposed again. That's accepted.
