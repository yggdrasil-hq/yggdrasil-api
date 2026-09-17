import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { AuditEventRepository } from "./repository.js";
import { AUDIT_ACTIONS } from "./actions.js";
import { AUDIT_DEFAULT_LIMIT, buildAuditWhere, escapeLikePattern } from "./types.js";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_USER_ID = "44444444-4444-4444-8444-444444444444";

interface QueryRecorder {
  pool: pg.Pool;
  query: ReturnType<typeof vi.fn>;
}

/**
 * A stand-in for the pg pool that records every (sql, values) pair and answers
 * from a canned handler — enough to exercise the repository's insert/list SQL
 * and its row mapping without a database.
 */
function fakePool(
  handler: (sql: string, values: unknown[]) => { rows: unknown[] },
): QueryRecorder {
  const query = vi.fn(async (sql: string, values: unknown[] = []) => handler(sql, values));
  return { pool: { query } as unknown as pg.Pool, query };
}

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    organization_id: ORG_ID,
    project_id: PROJECT_ID,
    actor_user_id: USER_ID,
    actor_kind: "user",
    action: AUDIT_ACTIONS.projectCreated,
    target_type: "project",
    target_id: PROJECT_ID,
    metadata: { name: "Test" },
    ip: "203.0.113.7",
    created_at: new Date("2026-09-16T10:00:00.000Z"),
    ...overrides,
  };
}

describe("AuditEventRepository.create", () => {
  it("inserts one row with the documented defaults and returns it mapped", async () => {
    const { pool, query } = fakePool(() => ({ rows: [eventRow()] }));
    const repository = new AuditEventRepository(pool);

    const event = await repository.create({
      organizationId: ORG_ID,
      action: AUDIT_ACTIONS.projectCreated,
      actorUserId: USER_ID,
      projectId: PROJECT_ID,
      targetType: "project",
      targetId: PROJECT_ID,
      metadata: { name: "Test" },
      ip: "203.0.113.7",
    });

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO audit_events");
    expect(values).toEqual([
      ORG_ID,
      PROJECT_ID,
      USER_ID,
      "user",
      "project.created",
      "project",
      PROJECT_ID,
      JSON.stringify({ name: "Test" }),
      "203.0.113.7",
    ]);

    expect(event).toMatchObject({
      id: "evt_1",
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      actorUserId: USER_ID,
      actorKind: "user",
      action: "project.created",
      metadata: { name: "Test" },
      ip: "203.0.113.7",
    });
    expect(event.createdAt.toISOString()).toBe("2026-09-16T10:00:00.000Z");
  });

  it("defaults actor_kind to user and metadata to an empty object", async () => {
    const { pool, query } = fakePool(() => ({
      rows: [eventRow({ actor_user_id: null, metadata: {} })],
    }));
    const repository = new AuditEventRepository(pool);

    await repository.create({
      organizationId: ORG_ID,
      action: AUDIT_ACTIONS.projectCreated,
    });

    const [, values] = query.mock.calls[0] as [string, unknown[]];
    expect(values).toEqual([
      ORG_ID,
      null,
      null,
      "user",
      "project.created",
      null,
      null,
      "{}",
      null,
    ]);
  });

  it("keeps a webhook actor unowned and labelled as such", async () => {
    const { pool, query } = fakePool(() => ({
      rows: [eventRow({ actor_user_id: null, actor_kind: "webhook" })],
    }));
    const repository = new AuditEventRepository(pool);

    const event = await repository.create({
      organizationId: ORG_ID,
      actorKind: "webhook",
      action: AUDIT_ACTIONS.githubRepositoriesUpdated,
    });

    const [, values] = query.mock.calls[0] as [string, unknown[]];
    expect(values[3]).toBe("webhook");
    expect(values[2]).toBeNull();
    expect(event.actorKind).toBe("webhook");
  });
});

