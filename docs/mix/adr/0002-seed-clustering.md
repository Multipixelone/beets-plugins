# 0002 — Cluster the seed playlist; allocate picks by cluster share

**Status:** accepted (2026-10-14)

## Decision

Cluster the seed playlist's own style vectors, give each cluster a share of the N picks proportional to its size (minimum one), and rank candidates within a cluster by summed similarity to the cluster's seeds whose nearest neighbours include them.

## Alternatives rejected

- **Centroid of all seeds** (what `beet similar` does): a playlist that mixes, say, bossa nova and indie folk averages to a point between the two that matches neither.
- **Pure per-seed neighbours with global voting:** keeps the strands intact, but the largest strand dominates every slot and small strands vanish.
- **Album-graph viewer communities:** album-level, computed in the browser at view time, never persisted, and limited to the exported subset (2,749 of 6,412 albums). Reusing them would mean porting and persisting a second clustering of the whole library for a playlist-local question.

## Consequences

- The clustering threshold becomes the main tuning knob; it's chosen by the hold-out evaluation, not by guessing.
- Each proposal can say which strand each pick belongs to and which seed it's nearest to.
