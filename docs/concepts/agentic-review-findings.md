# Concept: the Agentic Review read and its findings (issue #73)

**Read this when:** you touch `src/features/review-types.ts`, the `submit_review`
event, `job_events.review_findings`, or a panel reports "no blocking issues" over a
review that requested changes.

## The two shapes, and why there are two

A review's findings reach the API in one of two forms, and the distinction is the
whole point of this feature:

| Producer | Where the findings are | `reviewFindings` | Countable? |
|---|---|---|---|
| prose (the default, and every review before #73) | the free-text `comment` → stored in `summary` | `null` | **no** |
| structured (per-location) | the `findings` array on `submit_review` | a jsonb array | yes |

**`null` and `[]` are different answers to "how many blocking issues".**

- `null` — nothing structured was recorded. Either the review predates the column,
  or the reviewer wrote a paragraph. A count is **not knowable**, and a client that
  renders "0 blocking issues" from this is asserting something false about a
  `changes_requested` verdict. That is the defect #73 exists to fix.
- `[]` — findings were recorded and there were none. The only state in which "0
  blocking issues" is a true statement.

The read shape therefore carries **`findingsRecorded`** alongside `comments`, so a
client never has to infer which case it is looking at from an empty array. The Web
app's `reviewDetail` already branches on exactly this distinction (`structured` /
`prose` / `none`) and its `blockingLabelFor` returns `null` — dropping the phrase —
when the count is unknowable.

## Why not drop the structure instead

The alternative reading of #73 is "the producer emits prose, so delete the
misleading `comments` array". That was rejected because the shape already exists on
**both** sides and only the producer was missing:

- the read contract's `comments` (issue #59), and
- the Web app's `findings` / `AgenticReviewFinding`, which its mapper already fills
  from `comments` via `findingFromComment`.

So the cost of giving the producer a structured field is one optional array on the
tool and a jsonb column; the cost of deleting the structure is removing two
existing shapes and making per-location findings permanently impossible. Per-location
findings are the thing that lets a reviewer see *where* the problems are without
reading an essay — and `changes_requested` is exactly when a human must act.

## The wire contract

`submit_review` gains an **optional** `findings` array:

```jsonc
{
  "type": "submit_review",
  "verdict": "changes_requested",
  "comment": "Three things to fix.",
  "findings": [
    { "path": "src/auth.ts", "line": 42, "body": "Token refresh is missing.", "blocking": true },
    { "body": "Overall shape is fine.", "blocking": false }
  ]
}
```

- **`path` and `line` are optional** because a finding may name a file without a
  line, or neither — and "no location" is a legitimate remark about the change as a
  whole, which is a different thing from a missing finding. The read contract types
  them the same way.
- **`blocking` defaults to `true`.** An omitted flag means "these are the blockers",
  not "none of these matter" — defaulting to `false` would let a review pass its gate
  while displaying exactly the findings that should stop it. Applied at ingest so a
  client never has to decide what an absent flag means, matching
  `findingFromComment`'s own default.
- **`findings` omitted ⇒ `null`** (prose), **`findings: []` ⇒ `[]`** (structured,
  none found). The route never defaults to `[]`.
- **Bounds**: at most 50 findings, `body` ≤ 4000 chars, `path` ≤ 512. A review with
  more than 50 findings is a runaway rather than a review, and an unbounded `body`
  would let one row carry a megabyte into every transcript read.

The response shape is unchanged except for `findingsRecorded` and a now-populated
`comments`:

```jsonc
{
  "verdict": "changes_requested",
  "summary": "Three things to fix.",
  "comments": [{ "path": "src/auth.ts", "line": 42, "body": "…", "blocking": true }],
  "findingsRecorded": true,
  "jobId": "…",
  "completedAt": "…"
}
```

## Storage

`job_events.review_findings` (jsonb, migration 053), following `action_items` and
`design_snapshot` on the same table. Migration 053 also adds a CHECK so the column
cannot acquire a second meaning:

```sql
CHECK (review_findings IS NULL OR (type = 'submit_review' AND jsonb_typeof(review_findings) = 'array'))
```

`NULL` for every pre-#73 row is what makes the constraint addable with no backfill.

**One trap this column exposed, worth knowing before you add another jsonb column
here.** `node-postgres` serialises a JS **array** as a Postgres array literal, not
as JSON — so a JS array passed straight to a jsonb parameter fails at the server
with `invalid input syntax for type json`. `actionItems` had that bug from the day
it was added and could never be written (filed as #86); it was invisible because
every real-database test wrote an *object* (`questionForm`), which serialises
acceptably. Array-valued jsonb parameters are now `JSON.stringify`-ed explicitly in
`JobEventRepository.create`, and a real-database case covers the array path.

## The producer is not in this repo

The API accepts and stores `findings`; the **producer** is the `agentic_review`
skill and the `submit_review` tool, both in `agent-images/`. Until that lands the
column stays `null` for every review and `findingsRecorded` is always `false` — which
is *honest* (a count is not claimed) but means the UI still cannot show blockers
per-location. The required change is specified on issue #73.

## Verification

- `src/features/review-types.test.ts` — the null/`[]` distinction, `findingsRecorded`
  for both, and the projection onto `comments`.
- `src/jobs/internal-routes.test.ts` — ingest: the `blocking ?? true` default, omitted
  ⇒ `null` versus explicit `[]`, and a malformed finding refused.
- `src/jobs/events-repository.postgres.test.ts` — the jsonb **array** round trip
  against a real database, which is what exposed #86.
- `scripts/verify/issue-73-review-findings.mts` — the full path on real Postgres:
  the round trip through the read mapper, `null` vs `[]` end to end, the CHECK
  constraint live (non-array refused, non-review event refused), and that existing
  rows keep NULL so the migration needs no backfill.
