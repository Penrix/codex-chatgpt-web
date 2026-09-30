# Penrix AI Coding Rules

Canonical source: `Penrix/ai-coding-cognition@487efcfb359f2700bd23de06fdd8c3cb141a92d7` (Penrix Coding Core 0.4.0).

This file is the repository-local compiled policy for AI-assisted coding. Repository-specific `AGENTS.md`, build rules, security rules, and domain contracts still apply. This file adds the Penrix owner/agent boundary and Reality gates; it does not erase more specific repository rules.

## Authority

Penrix owns product intent: observable behavior, scope, data effects, permissions, external side effects, cost, irreversible actions, and meaningful risk.

The coding agent owns ordinary engineering judgment: implementation mechanisms, architecture within the authorized scope, debugging, tests, code organization, dependency/API choices, and the technical research needed to make those choices.

Do not ask Penrix to choose programmer-only mechanisms when evidence can resolve them.

## Required workflow

For production-code work:

```text
recover current project reality
→ Reality Reconnaissance PRE
→ implement/debug/test
→ Complexity Gate when extra machinery appears
→ Reality Reconnaissance POST against the actual diff
→ fresh code verification / independent review as appropriate
→ target-runtime Reality Verification
→ owner handoff
```

The depth is proportional to the task. A purely internal mechanical edit may keep reconnaissance project-local; do not browse for ceremony.

## PRE — before the first production-code edit

Do not implement from model prior alone.

First establish the relevant current facts.

### Project reality

Inspect the actual repository state:

- current branch / HEAD and authoritative source baseline;
- code that currently owns the behavior;
- relevant tests, fixtures, recent commits, Issues, worklogs, and review findings;
- current dependency and configuration versions;
- existing accepted behavior plausibly at risk.

Old plans, READMEs, task contracts, and handoffs are leads, not automatic current truth.

### Current external reality

When an external platform, API, library, app, device, service, site, or upstream matters, inspect the smallest relevant set of:

- current official docs/specifications;
- releases/changelogs/migration notes;
- current upstream source and tests;
- current open/recent Issues or PRs;
- exact versions and platform support.

Do not stop at a README when source/tests/current Issues carry the implementation detail.

### User field reality

For non-trivial external or operational integrations, actively look for real user reports: upstream Issues/Discussions, vendor/community forums, Reddit or comparable technical communities, detailed setup reports, bug reports, and postmortems.

User reports are sensors, not automatic authority. Use them to discover real installation friction, platform quirks, failures, and working paths; corroborate material claims with current source/docs or direct reproduction when practical.

If credible field evidence is missing, record the gap instead of inventing consensus.

### Landing questions

Before coding across a material external boundary, be able to answer the relevant questions:

- What exact version/platform is targeted?
- How is it actually installed, enabled, configured, authorized, launched, and run?
- Which permissions, accounts, services, files, environment variables, or device state are required?
- Which component actually owns this behavior?
- What API/CLI/configuration/path is current?
- What version-specific failures are known?
- What do real users report as the successful path and common failure path?
- What recovery/rollback path exists?
- What exact target-environment observation would prove success?

Research that produces links but no implementation consequences is not sufficient.

## Preserve the accepted product

A requested change authorizes a behavior delta, not unrelated drift.

For non-trivial work, keep a small Preservation Envelope: existing accepted behaviors that are plausibly at risk from this change. Verify both the intended delta and those protected behaviors.

Prefer surgical changes. Every changed line should trace to the requested outcome or necessary cleanup caused by that outcome.

## Complexity Gate

New complexity has the burden of proof.

Before adding a fallback, hidden default, retry, debounce, rate limit, cooldown, queue, wrapper, adapter, facade, factory, interface, generalized helper, compatibility path, cache, shadow state, second source of truth, extra lifecycle/safety state, mock-heavy integration seam, or future extension point, answer:

1. What observed failure, explicit requirement, supported caller, or external contract requires it now?
2. Which component already owns this concern?
3. Why is the simpler direct path insufficient?
4. Is this production behavior or only test/diagnostic behavior?
5. Does it expose a violated assumption or hide it?

"Safer", "future-proof", "best practice", "might need it later", and "production systems usually do this" are not evidence.

One concern should have one authoritative owner unless current evidence proves composition is required.

## Engineering execution

Use the repository's existing engineering workflow. When Superpowers or equivalent specialist skills are available, use them for systematic debugging, TDD, planning, worktrees, verification, and review rather than inventing a second procedure layer.

For bugs, investigate root cause before fixing symptoms.

Tests must derive expectations from product intent, protocol, prior failing behavior, or an independent invariant. Do not rewrite tests merely to agree with the implementation.

## POST — before final self-review/completion

POST is not a reread of PRE notes.

Read the actual final diff and inventory the material assumptions the code now makes, including concrete:

- APIs and versions;
- flags/configuration;
- paths/files;
- permissions/account/runtime state;
- component ownership;
- retry/fallback/cache/lifecycle semantics;
- install/config/run steps;
- external/site/service behavior.

Re-query current docs, upstream source/tests/issues, and relevant user field reports using the actual final names and versions.

Classify each material assumption:

- `MATCH` — current evidence supports it.
- `MISMATCH` — current evidence contradicts the implementation.
- `UNVERIFIED` — evidence is missing or contradictory.

Fix a MISMATCH before claiming completion unless Penrix explicitly chooses a changed product behavior. Carry material UNVERIFIED items into the final evidence status.

Do not write code from memory and then search only for sources that agree with it. PRE constrains the design; POST tries to falsify the finished implementation.

## Verification classes

Completion is an evidence claim, not a confidence claim.

Use only:

- `LIVE VERIFIED`
- `CODE VERIFIED, LIVE UNVERIFIED`
- `NOT VERIFIED / BLOCKED`

Bind material evidence to:

`revision/package × actual environment × behavior exercised × observation time`

A build, unit test, lint, mock, fixture, documentation statement, or community report proves only its own surface. Research constrains implementation; it does not replace execution in the real target environment.

A red CI job where no runner/relevant step executed proves neither code failure nor success.

## Final handoff

For non-trivial work report, in plain language:

- what actually changed;
- what the user can now do;
- which current external/field facts materially constrained the implementation;
- what was actually verified;
- the evidence class;
- what remains unverified;
- the next engineering action;
- whether any real product/risk decision still needs Penrix.

Technical detail supports the handoff; it should not force the non-programmer owner to reconstruct project status from diffs and logs.
