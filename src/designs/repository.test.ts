import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { DesignRepository } from "./repository.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const DESIGN_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";

interface QueryRecorder {
  pool: pg.Pool;
  query: ReturnType<typeof vi.fn>;
}

function fakePool(
  handler: (sql: string, values: unknown[]) => { rows: unknown[] },
): QueryRecorder {
  const query = vi.fn(async (sql: string, values: unknown[] = []) => handler(sql, values));
  return { pool: { query } as unknown as pg.Pool, query };
}

function designRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DESIGN_ID,
    project_id: PROJECT_ID,
    name: "Checkout",
    slug: "checkout",
    status: "in_progress",
    origin_job_id: JOB_ID,
    pr_url: null,
    finalized_at: null,
    created_at: new Date("2026-09-01T10:00:00.000Z"),
    updated_at: new Date("2026-09-02T10:00:00.000Z"),
    ...overrides,
  };
}

describe("DesignRepository.startSession", () => {
  it("upserts on (project_id, slug) so one folder can never get two rows", async () => {
    const { pool, query } = fakePool(() => ({ rows: [designRow()] }));
    const repo = new DesignRepository(pool);

    const design = await repo.startSession({
      projectId: PROJECT_ID,
      name: "Checkout",
      slug: "checkout",
      jobId: JOB_ID,
    });

    const [insertSql, insertValues] = query.mock.calls[0] as [string, unknown[]];
    expect(insertSql).toContain("INSERT INTO designs");
    expect(insertSql).toContain("ON CONFLICT (project_id, slug) DO UPDATE");
    // Updating the name on conflict would let a later session rename the index
    // entry out of step with the folder name it points at.
    expect(insertSql).not.toContain("name = EXCLUDED.name");
    expect(insertValues).toEqual([PROJECT_ID, "Checkout", "checkout", JOB_ID]);
    expect(design.slug).toBe("checkout");

    // The session is linked in a second statement, so history is one lookup.
    const [linkSql, linkValues] = query.mock.calls[1] as [string, unknown[]];
    expect(linkSql).toContain("UPDATE jobs SET design_id");
    expect(linkValues).toEqual([DESIGN_ID, JOB_ID]);
  });
});

describe("DesignRepository.finalize", () => {
  it("upserts as finalized and keeps the first finalization timestamp", async () => {
    const { pool, query } = fakePool(() => ({
      rows: [
        designRow({
          status: "finalized",
          pr_url: "https://github.com/acme/web/pull/7",
          finalized_at: new Date("2026-09-03T10:00:00.000Z"),
        }),
      ],
    }));
    const repo = new DesignRepository(pool);

    const design = await repo.finalize({
      projectId: PROJECT_ID,
      name: "Checkout",
      slug: "checkout",
      jobId: JOB_ID,
      prUrl: "https://github.com/acme/web/pull/7",
    });

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    // Self-healing: an upsert, so a session whose index row was never written
    // still lands a correct row exactly when it becomes worth browsing.
    expect(sql).toContain("ON CONFLICT (project_id, slug) DO UPDATE");
    expect(sql).toContain("finalized_at = COALESCE(designs.finalized_at, NOW())");
    // A replayed event must not wipe a PR url it already recorded.
    expect(sql).toContain("pr_url = COALESCE(EXCLUDED.pr_url, designs.pr_url)");
    expect(values).toEqual([
      PROJECT_ID,
      "Checkout",
      "checkout",
      JOB_ID,
      "https://github.com/acme/web/pull/7",
    ]);
    expect(design.status).toBe("finalized");
    expect(design.prUrl).toBe("https://github.com/acme/web/pull/7");
  });
});

describe("DesignRepository.listForProject", () => {
  it("scopes by project and reads the latest session through a lateral join", async () => {
    const { pool, query } = fakePool(() => ({
      rows: [
        designRow({
          latest_session_id: JOB_ID,
          latest_session_status: "failed",
          latest_session_created_at: new Date("2026-09-04T10:00:00.000Z"),
          latest_session_completed_at: new Date("2026-09-04T10:05:00.000Z"),
          latest_session_last_error: "container died",
        }),
      ],
    }));
    const repo = new DesignRepository(pool);

    const [listed] = await repo.listForProject(PROJECT_ID);

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("WHERE d.project_id = $1");
    expect(sql).toContain("LEFT JOIN LATERAL");
    expect(values).toEqual([PROJECT_ID, 200]);

    expect(listed.design.id).toBe(DESIGN_ID);
    // Session run outcome is read through, never mirrored onto the design row
    // (ADR 020 item 3) — so a failed session does not make the design "failed".
    expect(listed.design.status).toBe("in_progress");
    expect(listed.latestSession).toEqual({
      id: JOB_ID,
      status: "failed",
      createdAt: new Date("2026-09-04T10:00:00.000Z"),
      completedAt: new Date("2026-09-04T10:05:00.000Z"),
      lastError: "container died",
    });
  });

  it("reports no session for a design that has never been worked on", async () => {
    const { pool } = fakePool(() => ({ rows: [designRow()] }));
    const repo = new DesignRepository(pool);

    const [listed] = await repo.listForProject(PROJECT_ID);
    expect(listed.latestSession).toBeNull();
  });
});

describe("DesignRepository.findByIdForProject", () => {
  it("bounds the lookup by project id as well as design id", async () => {
    const { pool, query } = fakePool(() => ({ rows: [] }));
    const repo = new DesignRepository(pool);

    const found = await repo.findByIdForProject(PROJECT_ID, DESIGN_ID);

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("WHERE d.project_id = $1 AND d.id = $2");
    expect(values).toEqual([PROJECT_ID, DESIGN_ID]);
    expect(found).toBeNull();
  });
});

describe("DesignRepository.findContinuationContext", () => {
  it("reads only the snapshot's path keys, never the stored HTML", async () => {
    const { pool, query } = fakePool(() => ({
      rows: [
        {
          session_id: JOB_ID,
          pr_url: "https://github.com/acme/web/pull/7",
          paths: ["designs/checkout/page.html"],
        },
      ],
    }));
    const repo = new DesignRepository(pool);

    const context = await repo.findContinuationContext(PROJECT_ID, "checkout", "current_job");

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("jsonb_object_keys(e.design_snapshot)");
    expect(sql).not.toContain("e.design_snapshot AS");
    // A session must never be seeded with itself.
    expect(sql).toContain("j.id <> $3");
    expect(values).toEqual([PROJECT_ID, "checkout", "current_job"]);
    expect(context).toEqual({
      sessionId: JOB_ID,
      prUrl: "https://github.com/acme/web/pull/7",
      paths: ["designs/checkout/page.html"],
    });
  });

  it("returns null when no earlier session ever finalized this design", async () => {
    const { pool } = fakePool(() => ({ rows: [] }));
    const repo = new DesignRepository(pool);

    expect(await repo.findContinuationContext(PROJECT_ID, "checkout", "job_1")).toBeNull();
  });
});
