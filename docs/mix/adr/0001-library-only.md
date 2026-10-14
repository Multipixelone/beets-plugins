# 0001 — Candidates come only from the embedded library

**Status:** accepted (2026-10-14)

## Decision

Mix proposes only tracks already in the beets library with available embeddings. It never suggests music to acquire, now or later.

## Why

Every ranking signal (style vectors, text vectors, heads) exists only for embedded tracks. A discovery path would have to rank tracks with no embeddings, so similarity would fall back to metadata guesses, which is the problem Mix exists to avoid. Acquisition already has its own tool and safety boundary (`openclaw-music`), and a ~94k-track library is plenty of material to draw from.

## Consequences

- Tracks with stale fingerprints are temporarily ineligible until the nightly backfill re-embeds them.
- A "go find more music like this" feature, if ever wanted, belongs in a different tool that feeds the library; Mix sees those tracks only after they're imported and embedded.
