# Mix design

Mix is a proposed beets plugin that grows playlists using the per-track embeddings already written by the [`embed`](../../plugins/embed/) plugin. The first interaction is _extend_: "take my Plex playlist `morning eggs` and add more songs like what's already in there."

This pass is backend only. A UI is a separate, later pass; the backend is shaped so a UI can wrap it without rewriting anything.

These documents capture the agreed v1 design (grilled 2026-10-13/14) before implementation.

**2026-10-15 status:** The library and dev-only evaluator are implemented, and
the authorized full exploratory run completed. See the [dated evaluation
results](./EVALUATION.md) for the full grid, mapping losses and limitations.
Threshold 0.1/K=200 is exploratory only; production defaults remain unchanged.
Phase 3A now includes a source-level read-only `mix-extend` command and read
adapters, with independent offline validation and review passed; see the [command setup and
contracts](../../plugins/mix/README.md#phase-3a-read-only-mix-extend).
Phase 3B apply/write safety and later packaging/deployment remain pending.

- [Domain language](./CONTEXT.md)
- [Design](./DESIGN.md)
- [Verification plan](./VERIFICATION.md)
- [Exploratory evaluation results (2026-10-15)](./EVALUATION.md)
- [Architecture decisions](./adr/)
