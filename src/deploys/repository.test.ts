import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { ProjectDeployRepository } from "./repository.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

interface QueryRecorder {
  pool: pg.Pool;
  query: ReturnType<typeof vi.fn>;
}

/**
 * A pg pool stand-in that records every (sql, values) pair and answers from a
 * canned handler, mirroring src/audit/repository.test.ts — enough to exercise
 * the ledger's SQL and row mapping without a database.
 */
function fakePool(
  handler: (sql: string, values: unknown[]) => { rows: unknown[] },
): QueryRecorder {
  const query = vi.fn(async (sql: string, values: unknown[] = []) => handler(sql, values));
  return { pool: { query } as unknown as pg.Pool, query };
}

function deployRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "deploy_1",
    project_id: PROJECT_ID,
    job_id: JOB_ID,
    kind: "deploy",
    helm_revision: 4,
    target_revision: null,
    status: "completed",
    last_error: null,
    ref: "main",
    created_at: new Date("2026-09-17T10:00:00.000Z"),
    ...overrides,
  };
}

describe("ProjectDeployRepository.record", () => {
  it("inserts the outcome and returns the row mapped", async () => {
    const { pool, query } = fakePool(() => ({ rows: [deployRow()] }));
    const repository = new ProjectDeployRepository(pool);

    const deploy = await repository.record({
      projectId: PROJECT_ID,
      jobId: JOB_ID,
      kind: "deploy",
      helmRevision: 4,
      status: "completed",
      ref: "main",
    });

    expect(deploy).toEqual({
      id: "deploy_1",
      projectId: PROJECT_ID,
      jobId: JOB_ID,
      kind: "deploy",
      helmRevision: 4,
      targetRevision: null,
      status: "completed",
      lastError: null,
      ref: "main",
      createdAt: new Date("2026-09-17T10:00:00.000Z"),
    });

    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO project_deploys/);
    expect(values).toEqual([PROJECT_ID, JOB_ID, "deploy", 4, null, "completed", null, "main"]);
  });

  it("records a rollback's requested target alongside the revision it produced", async () => {
    const { pool, query } = fakePool(() => ({
      rows: [deployRow({ kind: "rollback", helm_revision: 10, target_revision: 3 })],
    }));
    const repository = new ProjectDeployRepository(pool);

    const deploy = await repository.record({
      projectId: PROJECT_ID,
      jobId: JOB_ID,
      kind: "rollback",
      helmRevision: 10,
      targetRevision: 3,
      status: "completed",
    });

    expect(deploy.helmRevision).toBe(10);
    expect(deploy.targetRevision).toBe(3);
    expect(query.mock.calls[0][1][4]).toBe(3);
  });

  it("records a failed attempt with a null revision", async () => {
    const { pool, query } = fakePool(() => ({
      rows: [deployRow({ helm_revision: null, status: "failed", last_error: "helm upgrade failed" })],
    }));
    const repository = new ProjectDeployRepository(pool);

    const deploy = await repository.record({
      projectId: PROJECT_ID,
      jobId: JOB_ID,
      kind: "deploy",
      helmRevision: null,
      status: "failed",
      lastError: "helm upgrade failed",
    });

    expect(deploy.helmRevision).toBeNull();
    expect(deploy.lastError).toBe("helm upgrade failed");
    expect(query.mock.calls[0][1][3]).toBeNull();
  });
});

describe("ProjectDeployRepository.listForProject", () => {
  it("returns the project's history newest first", async () => {
    const { pool, query } = fakePool(() => ({ rows: [deployRow(), deployRow({ id: "deploy_0" })] }));
    const repository = new ProjectDeployRepository(pool);

    const deploys = await repository.listForProject(PROJECT_ID);

    expect(deploys).toHaveLength(2);
    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/ORDER BY created_at DESC/);
    expect(values[0]).toBe(PROJECT_ID);
  });
});

describe("ProjectDeployRepository.currentRevision", () => {
  it("returns the newest revision that was actually applied", async () => {
    const { pool, query } = fakePool(() => ({ rows: [{ helm_revision: 12 }] }));
    const repository = new ProjectDeployRepository(pool);

    expect(await repository.currentRevision(PROJECT_ID)).toBe(12);

    // A failed attempt stores a null revision, so filtering on it is what makes
    // "current" mean "the last thing successfully applied" without consulting
    // the cluster.
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/helm_revision IS NOT NULL/);
    expect(sql).toMatch(/status = 'completed'/);
  });

  it("returns null for a project that has never deployed", async () => {
    const { pool } = fakePool(() => ({ rows: [] }));
    const repository = new ProjectDeployRepository(pool);

    expect(await repository.currentRevision(PROJECT_ID)).toBeNull();
  });
});

describe("ProjectDeployRepository.listRollbackTargets", () => {
  it("excludes the revision that is currently live", async () => {
    const { pool } = fakePool((sql) => {
      if (sql.includes("DISTINCT ON")) {
        return {
          rows: [
            { helm_revision: 12, created_at: new Date("2026-09-17T12:00:00Z"), kind: "deploy" },
            { helm_revision: 9, created_at: new Date("2026-09-16T12:00:00Z"), kind: "deploy" },
            { helm_revision: 4, created_at: new Date("2026-09-15T12:00:00Z"), kind: "rollback" },
          ],
        };
      }
      return { rows: [{ helm_revision: 12 }] };
    });
    const repository = new ProjectDeployRepository(pool);

    const targets = await repository.listRollbackTargets(PROJECT_ID);

    // Offering "roll back to what is already running" would be a no-op, so 12
    // is filtered out; the rest stay newest-first.
    expect(targets.map((t) => t.revision)).toEqual([9, 4]);
    expect(targets[1].kind).toBe("rollback");
  });

  it("offers nothing when there is only one revision", async () => {
    const { pool } = fakePool((sql) => {
      if (sql.includes("DISTINCT ON")) {
        return { rows: [{ helm_revision: 1, created_at: new Date(), kind: "deploy" }] };
      }
      return { rows: [{ helm_revision: 1 }] };
    });
    const repository = new ProjectDeployRepository(pool);

    expect(await repository.listRollbackTargets(PROJECT_ID)).toEqual([]);
  });
});

describe("ProjectDeployRepository.hasRevision", () => {
  it("reports whether the project ever produced that revision", async () => {
    const { pool, query } = fakePool(() => ({ rows: [{ exists: true }] }));
    const repository = new ProjectDeployRepository(pool);

    expect(await repository.hasRevision(PROJECT_ID, 9)).toBe(true);

    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/EXISTS/);
    expect(sql).toMatch(/status = 'completed'/);
    expect(values).toEqual([PROJECT_ID, 9]);
  });

  it("is false for a revision the project never produced", async () => {
    const { pool } = fakePool(() => ({ rows: [{ exists: false }] }));
    const repository = new ProjectDeployRepository(pool);

    expect(await repository.hasRevision(PROJECT_ID, 99)).toBe(false);
  });
});
