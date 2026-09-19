import { describe, expect, it, vi } from "vitest";
import {
  describeMissingModelKinds,
  evaluateEntryReadiness,
  evaluateModelCoverage,
  evaluateOrgReadiness,
  type ReadinessDeps,
} from "./readiness.js";
import { AGENT_JOB_KINDS, type AgentJobKind } from "../model-config/types.js";
import type { OrgRole, Organization } from "./types.js";

/**
 * Issue #35's predicate. The tests are written against **what readiness should
 * mean**, not against what the first implementation happened to return — a
 * readiness signal that merely snapshots the create gate is the defect this issue
 * is about, so several of these assert a property the old gate would have failed.
 */

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "11111111-1111-4111-8111-111111111111";

function org(overrides: Partial<Organization> = {}): Organization {
  return {
    id: ORG_ID,
    name: "Acme Retail",
    slug: "acme-retail",
    description: "",
    isPersonal: true,
    status: "ready",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function defaultRow(jobKind: AgentJobKind, modelId = "model_1") {
  return {
    organizationId: ORG_ID,
    jobKind,
    modelId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * A deps stand-in whose org config is **complete and resolvable by default**, so a
 * test varies only the one thing it is about. `resolveOrgModelConfig` needs a model
 * row whose provider decrypts; both are driven by flags here rather than by
 * removing rows, because "the model row is gone" and "the key is gone" are
 * different failures the code distinguishes.
 */
function fakeDeps(options: {
  jobDefaults?: ReturnType<typeof defaultRow>[];
  catalogModelExists?: boolean;
  providerKeyReadable?: boolean;
  providerExists?: boolean;
  /** orgs `listForUser` returns; defaults to the one org above. */
  orgs?: Organization[];
  /** The caller's role; a per-org map lets a test vary it per org. */
  roles?: Record<string, OrgRole | null>;
} = {}) {
  const provider = { id: "provider_1", organizationId: ORG_ID, baseUrl: "https://p.test/v1" };
  const model = { id: "model_1", organizationId: ORG_ID, providerId: "provider_1", modelId: "gpt-4.1" };

  const orgs = options.orgs ?? [org()];
  const providerDeps = {
    findById: vi.fn(async () => (options.providerExists === false ? null : provider)),
    decryptApiKey: vi.fn(async () => (options.providerKeyReadable === false ? null : "sk-live")),
  };
  const modelDeps = {
    findById: vi.fn(async () => (options.catalogModelExists === false ? null : model)),
  };
  const jobDefaults = {
    listForOrganization: vi.fn(async () =>
      options.jobDefaults ?? AGENT_JOB_KINDS.map((kind) => defaultRow(kind)),
    ),
    findForJobKind: vi.fn(async (_orgId: string, kind: AgentJobKind) => defaultRow(kind)),
  };
  const organizations = {
    listForUser: vi.fn(async () => orgs),
    roleForUser: vi.fn(async (orgId: string) =>
      options.roles ? (options.roles[orgId] ?? null) : ("admin" as OrgRole),
    ),
  };

  const deps = {
    organizations,
    jobDefaults,
    providers: providerDeps,
    models: modelDeps,
  } as unknown as ReadinessDeps;

  return { deps, organizations, jobDefaults, providers: providerDeps, models: modelDeps };
}

describe("evaluateModelCoverage", () => {
  it("covers every agent job kind when each has a resolvable default", () => {
    const { deps } = fakeDeps();

    return expect(evaluateModelCoverage(deps, ORG_ID)).resolves.toEqual({
      covered: [...AGENT_JOB_KINDS],
      missing: [],
      kindsWithoutDefault: [],
      kindsThatDoNotResolve: [],
    });
  });

  /**
   * The ADR 018 item 6a case, and the whole reason this module exists: the old
   * create gate accepted four of five because it only ever asked about
   * `spec_grill`. Readiness must not reproduce that.
   */
  it("reports a kind with no default, so partial coverage is not readiness", async () => {
    const { deps } = fakeDeps({
      jobDefaults: AGENT_JOB_KINDS.filter((kind) => kind !== "design_grill").map((kind) =>
        defaultRow(kind),
      ),
    });

    const coverage = await evaluateModelCoverage(deps, ORG_ID);

    expect(coverage.covered).not.toContain("design_grill");
    expect(coverage.kindsWithoutDefault).toEqual(["design_grill"]);
    expect(coverage.missing).toEqual(["design_grill"]);
  });

  // A default whose catalog model was deleted is a different remedy from "assign a
  // model", so the two must not collapse into one bucket.
  it("separates a default that no longer resolves from one that was never set", async () => {
    const { deps } = fakeDeps({
      catalogModelExists: false,
      jobDefaults: [defaultRow("spec_grill"), defaultRow("feature_build")],
    });

    const coverage = await evaluateModelCoverage(deps, ORG_ID);

    expect(coverage.kindsThatDoNotResolve).toEqual(["spec_grill", "feature_build"]);
    expect(coverage.kindsWithoutDefault).toEqual(["test_run", "agentic_review", "design_grill"]);
    // `missing` is the union, so a caller that only wants "is it all covered" does
    // not have to remember to check both lists.
    expect(coverage.missing).toHaveLength(5);
  });

  it("treats an unreadable provider key as unresolvable, not as covered", async () => {
    const { deps } = fakeDeps({ providerKeyReadable: false });

    const coverage = await evaluateModelCoverage(deps, ORG_ID);

    expect(coverage.covered).toEqual([]);
    expect(coverage.kindsThatDoNotResolve).toHaveLength(5);
  });

  it("treats a missing provider row as unresolvable", async () => {
    const { deps } = fakeDeps({ providerExists: false });

    expect((await evaluateModelCoverage(deps, ORG_ID)).covered).toEqual([]);
  });

  /**
   * The optimisation, asserted so it cannot be silently lost: five kinds pointing
   * at one model is the common shape (this install's own org), and resolving it
   * five times would be five identical model+provider lookups per org.
   */
  it("resolves each distinct model once, however many kinds share it", async () => {
    const { deps, models, providers } = fakeDeps();

    await evaluateModelCoverage(deps, ORG_ID);

    expect(models.findById).toHaveBeenCalledTimes(1);
    expect(providers.decryptApiKey).toHaveBeenCalledTimes(1);
  });

  it("resolves a second, different model separately", async () => {
    const { deps, models } = fakeDeps({
      jobDefaults: [
        defaultRow("spec_grill", "model_1"),
        defaultRow("feature_build", "model_2"),
        defaultRow("test_run", "model_2"),
      ],
    });

    await evaluateModelCoverage(deps, ORG_ID);

    expect(models.findById).toHaveBeenCalledTimes(2);
  });

  it("asks only for this org's defaults", async () => {
    const { deps, jobDefaults } = fakeDeps();

    await evaluateModelCoverage(deps, ORG_ID);

    expect(jobDefaults.listForOrganization).toHaveBeenCalledWith(ORG_ID);
  });
});

describe("describeMissingModelKinds", () => {
  it("says nothing is missing when nothing is", () => {
    expect(
      describeMissingModelKinds({
        covered: [...AGENT_JOB_KINDS],
        missing: [],
        kindsWithoutDefault: [],
        kindsThatDoNotResolve: [],
      }),
    ).toBe("Every agent job kind has a default model.");
  });

  it("names the kinds lacking a default, in product terms", () => {
    const text = describeMissingModelKinds({
      covered: [],
      missing: ["design_grill"],
      kindsWithoutDefault: ["design_grill"],
      kindsThatDoNotResolve: [],
    });

    expect(text).toContain("no default model for Design grill");
  });

  // "no default" would send an admin to a field that already has a value, so the
  // two reasons read differently on purpose.
  it("describes an unresolvable default as broken, not as unset", () => {
    const text = describeMissingModelKinds({
      covered: [],
      missing: ["spec_grill"],
      kindsWithoutDefault: [],
      kindsThatDoNotResolve: ["spec_grill"],
    });

    expect(text).toContain("no longer resolves");
    expect(text).not.toContain("no default model for");
  });

  it("reports both reasons when both apply", () => {
    const text = describeMissingModelKinds({
      covered: [],
      missing: ["spec_grill", "test_run"],
      kindsWithoutDefault: ["test_run"],
      kindsThatDoNotResolve: ["spec_grill"],
    });

    expect(text).toContain("no default model for Tests");
    expect(text).toContain("no longer resolves for Spec grill");
  });
});

describe("evaluateOrgReadiness", () => {
  it("is ready when the cluster is configured and every kind resolves", async () => {
    const { deps } = fakeDeps();

    const readiness = await evaluateOrgReadiness(deps, org(), "admin");

    expect(readiness.ready).toBe(true);
    expect(readiness.steps.map((step) => step.satisfied)).toEqual([true, true]);
    expect(readiness.role).toBe("admin");
  });

  it("is not ready on a pending cluster, and says so on the cluster step", async () => {
    const { deps } = fakeDeps();

    const readiness = await evaluateOrgReadiness(deps, org({ status: "pending_cluster" }), "admin");

    expect(readiness.ready).toBe(false);
    const clusterStep = readiness.steps.find((step) => step.id === "cluster")!;
    expect(clusterStep.satisfied).toBe(false);
    expect(clusterStep.detail).toContain("No Kubernetes cluster");
    expect(clusterStep.fixPath).toBe("/settings/organization/cluster");
  });

  it("is not ready on partial model coverage, and names the missing kind", async () => {
    const { deps } = fakeDeps({
      jobDefaults: AGENT_JOB_KINDS.filter((kind) => kind !== "agentic_review").map((kind) =>
        defaultRow(kind),
      ),
    });

    const readiness = await evaluateOrgReadiness(deps, org(), "admin");

    expect(readiness.ready).toBe(false);
    const modelStep = readiness.steps.find((step) => step.id === "model_defaults")!;
    expect(modelStep.satisfied).toBe(false);
    expect(modelStep.missingModelKinds).toEqual(["agentic_review"]);
    expect(modelStep.fixPath).toBe("/settings/organization/providers");
  });

  /**
   * `ready` must not be an independent computation: if it were, a future step
   * could be added and the flag would silently disagree with the list a client
   * renders. Asserted as an invariant over both states rather than as one value.
   */
  it("derives ready from the steps rather than deciding separately", async () => {
    for (const status of ["ready", "pending_cluster"] as const) {
      for (const complete of [true, false]) {
        const { deps } = fakeDeps({
          jobDefaults: complete
            ? undefined
            : AGENT_JOB_KINDS.filter((kind) => kind !== "test_run").map((kind) => defaultRow(kind)),
        });

        const readiness = await evaluateOrgReadiness(deps, org({ status }), "developer");

        expect(readiness.ready).toBe(readiness.steps.every((step) => step.satisfied));
      }
    }
  });

  // The issue's requirement that a non-admin is not sent to an unactionable form:
  // the payload has to say both that the step is unmet *and* that fixing it needs
  // admin rights, or the client cannot write an honest message.
  it("marks every current step as needing admin rights", async () => {
    const { deps } = fakeDeps();

    const readiness = await evaluateOrgReadiness(deps, org({ status: "pending_cluster" }), "developer");

    expect(readiness.steps.every((step) => step.requiresAdmin)).toBe(true);
    expect(readiness.role).toBe("developer");
  });
});

describe("evaluateEntryReadiness", () => {
  it("allows entry when the user's only org is ready", async () => {
    const { deps } = fakeDeps();

    const result = await evaluateEntryReadiness(deps, USER_ID);

    expect(result.entryAllowed).toBe(true);
    expect(result.readyOrganizationId).toBe(ORG_ID);
    expect(result.organizations).toHaveLength(1);
  });

  it("blocks entry when no org is ready, and lists every outstanding step", async () => {
    const { deps } = fakeDeps({
      orgs: [org({ status: "pending_cluster" })],
      jobDefaults: [],
    });

    const result = await evaluateEntryReadiness(deps, USER_ID);

    expect(result.entryAllowed).toBe(false);
    expect(result.readyOrganizationId).toBeNull();
    expect(result.organizations[0]!.steps.filter((step) => !step.satisfied)).toHaveLength(2);
  });

  /**
   * The rule the issue asks me to decide, asserted as a requirement rather than as
   * behaviour: an invitee whose **personal** org is unconfigured must still reach an
   * app they can work in, because they were invited into a ready org and nobody has
   * set up the personal one. Gating on the personal org alone would trap them.
   */
  it("allows entry when a joined org is ready even though the personal org is not", async () => {
    const { deps } = fakeDeps({
      orgs: [
        org({ id: ORG_ID, isPersonal: true, status: "pending_cluster" }),
        org({ id: OTHER_ORG_ID, isPersonal: false, status: "ready", name: "Big Corp" }),
      ],
      roles: { [ORG_ID]: "admin", [OTHER_ORG_ID]: "developer" },
    });

    const result = await evaluateEntryReadiness(deps, USER_ID);

    expect(result.entryAllowed).toBe(true);
    expect(result.readyOrganizationId).toBe(OTHER_ORG_ID);
    // Both are reported, so the client can still say "your own org needs setup"
    // without blocking the user on it.
    expect(result.organizations).toHaveLength(2);
    expect(result.organizations[0]!.ready).toBe(false);
  });

  it("reports each org's readiness independently", async () => {
    const { deps } = fakeDeps({
      orgs: [
        org({ id: ORG_ID, isPersonal: true, status: "ready" }),
        org({ id: OTHER_ORG_ID, isPersonal: false, status: "pending_cluster", name: "Big Corp" }),
      ],
      roles: { [ORG_ID]: "admin", [OTHER_ORG_ID]: "tester" },
    });

    const result = await evaluateEntryReadiness(deps, USER_ID);

    expect(result.organizations.map((entry) => entry.ready)).toEqual([true, false]);
    expect(result.organizations[1]!.role).toBe("tester");
  });

  // A membership removed between `listForUser` and `roleForUser` must not be
  // reported: its fix paths would be pages the user can no longer open.
  it("omits an org whose membership is gone, rather than reporting a fix they cannot make", async () => {
    const { deps } = fakeDeps({
      orgs: [org(), org({ id: OTHER_ORG_ID, name: "Gone Corp" })],
      roles: { [ORG_ID]: "admin", [OTHER_ORG_ID]: null },
    });

    const result = await evaluateEntryReadiness(deps, USER_ID);

    expect(result.organizations.map((entry) => entry.id)).toEqual([ORG_ID]);
  });

  it("handles a user with no orgs at all", async () => {
    const { deps } = fakeDeps({ orgs: [] });

    const result = await evaluateEntryReadiness(deps, USER_ID);

    expect(result.entryAllowed).toBe(false);
    expect(result.organizations).toEqual([]);
    expect(result.readyOrganizationId).toBeNull();
  });
});
