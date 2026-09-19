import {
  AGENT_JOB_KINDS,
  type AgentJobKind,
} from "../model-config/types.js";
import type { JobModelDefaultRepository } from "../model-config/job-default-repository.js";
import type { OrgProviderRepository } from "../model-config/provider-repository.js";
import type { OrgModelRepository } from "../model-config/model-repository.js";
import { resolveOrgModelConfig } from "../secrets/model-config.js";
import type { OrgRole, Organization } from "./types.js";
import type { OrganizationRepository } from "./repository.js";

/**
 * Issue #35: **the single definition of "this organization is ready"**, shared by
 * the create-project gate and the onboarding entry check.
 *
 * **Why this module exists at all.** Before it, "ready" was two different things
 * in two places, and the weaker one was user-facing:
 *
 * - the create gate (`projects/routes.ts`) required the org's cluster status to be
 *   `ready` **and** a default model for `spec_grill` alone;
 * - ADR 018 item 6a requires cluster status `ready` **and** a default for all five
 *   agent-driven job kinds, because a project that is created without the other
 *   four gets built and then has its jobs fail at *run* time on a missing model —
 *   a failure the ADR's gate exists to catch at creation instead.
 *
 * So the gate was weaker than the decision it implements, and any readiness signal
 * written against the gate would have inherited that. A readiness predicate that
 * differs from the gate is worse than none: it promises a form will work and then
 * the request 400s. Both now call `evaluateOrgReadiness`.
 *
 * **What "ready" means, exactly two org-level things.** The issue lists them and
 * nothing else:
 *
 * 1. `cluster` — a Kubernetes cluster is configured. This is the org's `status`
 *    (`pending_cluster` → `ready`), set by `PUT /organizations/:id/cluster` and
 *    cleared by `DELETE` of it. ADR 016 item 11's gate.
 * 2. `model_defaults` — every `AGENT_JOB_KINDS` entry resolves to a usable model
 *    configuration. ADR 018 item 6a's gate.
 *
 * Deliberately **not** included: the GitHub App installation and the repository
 * selection the create form also needs. Those are per-*request* choices the caller
 * makes inside the form, not org-level prerequisites configured elsewhere — which
 * is the specific defect this issue is about. Including them here would make the
 * signal wrong in the other direction: it would tell a user they are "not ready"
 * for a reason they could satisfy right there on the form.
 *
 * **`ready` is derived from the steps, never computed separately.** There is
 * exactly one place that decides it (`steps.every(...)`), so a future step cannot
 * be added without the flag following it. That is the property that keeps this
 * from drifting the way the two previous definitions did.
 */

/**
 * How a job kind is named to a user, for the API's own messages.
 *
 * Mirrors `web/lib/features/types.ts`'s `AGENT_JOB_KIND_LABELS`. The duplication
 * is deliberate and narrow: the create gate's 400 message is authored *here*, so
 * this module needs the words regardless of what any client does, and a non-Web
 * consumer (a `curl`, the Docusaurus reference) has no other source for them. The
 * Web app should keep using its own map plus `missingModelKinds` rather than
 * parsing these strings — the raw kinds are in the payload for exactly that
 * reason.
 */
const JOB_KIND_LABELS: Record<AgentJobKind, string> = {
  spec_grill: "Spec grill",
  feature_build: "Feature build",
  test_run: "Tests",
  agentic_review: "Agentic review",
  design_grill: "Design grill",
};

/** The two org-level prerequisites. Ids are stable — a client may branch on them. */
export type OrgReadinessStepId = "cluster" | "model_defaults";

export interface OrgReadinessStep {
  id: OrgReadinessStepId;
  /** Short heading for the step, safe to render as-is. */
  label: string;
  satisfied: boolean;
  /**
   * What is missing, in a sentence, or null when satisfied.
   *
   * Written for the person reading it rather than for a log: it names the thing to
   * fix and, when a default is set but does not resolve, says *that* rather than
   * "no default" — those need different actions from the admin.
   */
  detail: string | null;
  /**
   * Whether changing this needs org-admin rights.
   *
   * True for both current steps: cluster writes are admin-only (ADR 016 item 12)
   * and provider/model/default writes are admin-only (ADR 018 item 7). It is on
   * the step rather than left to the client so the "you cannot fix this yourself"
   * case is answerable from the payload alone — the issue's requirement that a
   * non-admin is not sent to an unactionable form.
   */
  requiresAdmin: boolean;
  /**
   * Where to fix it, as an **app-relative** path, matching how notifications
   * already carry `linkPath` (`projects/overview.ts`). The Web app adds its
   * `/app` base itself. Null when there is nothing to link to.
   */
  fixPath: string | null;
  /** Only set for `model_defaults`: the kinds that are not covered, and why. */
  missingModelKinds?: AgentJobKind[];
  /** Only set for `model_defaults`: kinds with *no* default row, versus one that does not resolve. */
  kindsWithoutDefault?: AgentJobKind[];
  kindsThatDoNotResolve?: AgentJobKind[];
}

