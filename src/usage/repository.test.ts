import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { JobUsageRepository } from "./repository.js";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "55555555-5555-4555-8555-555555555555";

interface QueryRecorder {
  pool: pg.Pool;
  query: ReturnType<typeof vi.fn>;
}

/**
 * Stands in for the pg pool: records every (sql, values) pair and answers from
 * a canned handler, so the repository's SQL and — more importantly here — its
 * row mapping can be exercised without a database.
 */
function fakePool(
  handler: (sql: string, values: unknown[]) => { rows: unknown[] },
): QueryRecorder {
  const query = vi.fn(async (sql: string, values: unknown[] = []) => handler(sql, values));
  return { pool: { query } as unknown as pg.Pool, query };
}

function scope() {
  return {
    organizationId: ORG_ID,
    projectId: undefined,
    from: new Date("2026-08-18T00:00:00.000Z"),
    to: new Date("2026-09-17T00:00:00.000Z"),
    previousFrom: new Date("2026-07-19T00:00:00.000Z"),
    recentLimit: 25,
  };
}

describe("JobUsageRepository.upsert", () => {
  it("maps a row back, coercing Postgres's string-typed bigints", async () => {
    const { pool, query } = fakePool(() => ({
      rows: [
        {
          job_id: JOB_ID,
          project_id: PROJECT_ID,
          job_kind: "feature_build",
          model_id: "anthropic/claude-sonnet-4",
          model_config_source: "organization_default",
          provider_name: "OpenRouter",
          input_tokens: "50000",
          output_tokens: "10000",
          cache_read_tokens: "40000",
          cache_write_tokens: "5000",
          total_tokens: "105000",
          cost_usd: "0.450000",
          duration_ms: "90000",
          created_at: new Date("2026-09-16T10:00:00.000Z"),
        },
      ],
    }));
    const repository = new JobUsageRepository(pool);

    const usage = await repository.upsert({
      jobId: JOB_ID,
      projectId: PROJECT_ID,
      jobKind: "feature_build",
      modelId: "anthropic/claude-sonnet-4",
      modelConfigSource: "organization_default",
      providerName: "OpenRouter",
      inputTokens: 50_000,
      outputTokens: 10_000,
      cacheReadTokens: 40_000,
      cacheWriteTokens: 5_000,
      totalTokens: 105_000,
      costUsd: 0.45,
      durationMs: 90_000,
    });

    // pg hands back int8/numeric as strings; leaving them as strings would
    // silently turn every aggregate into concatenation downstream.
    expect(usage.inputTokens).toBe(50_000);
    expect(usage.totalTokens).toBe(105_000);
    expect(usage.costUsd).toBe(0.45);
    expect(usage.durationMs).toBe(90_000);

    const [sql] = query.mock.calls[0] as [string];
    // Idempotent on job_id: the figures are a whole-session snapshot, so a
    // re-report replaces rather than accumulates.
    expect(sql).toContain("ON CONFLICT (job_id) DO UPDATE");
  });

  it("keeps an unreported cost null rather than reading it as free", async () => {
    const { pool } = fakePool(() => ({
      rows: [
        {
          job_id: JOB_ID,
          project_id: PROJECT_ID,
          job_kind: "spec_grill",
          model_id: null,
          model_config_source: null,
          provider_name: null,
          input_tokens: "0",
          output_tokens: "0",
          cache_read_tokens: "0",
          cache_write_tokens: "0",
          total_tokens: "0",
          cost_usd: null,
          duration_ms: null,
          created_at: new Date(),
        },
      ],
    }));

    const usage = await new JobUsageRepository(pool).upsert({
      jobId: JOB_ID,
      projectId: PROJECT_ID,
      jobKind: "spec_grill",
      modelId: null,
      modelConfigSource: null,
      providerName: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUsd: null,
      durationMs: null,
    });

    expect(usage.costUsd).toBeNull();
    expect(usage.durationMs).toBeNull();
  });
});

