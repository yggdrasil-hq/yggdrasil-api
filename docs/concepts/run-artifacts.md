# Run artifacts: recordings and screenshots (API)

**Read this when:** you touch `src/recordings/`, `src/screenshots/`, a job's
`recordingPath` / `screenshotPath`, or an install reports a missing or broken
test-run artifact.
**Skip if:** you only need the *why* — that is ADR 029 in the meta repo
(`../../../docs/adr/029-test-run-screen-recording.md`), which this page
implements and issue #22 extends.

## The defect both families share

An agent reports a `recordingPath` (once per run) and a `screenshotPath` (once
per `report_test_step`) that point **inside the job pod**, and the pod is deleted
the moment the run ends. So both values were, for their whole existence, pointers
to files that no longer existed. Nothing read the bytes, so nothing noticed — and
the fields became a trap for whoever tried to use them next.

ADR 029 fixed that for recordings. Issue #22 fixed the identical defect for
screenshots, which had had it since it was written.

The `..._path` columns are **kept** and still hold the in-pod path. They are
provenance — "where the agent said it put this" — and they are deliberately never
resolved. The bytes live in their own tables, addressed by job id.

## Two tables, not one — and why

`job_recordings` (one row per job) and `job_screenshots` (one row per job **and
step**). Issue #22 asks whether they should share storage and retention; the
answer is two tables, with the *rules* shared and the *policy* independent.

| | Recordings | Screenshots |
|---|---|---|
| Cardinality | at most one per job | one per reported step |
| Arrival | once, after the session ends | with each `report_test_step` |
| Typical size | tens of MB | a few hundred kB |
| Upsert key | `job_id` | `(job_id, step_name)` |
| Config | `RECORDING_*` | `SCREENSHOT_*` |

Four reasons, the first of which decides it:

1. **A single recording row cannot hold N images without an array or a JSON
   blob, and that destroys the per-artifact tombstone** ADR 029 item 6 depends on:
   "this artifact existed and was reclaimed" must stay distinguishable from "it
   was never captured", and a purged element inside an array cannot say that as
   cleanly as a row can.
2. **One `byte_size` cap cannot serve both.** 25 MB is right for video and
   absurd for a screenshot; a few hundred kB is right for a screenshot and
   useless for video.
3. **They arrive differently.** One is a single post at job end; the other is
   interleaved with the event stream, one per step. Separate tables let each
   upsert on its own natural key without contending on one row.
4. **Independent retention.** Both annotate the same run and are useful for the
   same window, so the defaults agree (30 days). But screenshots are three orders
   of magnitude smaller, so a project may reasonably keep them longer than the
   video — separate tables make that a config value rather than a migration.

## One implementation of the retention rules

`src/shared/artifacts.ts` holds the generic rules — the three states, the expiry
boundary, the size cap, the human-readable sizes — and both families use it.
That is deliberate rather than tidy-minded: retention has two places where a
silent off-by-one is expensive and invisible.

- **The expiry boundary.** The sweeper's SQL and the read path's state function
  must agree on the exact instant an artifact stops being available. If they
  disagree, an artifact is either a clickable link that 404s or bytes that are
  never reclaimed.
- **The size cap.** `>` versus `>=` decides whether the configured number means
  what its comment says.

Two copies of that are two chances for a purge and a read to disagree, so there
is one. `recordings/retention.ts` re-exports the shared functions under its own
names, which is why its tests kept passing unchanged through the extraction.

**The read path is the authority in the window before the next sweep.** An
artifact past its expiry is `expired` and answers 410 even while its bytes are
still present, so retention is not a lie for the length of a sweep interval.

## Screenshots: the format whitelist is a security boundary

Accepted: `image/png`, `image/jpeg`, `image/webp` — and deliberately **not SVG**.

An SVG is a *document*, not a bitmap: it can contain `<script>` and event
handlers. These bytes are served inline from the API's own origin behind a
session cookie, so accepting one would be **stored XSS against every member of
the project**. The whitelist is enforced in three places that must agree — the
route's `express.raw` type filter, `rejectScreenshotUpload`, and the table's
`CHECK` constraint — because the constraint has to hold even if a future code
path forgets the other two. It is not env-configurable, because it is a boundary
and not a knob.

The content read additionally sets `X-Content-Type-Options: nosniff`, so a
browser cannot re-decide that image bytes are something executable.

## Both are bounded, per file *and* per run

Recordings are bounded by `RECORDING_MAX_BYTES` (one artifact per job, so that is
a per-run bound too). Screenshots need two numbers, and the second is not implied
by the first: `SCREENSHOT_MAX_BYTES` bounds one file while
`SCREENSHOT_MAX_PER_JOB` bounds a run, because how many steps there are is
decided by the `##` headings in the project's own test markdown. A spec with
thousands of headings would otherwise be thousands of files. Bounded per file is
not bounded per run.

`countForJob` counts **tombstones too**, so a job that once had its full quota and
had it reclaimed does not silently get a fresh one.

A refusal is never fatal: every rejection answers `202` with a reason, including
the body parser's own `413` (which `express.raw` raises *before* the handler
runs, which is why both upload routes carry an error middleware that converts it
— otherwise the one case that most needs "never fail the run" would be the one
that breaks it). ADR 029 item 5: an artifact must never fail the test run that
produced it.

## Where the bytes are served from

From **this API, behind the ordinary session cookie** — never from a public URL,
and not from object storage. A recording is a film of a real session; a screenshot
is a still from one. Both can contain real customer data on screen and real
credentials as they are typed into a form. The authorization is exactly the
project-access check every other project read uses.

This is a deliberate contrast with ADR 003 §15's preview deployments, which are
public *by decision* (issue #20): a preview is the project's own application at a
URL the team is meant to share, whereas an artifact of a test session is evidence
about a run.

Statuses are chosen so a client cannot render the wrong thing:

| Status | Means |
|---|---|
| `404` | no such artifact, or it belongs to a project you cannot read |
| `410 Gone` | the artifact existed and retention reclaimed it |
| `202` (upload) | stored nothing, with a reason — never a failed run |

410 rather than 404 for a reclaimed artifact is the whole reason rows are
tombstoned: a client that conflates the two renders an expired artifact as a
broken image with no explanation.

## Bytes in Postgres, for now

Both families store bytes in `BYTEA`. That is a deliberate, constrained choice
rather than the intended end state: **no S3 client exists in this codebase** (the
`S3_*` variables the Compose service receives are read by nothing). The move to
object storage is issue #30, and it is a swap of two methods per class —
`upsert`'s payload and `findContent` — because everything else in both features
reads metadata only.
