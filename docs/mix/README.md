# Mix design

Mix is a proposed beets plugin that grows playlists using the per-track embeddings already written by the [`embed`](../../plugins/embed/) plugin. The first interaction is _extend_: "take my Plex playlist `morning eggs` and add more songs like what's already in there."

This pass is backend only. A UI is a separate, later pass; the backend is shaped so a UI can wrap it without rewriting anything.

These documents capture the agreed v1 design (grilled 2026-10-13/14) before implementation.

- [Domain language](./CONTEXT.md)
- [Design](./DESIGN.md)
- [Verification plan](./VERIFICATION.md)
- [Architecture decisions](./adr/)
