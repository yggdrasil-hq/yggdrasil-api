# API docs — index

Agent + developer docs for this repo. Start from [`../CLAUDE.md`](../CLAUDE.md).
Suite-wide docs live in the meta repo's `../../docs/`.

Every doc opens with a `**Read this when:**` line — use it to decide relevance
before reading the body.

## overview/
| Doc | Read this when |
|-----|----------------|
| [`overview/architecture.md`](overview/architecture.md) | You need how this component is structured internally. |
| [`overview/setup.md`](overview/setup.md) | You're setting up local dev. |

## concepts/
| Doc | Read this when |
|-----|----------------|
| [`concepts/authentication.md`](concepts/authentication.md) | Auth routes, sessions, OAuth, migrations. |
| [`concepts/onboarding-readiness.md`](concepts/onboarding-readiness.md) | You touch the onboarding entry gate, `POST /projects`'s org gates, or a fresh signup reports a dead end. |
| [`concepts/agentic-review-findings.md`](concepts/agentic-review-findings.md) | You touch the Agentic Review read, `submit_review`, `job_events.review_findings`, or a panel reports "no blocking issues" over a review that requested changes. |
| [`concepts/live-relay-limits.md`](concepts/live-relay-limits.md) | You touch `src/live/`, the delta ingest, or an install reports live updates stopped. |
| [`concepts/run-artifacts.md`](concepts/run-artifacts.md) | You touch recordings/screenshots, a job's `recordingPath`/`screenshotPath`, or an artifact looks missing or broken. |

## conventions/
| Doc | Read this when |
|-----|----------------|
| [`conventions/conventions.md`](conventions/conventions.md) | Conventions specific to this repo (defer to meta repo for shared ones). |
| [`conventions/testing.md`](conventions/testing.md) | You run this repo's tests, a case skipped, or a change needs verifying against a real database. |

> Follow `../../docs/conventions/documentation-guide.md` when adding docs.
