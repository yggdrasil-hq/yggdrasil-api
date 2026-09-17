import type { JobStatus } from "../jobs/types.js";

/**
 * A design's lifecycle, as ADR 020 item 3 defines it.
 *
 * Deliberately just two states, both grounded in what the shipped
 * `design_grill` flow actually does (ADR 014): a session either ends by
 * calling `submit_design` — which commits `designs/<slug>/` and opens its
 * draft PR — or it doesn't. Run outcome for the *newest* session (failed,
 * cancelled, still running) is read from that session's job row and surfaced
 * beside the design, rather than mirrored into this column: the job already
 * owns run status, and duplicating it here would be two spellings of one
 * concept that can disagree.
 *
 * `finalized` is terminal. A later session iterating on the same folder does
 * not un-finalize a design that has already been committed and PR'd.
 */
export type DesignStatus = "in_progress" | "finalized";

export const DESIGN_STATUSES: DesignStatus[] = ["in_progress", "finalized"];

export interface Design {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  status: DesignStatus;
  originJobId: string | null;
  prUrl: string | null;
  finalizedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One `design_grill` session belonging to a design, as the history view needs it. */
export interface DesignSessionSummary {
  id: string;
  status: JobStatus;
  createdAt: Date;
  completedAt: Date | null;
  lastError: string | null;
}

/** A design plus the status of its most recent session — the browse row. */
export interface DesignWithLatestSession {
  design: Design;
  latestSession: DesignSessionSummary | null;
}

export interface PublicDesignSessionSummary {
  id: string;
  status: JobStatus;
  createdAt: string;
  completedAt: string | null;
  lastError: string | null;
}

export interface PublicDesign {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  status: DesignStatus;
  originJobId: string | null;
  prUrl: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Null until a session has run — a row can exist only via a session today. */
  latestSession: PublicDesignSessionSummary | null;
}

export function toPublicDesignSession(
  session: DesignSessionSummary,
): PublicDesignSessionSummary {
  return {
    id: session.id,
    status: session.status,
    createdAt: session.createdAt.toISOString(),
    completedAt: session.completedAt?.toISOString() ?? null,
    lastError: session.lastError,
  };
}

export function toPublicDesign(input: DesignWithLatestSession): PublicDesign {
  const { design, latestSession } = input;
  return {
    id: design.id,
    projectId: design.projectId,
    name: design.name,
    slug: design.slug,
    status: design.status,
    originJobId: design.originJobId,
    prUrl: design.prUrl,
    finalizedAt: design.finalizedAt?.toISOString() ?? null,
    createdAt: design.createdAt.toISOString(),
    updatedAt: design.updatedAt.toISOString(),
    latestSession: latestSession ? toPublicDesignSession(latestSession) : null,
  };
}
