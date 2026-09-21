# WebCodex continuity DEV slice

Status: experimental, DEV-harness only. This is not wired into the production Responses route yet.

## Why this slice exists

The ChatGPT Web adapter already supplies the model and can already participate in local tool rounds. The missing boundary is not "give the Web model a body"; it is "do not let one native Codex thread be the only owner of long-running task state."

This slice therefore treats the native/DEV thread id as an **ephemeral model-context identity** and binds it explicitly to WebCodex durable state:

```text
Codex/DEV thread id
        |
        | explicit local correlation
        v
WebCodex Goal (durable intent/checkpoint)
        +
WebCodex Workflow Session (durable work/evidence)
```

A new thread never guesses which old work it belongs to. Adoption is explicit.

## Repository responsibilities

- **codex-chatgpt-web**: ChatGPT Web model transport, thread identity, browser compaction event, and the thin continuity client in this experiment.
- **WebCodex**: canonical Goal, Workflow Session, project/runtime authority, checkpoint revision fencing, handoff evidence, and execution truth.
- **chatgpt-continuity**: raw Web conversation evidence / DVR and conversation graph. This experiment does not duplicate that recorder inside WebCodex.

The long-term design should preserve these boundaries instead of merging all three stores into one state object.

## Configuration

Continuity is disabled unless all three variables are present:

```text
CODEX_CHATGPT_WEB_WEBCODEX_URL
CODEX_CHATGPT_WEB_WEBCODEX_TOKEN_FILE
CODEX_CHATGPT_WEB_WEBCODEX_PROJECT
```

The token itself is **not** accepted as an environment variable. `CODEX_CHATGPT_WEB_WEBCODEX_TOKEN_FILE` points to a local regular, non-symlink file containing exactly one token line. The token is read into the parent process only when the bridge is constructed.

The local correlation file lives under the isolated DEV runtime as:

```text
<DEV runtime>/webcodex-continuity.json
```

It stores only correlation metadata such as external thread id, project, `wc_goal_*`, `wc_sess_*`, Goal revision, and timestamps. It does not store the bearer token or the user's first prompt. Loading old experimental state reconstructs only the allowed fields, so an older `objective` field is dropped on the next write.

## Lifecycle

### First real message

Before opening the browser turn:

1. create/replay a WebCodex Goal with a stable idempotency key;
2. create a WebCodex Workflow Session with `work_on_project`;
3. explicitly associate the exact Goal and exact Session;
4. persist only their correlation to the current thread id.

Normal later messages reuse the existing binding and do not create another Goal/Session.

### Compaction

After the real DEV browser compaction returns canonical replacement history:

1. extract the actual readable compaction summary;
2. refresh the authoritative Goal revision with `get_goal`;
3. call `checkpoint_goal` with the exact revision fence and a stable idempotency key;
4. persist the new Goal revision.

The bridge never treats transport prose as the checkpoint body.

### Cross-thread recovery

Use a **fresh empty DEV thread** only.

`/recover-from PREVIOUS_THREAD_ID`:

1. explicitly adopts the previous thread's exact Goal/Session correlation;
2. reads `get_goal(goal_id)`;
3. reads `session_handoff_summary(session_id, project)`;
4. injects that deterministic recovery evidence as `codex_internal_context`;
5. keeps the new thread id as the new model-context identity.

No time proximity, project-name similarity, newest-session heuristic, window identity, or prompt similarity is used.

## DEV commands

```text
/continuity
/reset yes
/recover-from PREVIOUS_THREAD_ID
```

After `/reset yes`, the CLI prints the old thread id when durable work existed so the operator can explicitly adopt it.

## Failure semantics

The bridge intentionally does not retry post-dispatch effect calls after a lost response. Such a failure is reported as `outcome_unknown`; durable state must be reconciled before another effect is attempted.

This is especially important for `work_on_project`: a network failure after dispatch must never silently create a second Session.

Read-only recovery calls may fail normally and be retried by the caller.

## Dogfood acceptance

Do not promote this into the production Responses path until one live DEV run demonstrates all of the following:

1. First message creates exactly one Goal and one Workflow Session.
2. Several later messages keep the same IDs.
3. Real browser compaction advances the same Goal revision.
4. `/reset yes` destroys the local DEV history and creates a new thread id.
5. `/recover-from <old id>` on the empty new thread returns the **same** Goal and Session.
6. The next model turn can continue from Goal + handoff evidence without the old DEV history.
7. The local correlation file contains neither bearer token nor original user prompt.
8. A simulated post-dispatch connection loss fails closed as `outcome_unknown` and is not automatically replayed.
9. A recovery attempt on a non-empty thread or against another configured project is rejected.

Passing this proves the first claim only: **thread death no longer has to equal task-state death**. It does not yet prove production routing, automatic resume, or full long-horizon quality.
