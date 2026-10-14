# 0004 — The Kestrel skill lives in this repository

**Status:** accepted (2026-10-14)

## Decision

The OpenClaw/Kestrel skill that drives Mix is `skills/mix/SKILL.md` in this repository, versioned with the CLI it calls, and symlinked into the OpenClaw workspace.

## Why

The skill encodes the CLI contract (flags, JSON schema, approval flow). Keeping it next to the code means a contract change and its skill update land in one commit. The symlink pattern is already used for `commutecompass`.

## Consequences

- The skill must be self-contained under `skills/mix/` so it works through a symlink.
- The workspace still needs its own `SKILLS.md` routing row; that's a workspace change, not part of this repository.
