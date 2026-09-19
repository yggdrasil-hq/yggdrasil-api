# Concept: organization readiness and the onboarding gate

**Read this when:** you touch `src/organizations/readiness.ts`, the onboarding
entry check, `POST /projects`'s gates, or a fresh signup reports a dead end.

## The problem this solves

A freshly signed-up user landed on the dashboard, saw **Create project**, filled in
the whole form, and only then got a `400` telling them to configure a Kubernetes
cluster (and possibly a default model) in Organization settings. Both prerequisites
are **org-level and configured elsewhere**, so the dashboard was offering an action
that could not possibly succeed (issue #35).

The only onboarding step before this was username confirmation
(`onboardingState === "pending_username"`), which says nothing about whether the
org can host a project.

## One definition of "ready"

`src/organizations/readiness.ts` holds it, and **both** the onboarding signal and
the create gate call it. That sharing is the point rather than tidiness: a readiness
predicate that differs from the gate is worse than none, because it promises a form
will work and then the request `400`s.

Readiness is exactly two org-level steps:

| Step id | Satisfied when | Fix path |
|---|---|---|
| `cluster` | `organizations.status === "ready"` — a kubeconfig has been submitted (ADR 016 item 11) | `/settings/organization/cluster` |
| `model_defaults` | **every** `AGENT_JOB_KINDS` entry resolves to a usable model (ADR 018 item 6a) | `/settings/organization/providers` |

`ready` is `steps.every(...)`, never computed separately, so a future step cannot be
added without the flag following it.

**Deliberately not steps:** the GitHub App installation and the repository selection
the create form also needs. Those are choices the caller makes *inside* the form, not
org-level prerequisites — including them would make the signal wrong in the other
direction, telling a user they are "not ready" for something they could satisfy right
there.

### The behaviour change to `POST /projects`

The model gate used to require a default for **`spec_grill` alone**. ADR 018 item 6a
requires all five kinds, so an org could create a project that then had its
`feature_build`/`test_run`/`agentic_review`/`design_grill` jobs fail at *run* time on
a missing model — the failure item 6a's gate exists to catch at creation instead.

**This tightens an existing endpoint**, so an org with four of five configured that
could create a project yesterday now gets a `400`. The message names the missing
kind(s) rather than the old blanket instruction, because "set a default model
configuration" is unhelpful to an admin who has set four of five, or whose default
stopped resolving.

**The escape hatch is preserved.** A request's own complete `modelConfig` bundle
satisfies the dimension outright, because ADR 018 item 5 keeps a project's
fully-custom connection deliberately and a project triplet resolves for every job
kind without consulting the kind at all. Requiring org coverage on top of a supplied
bundle would retire a documented, tested capability.

### An asymmetry worth knowing

The **endpoint** answers "does the *org* provide this?" — a property of the org, and
the only thing a client deciding whether to show the dashboard can know. The **gate**
additionally accepts a bundle from the request it is handling. So readiness is
*stricter* than the gate, which is the safe direction: it can withhold entry from a
request that would have succeeded, but it can never promise one that then fails.

## The endpoint

`GET /organizations/readiness` — user-scoped, no `:organizationId`, because the
client's question is about the user's whole membership. Registered **before**
`/:organizationId` (as `/roles` is), or Express would match `/readiness` as an org id
and 404 on the UUID check.

```jsonc
{
  "entryAllowed": true,
  "readyOrganizationId": "2222…",   // null when none is ready
  "organizations": [
    {
      "id": "2222…",
      "name": "Sarat's workspace",
      "isPersonal": true,
      "role": "admin",
      "ready": true,
      "steps": [
        {
          "id": "cluster",
          "label": "Kubernetes cluster",
          "satisfied": true,
          "detail": null,            // a sentence when unsatisfied
          "requiresAdmin": true,
          "fixPath": "/settings/organization/cluster"   // app-relative
        },
        {
          "id": "model_defaults",
          "label": "Default models",
          "satisfied": false,
          "detail": "no default model for Design grill",
          "requiresAdmin": true,
          "fixPath": "/settings/organization/providers",
          "missingModelKinds": ["design_grill"],
          "kindsWithoutDefault": ["design_grill"],
          "kindsThatDoNotResolve": []
        }
      ]
    }
  ]
}
```

**`fixPath` is app-relative** (no `/app` prefix), matching how notifications already
carry `linkPath`. The Web app adds its own base.

**`kindsWithoutDefault` and `kindsThatDoNotResolve` are separate** because the remedy
differs: one is "assign a model", the other is "your default is broken". Collapsing
them would send an admin to a form that already looks filled in.

**`requiresAdmin` is on the step**, not inferred by the client, so the issue's
non-dead-end requirement is answerable from the payload: a member of an org they
cannot administer sees *why* it is blocked and that someone else must act, rather
than an unactionable form.

### Whose readiness gates the entry screen

**Any org, not the personal one** — `entryAllowed` is true when **at least one** org
the user belongs to is ready. An invitee who joins an existing ready org has a
perfectly good org to work in, and gating on their *personal* org (which nobody
configured, because they were invited elsewhere) would block them from the whole app
for a reason they may not be able to fix. That is precisely the trap the issue says
must not exist.

So entry is blocked only when **no** org is ready, which is the situation where every
"Create project" they could press would fail. `readyOrganizationId` is emitted so the
client does not re-implement the rule.

## Why not extend `/auth/me`

`/auth/me` is the session bootstrap every page load hits. Readiness costs a defaults
read plus one model resolution per org, and it is only meaningful at the entry gate,
so it is only asked there.

## Verification

- `src/organizations/readiness.test.ts` — the predicate, including that `ready` is
  derived from the steps and that a joined ready org permits entry over an
  unconfigured personal one.
- `scripts/verify/issue-35-readiness.mts` — the same predicate against a **real**
  PostgreSQL, because the composition is new even though each query is not: an org
  with all five kinds is ready, removing one from the real table makes it not ready,
  an in-use catalog model is protected from deletion (ADR 018 item 4), and a default
  pointing outside the org's catalog reads as unresolvable rather than unset.
