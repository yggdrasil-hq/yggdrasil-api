import type { JobKind } from "../jobs/types.js";

/**
 * ADR 030: the job kinds that consume the organization's model credential, and
 * are therefore the only kinds a token cap governs.
 *
 * This is deliberately the same five as ADR 018's `AgentJobKind` -- the kinds
 * that resolve a model configuration and run Pi against it -- because "spends
 * tokens" and "resolves a model config" are the same set by construction, not
 * by coincidence. `deploy`, `script_test_run`, and `rollback` are fully
 * deterministic (no Pi, no provider call), so they neither spend tokens nor
 * can be blocked by a spend cap; gating them would take a project's ability to
 * deploy or test its own code hostage to its model spend, which is not what
 * the cap is for.
 *
 * Spelled out here rather than re-exported from model-config so the cap rule
 * reads as its own decision at the point of enforcement.
 */
export const TOKEN_CONSUMING_KINDS = [
  "spec_grill",
  "feature_build",
  "test_run",
  "agentic_review",
  "design_grill",
] as const satisfies readonly JobKind[];

export type TokenConsumingKind = (typeof TOKEN_CONSUMING_KINDS)[number];

export function consumesTokens(kind: JobKind): kind is TokenConsumingKind {
  return (TOKEN_CONSUMING_KINDS as readonly JobKind[]).includes(kind);
}

/**
 * The platform defaults a project without an explicit override falls back to.
 *
 * These mirror the constants `orchestrator/internal/k8s/namespace.go` used
 * before ADR 030 made them configurable, and the Orchestrator still carries
 * them as its fail-soft fallback if this API cannot be reached. The two must
 * agree: change one, change the other. (ADR 030 §6 records why the duplication
 * is accepted rather than removed -- quota sizing is a guardrail, so a job must
 * not fail because the limit could not be read.)
 */
export const DEFAULT_RESOURCE_QUOTA = {
  cpuMillicores: 4000,
  memoryMib: 8192,
  pods: 10,
} as const;

/** A project's stored quota override; every field present means "set". */
export interface ProjectResourceQuota {
  projectId: string;
  cpuMillicores: number;
  memoryMib: number;
  pods: number;
  updatedAt: Date;
}

/** A project's stored monthly token cap. `cap` is never null -- absence is the uncapped signal. */
export interface ProjectTokenCap {
  projectId: string;
  monthlyTokenCap: number;
  updatedAt: Date;
}

/**
 * The effective limits for one project: the stored override where one exists,
 * the platform default otherwise, plus whether each came from an override.
 * `fromOverride` is what lets an admin tell "this is what I set" apart from
 * "this is what everyone gets", which the allocations page shows.
 */
export interface EffectiveProjectAllocation {
  projectId: string;
  /** Null means uncapped -- no row. Distinct from 0, which permits nothing further. */
  monthlyTokenCap: number | null;
  quota: {
    cpuMillicores: number;
    memoryMib: number;
    pods: number;
    fromOverride: boolean;
  };
}

/**
 * One project's cap standing for the current period, as returned to both the
 * admin UI and the Orchestrator's enforcement check. Every field is derived
 * from the usage aggregation plus the stored cap -- nothing here is a running
 * total (ADR 030 §3).
 */
export interface TokenCapState {
  projectId: string;
  /** Null means uncapped. */
  cap: number | null;
  usedTokens: number;
  /** Null means uncapped; never negative (see `exceeded`). */
  remainingTokens: number | null;
  /** True when the project may not start further token-consuming work this period. */
  exceeded: boolean;
  /** Inclusive start of the enforced period, ISO-8601 UTC. */
  periodStart: string;
  /** Exclusive end of the enforced period, ISO-8601 UTC. */
  periodEnd: string;
}

/** Public shape for the admin allocations read. */
export interface OrganizationAllocationsResponse {
  organizationId: string;
  periodStart: string;
  periodEnd: string;
  defaults: typeof DEFAULT_RESOURCE_QUOTA;
  projects: Array<
    EffectiveProjectAllocation & {
      projectName: string;
      capState: TokenCapState;
    }
  >;
}

export function toEffectiveAllocation(
  projectId: string,
  cap: ProjectTokenCap | null,
  quota: ProjectResourceQuota | null,
): EffectiveProjectAllocation {
  return {
    projectId,
    monthlyTokenCap: cap?.monthlyTokenCap ?? null,
    quota: quota
      ? {
          cpuMillicores: quota.cpuMillicores,
          memoryMib: quota.memoryMib,
          pods: quota.pods,
          fromOverride: true,
        }
      : { ...DEFAULT_RESOURCE_QUOTA, fromOverride: false },
  };
}