export interface OrgReadiness {
  id: string;
  name: string;
  isPersonal: boolean;
  /** The caller's role, so the client can tell "you can fix this" from "ask someone". */
  role: OrgRole;
  ready: boolean;
  steps: OrgReadinessStep[];
}

export interface ReadinessResponse {
  /**
   * Whether the caller should be let past onboarding.
   *
   * True when **at least one** org they belong to is ready. See `evaluateEntryReadiness`
   * for why that is the rule rather than "their personal org".
   */
  entryAllowed: boolean;
  /**
   * The org that satisfies entry, or null when none does.
   *
   * Emitted so the client does not have to re-implement the rule above; if it ever
   * changes, it changes here.
   */
  readyOrganizationId: string | null;
  /** Every org the caller belongs to, with its own readiness. */
  organizations: OrgReadiness[];
}

/** The repositories readiness needs — narrow on purpose, so callers pass only these. */
export interface ReadinessDeps {
  organizations: OrganizationRepository;
  jobDefaults: JobModelDefaultRepository;
  providers: OrgProviderRepository;
  models: OrgModelRepository;
}

export interface OrgModelCoverage {
  /** Kinds whose default resolves to a usable bundle. */
  covered: AgentJobKind[];
  /** Every kind not covered: `kindsWithoutDefault` + `kindsThatDoNotResolve`. */
  missing: AgentJobKind[];
  /** No default row at all — the admin has not assigned one. */
  kindsWithoutDefault: AgentJobKind[];
  /**
   * A default row exists but does not resolve — its catalog model or provider was
   * removed, or the provider's key is unreadable.
   *
   * Kept separate from `kindsWithoutDefault` because the remedy differs: one is
   * "assign a model", the other is "your default is broken". Collapsing them would
   * send an admin to a form that already looks filled in.
   */
  kindsThatDoNotResolve: AgentJobKind[];
}

/**
 * Whether every agent job kind has a resolvable org default (ADR 018 item 6a).
 *
 * **One query for the defaults, one resolution per *distinct* model.** An org that
 * points all five kinds at the same catalog model — the common case, and this
 * install's own state — therefore costs one resolution rather than five, while the
 * per-kind answer is still exact. A naive per-kind loop would be five identical
 * model+provider lookups, which for a user in several orgs multiplies into a read
 * that is slow for no reason.
 */
export async function evaluateModelCoverage(
  deps: Pick<ReadinessDeps, "jobDefaults" | "providers" | "models">,
  organizationId: string,
): Promise<OrgModelCoverage> {
  const defaults = await deps.jobDefaults.listForOrganization(organizationId);
  const modelIdByKind = new Map(defaults.map((row) => [row.jobKind, row.modelId]));

  const resolvableByModelId = new Map<string, boolean>();
  const covered: AgentJobKind[] = [];
  const kindsWithoutDefault: AgentJobKind[] = [];
  const kindsThatDoNotResolve: AgentJobKind[] = [];

  for (const kind of AGENT_JOB_KINDS) {
    const modelId = modelIdByKind.get(kind);
    if (!modelId) {
      kindsWithoutDefault.push(kind);
      continue;
    }

    let resolves = resolvableByModelId.get(modelId);
    if (resolves === undefined) {
      resolves = (await resolveOrgModelConfig(deps, organizationId, modelId)) !== null;
      resolvableByModelId.set(modelId, resolves);
    }

    if (resolves) covered.push(kind);
    else kindsThatDoNotResolve.push(kind);
  }

  return {
    covered,
    missing: [...kindsWithoutDefault, ...kindsThatDoNotResolve],
    kindsWithoutDefault,
    kindsThatDoNotResolve,
  };
}

/** A sentence naming the kinds that are not covered, for the step detail and the 400. */
export function describeMissingModelKinds(coverage: OrgModelCoverage): string {
  const names = (kinds: AgentJobKind[]) => kinds.map((kind) => JOB_KIND_LABELS[kind]).join(", ");

  if (coverage.kindsWithoutDefault.length === 0 && coverage.kindsThatDoNotResolve.length === 0) {
    return "Every agent job kind has a default model.";
  }

  const parts: string[] = [];
  if (coverage.kindsWithoutDefault.length > 0) {
    parts.push(`no default model for ${names(coverage.kindsWithoutDefault)}`);
  }
  if (coverage.kindsThatDoNotResolve.length > 0) {
    // Deliberately not phrased as "no default": a row *is* set, and telling an
    // admin otherwise sends them to fill in a field that already has a value.
    parts.push(
      `a default that no longer resolves for ${names(coverage.kindsThatDoNotResolve)} ` +
        "(its catalog model or provider was removed)",
    );
  }
  return parts.join("; and ");
}

