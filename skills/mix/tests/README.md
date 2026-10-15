# Offline skill authoring checks

These stdlib-only checks read the skill, synthetic fixtures and CLI source as text.
They never import the plugin, run `beet`, connect to Plex, read user configuration,
or generate proposals. No runtime approval parser or state file is provided.

From the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 skills/mix/tests/test_contract.py -v
```

For a copied skill, the same test entry point accepts absolute `--skill` and
`--cli` paths, pointing respectively to `SKILL.md` and the registered beets CLI
source file. Relative overrides are rejected. The fixture JSON is located next
to the selected skill under `evals/evals.json`; the working directory is irrelevant.

The checks cover the generated two-scalar YAML frontmatter format, line budget,
self-containment, actual CLI option declarations via AST, explicit protocol text,
strict finite fixture JSON, target consistency and original-ordinal arithmetic.
They deliberately do not implement natural-language approval interpretation.

The three prompts in `evals/evals.json` remain acceptance plans/fixtures, not run
results. Their expected argv and outcomes are synthetic oracles, not observed
model output. For a simulation, supply each case's `context` and the referenced top-level
`fixtures` as conversation context or fake tool responses. A prompt-only runner
must materialize this fixture extension; it must not silently omit the context.
Static checks establish text/fixture consistency, not agent compliance, real
OpenClaw operation, installed-package readiness, live quality, or authorization.
The eight static checks previously passed; they do not execute the LLM cases.
Separately, six offline fake-tool text traces covered three paired cases:
independent grading found **9/9 assertions, 3/3 cases with the skill**, versus
**7/9 assertions, 2/3 cases without it**. These are small supplied simulations,
not real CLI/OpenClaw runtime, statistical compliance or prompt-injection proof.
The original graded traces predate the renderer-stable ordinal clarification;
that formatting instruction has not been model-tested. A lexical regression
assertion now lives inside an existing test method; the suite still has eight
methods, with follow-up execution owned by the independent runner.
Any future simulated-tool runs must remain offline and be reported separately;
no model/API/CLI evaluation is started by this test entry point.
