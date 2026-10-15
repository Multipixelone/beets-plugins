# Mix design

Mix provides beets proposal/apply commands that grow playlists using the per-track embeddings already written by the [`embed`](../../plugins/embed/) plugin. The first interaction is _extend_: "take my Plex playlist `morning eggs` and add more songs like what's already in there."

This pass is backend only. A UI is a separate, later pass; the backend is shaped so a UI can wrap it without rewriting anything.

These documents capture the agreed v1 design (grilled 2026-10-13/14) and implementation status.

**2026-10-15 status:** The library and dev-only evaluator are implemented, and
the authorized full exploratory run completed. See the [dated evaluation
results](./EVALUATION.md) for the full grid, mapping losses and limitations.
Threshold 0.1/K=200 is exploratory only; production defaults remain unchanged.
Phase 3A now includes a source-level read-only `mix-extend` command and read
adapters, with independent offline validation and review passed; see the [command setup and
contracts](../../plugins/mix/README.md#phase-3a-read-only-mix-extend).
Phase 3B adds a source-level explicit-ID apply API and `mix-apply`, with
independent validation, structure review and Gate 6 passed; see the
[apply contract](../../plugins/mix/README.md#phase-3b-explicit-id-mix-apply).
Phase 4 repository packaging/worker integration and the
[self-contained Mix skill](../../skills/mix/SKILL.md) are repository-complete:
Gate 7 accepted and structure review passed. Installed checks and both CI commands
passed on **x86_64-linux only**; non-x86 systems were omitted, not validated.
The standard flake check passed in 76 seconds with 164 fresh Mix tests and full
wheel/dependency/import/metadata/installed proof. The separate default build with
`--no-link` passed in 4 seconds by reusing the matching already-built output,
not rerunning units. See [verification evidence](./VERIFICATION.md#phase-4-repository-packaging-and-skill-accepted)
for the native-help disposable-database boundary and separate static/simulation evidence.
Repository delivery does not install the skill into a host workspace, change
routing/configuration or authorize live writes. Deployment, OpenClaw installation,
activation/runtime and live Plex apply remain unverified/separate. The shared
absolute worker executable path was verified, never executed; inference and
production latency/tuning are not established. Its existing closure may realize
already pinned assets, with no new model pins.
The skill requires a user-chosen explicit threshold and subsequent approval of
the original numbered proposal; K100 is unchanged. Its title/key context binding
does not add an expected-key CLI precondition to the title-only apply command.

- [Domain language](./CONTEXT.md)
- [Design](./DESIGN.md)
- [Verification plan](./VERIFICATION.md)
- [Mix conversational skill](../../skills/mix/SKILL.md)
- [Exploratory evaluation results (2026-10-15)](./EVALUATION.md)
- [Architecture decisions](./adr/)