/**
 * One org's readiness. `ready` is `steps.every(...)`, so it cannot disagree with
 * the steps a client renders.
 *
 * **On the asymmetry with the create gate.** The gate additionally accepts a
 * request's own complete model bundle as satisfying `model_defaults`, because
 * ADR 018 item 5 keeps a project's fully-custom connection as a deliberate escape
 * hatch — and a project triplet resolves for **every** job kind without consulting
 * the kind at all (`resolveModelConfigForJobWithSource` returns the project tier's
 * bundle directly). Requiring org coverage on top of it would retire a documented,
 * tested capability rather than implement ADR 018.
 *
 * So this endpoint answers "does the **org** provide this?" — a property of the
 * org, and the only thing a client deciding whether to show the dashboard can know
 * — while the gate also accepts a bundle supplied by the request it is handling.
 * The resulting asymmetry is in the safe direction: readiness can withhold entry
 * from a request that would have succeeded, but it can never promise one that then
 * 400s, which is the failure this issue is about.
 */
export async function evaluateOrgReadiness(
  deps: ReadinessDeps,
  org: Pick<Organization, "id" | "name" | "isPersonal" | "status">,
  role: OrgRole,
): Promise<OrgReadiness> {
  const clusterSatisfied = org.status === "ready";

  const coverage = await evaluateModelCoverage(deps, org.id);
  const modelsSatisfied = coverage.missing.length === 0;

  const steps: OrgReadinessStep[] = [
    {
      id: "cluster",
      label: "Kubernetes cluster",
      satisfied: clusterSatisfied,
      detail: clusterSatisfied
        ? null
        : "No Kubernetes cluster is configured for this organization, so no project can deploy or run a job.",
      requiresAdmin: true,
      fixPath: "/settings/organization/cluster",
    },
    {
      id: "model_defaults",
      label: "Default models",
      satisfied: modelsSatisfied,
      detail: modelsSatisfied ? null : describeMissingModelKinds(coverage),
      requiresAdmin: true,
      fixPath: "/settings/organization/providers",
      missingModelKinds: coverage.missing,
      kindsWithoutDefault: coverage.kindsWithoutDefault,
      kindsThatDoNotResolve: coverage.kindsThatDoNotResolve,
    },
  ];

  return {
    id: org.id,
    name: org.name,
    isPersonal: org.isPersonal,
    role,
    ready: steps.every((step) => step.satisfied),
    steps,
  };
}

/**
 * The onboarding entry answer for a user, across every org they belong to.
 *
 * **Whose readiness gates the screen: any org, not the personal one.** The issue
 * says to scope the *configuration flow* to the personal org (only an org you
 * administer is one you can set up) and leaves the entry rule to be decided. The
 * rule chosen here is `some(ready)`, and the reason is the issue's own non-dead-end
 * requirement:
 *
 * an invitee who joins an existing ready org has a perfectly good org to work in.
 * Gating on their *personal* org — which nobody has configured, because they were
 * invited somewhere else and never opened onboarding for it — would block them from
 * the whole app for a reason they may not even be able to fix. That is exactly the
 * trap the issue says must not exist.
 *
 * So: entry is blocked only when **no** org the user belongs to is ready, which is
 * the situation where every "Create project" they could press would fail. The
 * checklist is then scoped to the personal org (the common case: it exists, and
 * they administer it), and the client can identify it via `isPersonal`.
 */
export async function evaluateEntryReadiness(
  deps: ReadinessDeps,
  userId: string,
): Promise<ReadinessResponse> {
  const orgs = await deps.organizations.listForUser(userId);

  const evaluated = await Promise.all(
    orgs.map(async (org) => {
      const role = await deps.organizations.roleForUser(org.id, userId);
      return role ? evaluateOrgReadiness(deps, org, role) : null;
    }),
  );

  // `listForUser` joins memberships, so a null role means the membership was
  // removed between the two reads. Dropping the org is right: it is no longer one
  // the user can act in, and reporting it would offer a fix path they cannot open.
  const organizations = evaluated.filter((entry): entry is OrgReadiness => entry !== null);

  // Personal first, matching `listForUser`'s own ordering, so a client rendering
  // the list in order shows the org a fresh signup should configure at the top.
  const ready = organizations.find((entry) => entry.ready) ?? null;

  return {
    entryAllowed: ready !== null,
    readyOrganizationId: ready?.id ?? null,
    organizations,
  };
}