describe("JobUsageRepository aggregates", () => {
  it("scopes every aggregate by organization and derives totals from the window", async () => {
    const { pool, query } = fakePool((sql) => {
      if (sql.includes("AS sessions") && sql.includes("previous_sessions")) {
        return {
          rows: [
            {
              sessions: "12",
              tokens: "480000",
              cost: "1.250000",
              previous_sessions: "10",
              previous_tokens: "400000",
            },
          ],
        };
      }
      if (sql.includes("GROUP BY u.provider_name")) {
        return {
          rows: [
            { provider_name: "OpenRouter", tokens: "480000", sessions: "12", cost: "1.250000" },
            { provider_name: null, tokens: "0", sessions: "1", cost: null },
          ],
        };
      }
      if (sql.includes("GROUP BY u.job_kind")) {
        return { rows: [{ job_kind: "feature_build", tokens: "480000", sessions: "12" }] };
      }
      if (sql.includes("GROUP BY p.id, p.name")) {
        return {
          rows: [
            { project_id: PROJECT_ID, project_name: "Acme Web App", tokens: "480000", sessions: "12" },
          ],
        };
      }
      return { rows: [] };
    });

    const report = await new JobUsageRepository(pool).organizationUsage(scope());

    expect(report.totals.sessions).toBe(12);
    expect(report.totals.tokens).toBe(480_000);
    expect(report.totals.costUsd).toBe(1.25);
    expect(report.totals.previousSessions).toBe(10);
    expect(report.totals.previousTokens).toBe(400_000);
    expect(report.days).toBe(30);

    // A provider bucket with no reported cost stays null — this is what lets
    // the page say "not reported" instead of showing a confident $0.
    expect(report.byProvider[1].costUsd).toBeNull();
    expect(report.byKind[0].jobKind).toBe("feature_build");
    expect(report.byProject[0].projectName).toBe("Acme Web App");

    // Every aggregate carries the same org/window placeholders, so no query
    // can silently read a different (wider) set of rows than the totals.
    for (const call of query.mock.calls) {
      const [sql, values] = call as [string, unknown[]];
      expect(sql).toContain("p.organization_id = $1");
      expect(values[0]).toBe(ORG_ID);
    }
  });

  it("counts cost as unreported — not zero — when no row in the window has one", async () => {
    const { pool } = fakePool((sql) => {
      if (sql.includes("previous_sessions")) {
        return {
          rows: [
            {
              sessions: "0",
              tokens: null,
              cost: null,
              previous_sessions: "0",
              previous_tokens: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const report = await new JobUsageRepository(pool).projectUsage({
      ...scope(),
      projectId: PROJECT_ID,
    });

    expect(report.totals.tokens).toBe(0);
    expect(report.totals.costUsd).toBeNull();
  });

  it("labels a recent session from whichever subject its job kind actually has", async () => {
    const { pool } = fakePool((sql) => {
      if (sql.includes("u.duration_ms")) {
        return {
          rows: [
            {
              job_id: JOB_ID,
              project_id: PROJECT_ID,
              project_name: "Acme Web App",
              job_kind: "feature_build",
              total_tokens: "94200",
              cost_usd: "0.310000",
              duration_ms: "612000",
              created_at: new Date("2026-09-16T10:00:00.000Z"),
              status: "completed",
              feature_id: "feat_1",
              test_id: null,
              design_name: null,
              feature_title: "Usage metrics dashboard",
              test_name: null,
            },
            {
              job_id: "66666666-6666-4666-8666-666666666666",
              project_id: PROJECT_ID,
              project_name: "Acme Web App",
              job_kind: "design_grill",
              total_tokens: "27900",
              cost_usd: null,
              duration_ms: null,
              created_at: new Date("2026-09-15T10:00:00.000Z"),
              status: "completed",
              feature_id: null,
              test_id: null,
              design_name: "Pricing page refresh",
              feature_title: null,
              test_name: null,
            },
          ],
        };
      }
      if (sql.includes("previous_sessions")) {
        return { rows: [{ sessions: "0", tokens: "0", cost: null, previous_sessions: "0", previous_tokens: "0" }] };
      }
      return { rows: [] };
    });

    const report = await new JobUsageRepository(pool).projectAnalytics({
      ...scope(),
      projectId: PROJECT_ID,
    });

    expect(report.recentSessions[0].title).toBe("Usage metrics dashboard");
    expect(report.recentSessions[0].featureId).toBe("feat_1");
    // A design session has no feature and no test, so its own name is the only
    // thing that can label it.
    expect(report.recentSessions[1].title).toBe("Pricing page refresh");
    expect(report.recentSessions[1].costUsd).toBeNull();
  });
});
