# Live relay limits (API)

**Read this when:** you touch `src/live/`, change the delta ingest in
`src/jobs/internal-routes.ts`, or an install reports that live updates stopped.
**Skip if:** you only need the relay's wire protocol — that is ADR 019 in the meta
repo (`../../../docs/adr/019-live-event-relay.md`).

> ADR 019 follow-up 4, implemented as issue #24. This page records the **API-owned
> implementation notes**: which limits exist, why the two of them fail differently,
> and what to turn when one fires.

## Why the relay needs limits at all

There is no rate limiting anywhere else in this API. The relay is different for
two reasons the general gap does not cover:

- it is the first surface where a **client can influence frame volume
  indirectly, through a third party** — the model's token rate — so a user's
  connection cost is not fully their own doing;
- it is the first **long-lived connection**, which changes the economics of an
  abusive client: a request is bounded, a socket is not.

## The two limits, and why they fail differently

| | Per socket | Per job |
|---|---|---|
| Where | `src/live/limits.ts`, consulted in `connection.send` | `JobRepository.recordRelayedDeltaBytes`, checked in `publishDelta` |
| Bounds | frames emitted to one socket | total delta text bytes one job relays |
| Exceeding it | **closes that socket** (code `4429`) | **stops relaying that job's deltas** |
| Blames | the connection | the producer |
| Config | `LIVE_FRAMES_PER_SECOND`, `LIVE_FRAME_BURST` | `LIVE_DELTA_BYTES_PER_JOB` |

They are deliberately not the same failure mode, because the two conditions have
different causes and different victims.

**The per-socket budget closes the socket.** Dropping frames instead was
considered and rejected: dropping is silent (the server still fans out and then
discards, so it bounds the send cost but not the work) and it renders a
transcript with holes in it. Closing is safe *because the relay is an accelerator
over the REST read* — the Web app's poll is a complete state path, so a closed
socket costs **immediacy, never content**. It is also visible, which a drop is
not. `FrameBudget`'s doc comment carries the full argument.

**The per-job ceiling does not close anything.** A runaway is the *producer's*
problem. Subscribers did nothing, and evicting them from live updates for a job
they are not running would punish the wrong party — and failing the job would be
worse still: the relay is an accelerator, not a control plane. Stopping that job's
deltas loses nothing either, for the same reason: the authoritative `agent_text`
still arrives over the stored-event path, so the bubble ends up correct and merely
arrives later.

## Why the per-job counter is a database column

`jobs.delta_bytes` (migration 045) rather than an in-process map:

1. the delta ingest runs on whichever replica nginx routed the POST to, and every
   replica can write deltas for the same job — an in-process counter would allow
   *N ×* the ceiling with *N* replicas;
2. a per-job in-memory map needs an eviction policy, because nothing tells the
   API that a job finished — so the bound on the runaway would itself grow
   without bound;
3. it is diagnosable: "this job relayed 6.2 MB of deltas" is what an operator
   needs to confirm a runaway, and a counter in a process's heap cannot answer it.

It costs **no extra round trip**. The ingest already read the job row once per
delta (`findById`, to resolve which feature the text belongs to);
`recordRelayedDeltaBytes` replaces that read with one atomic
`UPDATE … RETURNING` that resolves the feature *and* advances the counter.

## Client compatibility, stated precisely

The close code is `4429` (`LIVE_CLOSE_RATE_LIMITED`). The correct client response
is **to stop retrying and fall back to polling**, exactly as for 4401 and 4400.

`web/lib/features/live-relay.ts` currently recognises only 4401 and 4400 as
do-not-retry and treats every other code as retryable. Until the Web app learns
4429, the interim behaviour is its bounded reconnect — ten attempts with 1s→30s
backoff, then it stays on the poll. That is degraded but never wrong: it always
ends in the complete REST state path and cannot loop forever. Filed as a Web
follow-up rather than papered over here.

## What these limits do not bound

A socket that reconnects gets a fresh bucket, so the per-socket budget bounds what
one **connection** costs, not what one **user** costs. Bounding a user needs a
connection-count limit (many sockets, each within budget) with cross-replica
bookkeeping *and* liveness detection for a socket whose peer vanished without a
FIN — otherwise a laptop that slept locks its owner out of live updates with no
recourse. That is a different resource and a larger piece of work, filed
separately rather than half-built here.

## Turning a limit that fired wrongly

The limits are configurable precisely so this needs no code change. Raise
`LIVE_FRAMES_PER_SECOND` / `LIVE_FRAME_BURST` if a legitimate workload is refused,
and `LIVE_DELTA_BYTES_PER_JOB` if a genuinely long narration is truncated
(`0` disables it). Both a socket close and a ceiling crossing are logged with the
limit that was enforced, so the log line says which knob to turn.

All three are floored: a value of `0`, a negative, or an unparseable one clamps to
the smallest usable setting rather than to zero. A guard that a bad env var can
turn into "close every socket" or "disable the limit" would be worse than no guard,
so the clamps are asserted in `limits.test.ts`.