describe("AuditEventRepository.listForOrganization", () => {
  function listPool(rows: unknown[], count = rows.length) {
    return fakePool((sql) =>
      sql.includes("COUNT(*)")
        ? { rows: [{ count: String(count) }] }
        : { rows },
    );
  }

  it("lists newest first, joins actor/project names, and reports the total", async () => {
    const { pool, query } = listPool(
      [
        eventRow({
          project_name: "Test",
          actor_username: "sarat",
          actor_display_name: "Sarat Angajala",
        }),
      ],
      7,
    );
    const repository = new AuditEventRepository(pool);

    const result = await repository.listForOrganization(ORG_ID, {
      limit: AUDIT_DEFAULT_LIMIT,
      offset: 0,
    });

    const listSql = query.mock.calls.find(
      ([sql]) => !(sql as string).includes("COUNT(*)"),
    )?.[0] as string;
    expect(listSql).toContain("ORDER BY e.created_at DESC");
    expect(listSql).toContain("LEFT JOIN projects p ON p.id = e.project_id");
    expect(listSql).toContain("LEFT JOIN users u ON u.id = e.actor_user_id");

    expect(result.total).toBe(7);
    expect(result.events[0]).toMatchObject({
      organizationId: ORG_ID,
      projectName: "Test",
      actorUsername: "sarat",
      actorDisplayName: "Sarat Angajala",
    });
  });

  it("scopes every read to the organization and pages with limit/offset", async () => {
    const { pool, query } = listPool([], 0);
    const repository = new AuditEventRepository(pool);

    await repository.listForOrganization(ORG_ID, { limit: 25, offset: 50 });

    const [listSql, listValues] = query.mock.calls.find(
      ([sql]) => !(sql as string).includes("COUNT(*)"),
    ) as [string, unknown[]];
    expect(listSql).toContain("organization_id = $1");
    expect(listSql).toContain("LIMIT $2 OFFSET $3");
    expect(listValues).toEqual([ORG_ID, 25, 50]);
  });

  it("applies every filter to both the page and the count query", async () => {
    const { pool, query } = listPool([]);
    const repository = new AuditEventRepository(pool);
    const from = new Date("2026-09-01T00:00:00.000Z");
    const to = new Date("2026-09-30T00:00:00.000Z");

    await repository.listForOrganization(ORG_ID, {
      projectId: PROJECT_ID,
      actorUserId: USER_ID,
      action: "project",
      from,
      to,
      limit: 10,
      offset: 0,
    });

    const expectedWhereValues = [
      ORG_ID,
      PROJECT_ID,
      USER_ID,
      "project%",
      from,
      to,
    ];

    const listCall = query.mock.calls.find(
      ([sql]) => !(sql as string).includes("COUNT(*)"),
    ) as [string, unknown[]];
    const countCall = query.mock.calls.find(([sql]) =>
      (sql as string).includes("COUNT(*)"),
    ) as [string, unknown[]];

    expect(listCall[0]).toContain("project_id = $2");
    expect(listCall[0]).toContain("actor_user_id = $3");
    expect(listCall[0]).toContain("action LIKE $4");
    expect(listCall[0]).toContain("created_at >= $5");
    expect(listCall[0]).toContain("created_at <= $6");
    expect(listCall[1]).toEqual([...expectedWhereValues, 10, 0]);

    // The count query carries the same filters but no pagination.
    expect(countCall[1]).toEqual(expectedWhereValues);
  });

  it("returns an empty page and zero total when nothing matches", async () => {
    const { pool } = listPool([], 0);
    const repository = new AuditEventRepository(pool);

    const result = await repository.listForOrganization(ORG_ID, {
      limit: 10,
      offset: 0,
    });

    expect(result.events).toEqual([]);
    expect(result.total).toBe(0);
  });
});

describe("buildAuditWhere", () => {
  it("scopes to the organization alone when no filters are given", () => {
    expect(buildAuditWhere(ORG_ID, {})).toEqual({
      clause: "organization_id = $1",
      values: [ORG_ID],
    });
  });

  it("treats the action filter as a prefix match", () => {
    const { clause, values } = buildAuditWhere(ORG_ID, { action: "org.invite" });
    expect(clause).toContain("action LIKE $2 ESCAPE");
    expect(values[1]).toBe("org.invite%");
  });

  it("escapes LIKE metacharacters so a filter matches literally", () => {
    expect(escapeLikePattern("project%_done\\")).toBe("project\\%\\_done\\\\");
    const { values } = buildAuditWhere(ORG_ID, { action: "100%" });
    expect(values[1]).toBe("100\\%%");
  });

  it("filter order follows the documented positionals", () => {
    const { clause } = buildAuditWhere(ORG_ID, {
      projectId: PROJECT_ID,
      actorUserId: OTHER_USER_ID,
    });
    expect(clause).toBe(
      "organization_id = $1 AND project_id = $2 AND actor_user_id = $3",
    );
  });
});
