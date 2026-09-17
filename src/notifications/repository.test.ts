import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { NotificationRepository } from "./repository.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_PROJECT_ID = "44444444-4444-4444-8444-444444444444";

interface QueryRecorder {
  pool: pg.Pool;
  query: ReturnType<typeof vi.fn>;
  inserted: () => boolean;
}

function notificationRow(projectId: string | null) {
  return {
    id: "note_1",
    user_id: USER_ID,
    project_id: projectId,
    kind: "feature_created",
    title: "Spec grill started",
    body: null,
    link_path: null,
    read_at: null,
    created_at: new Date("2026-09-17T10:00:00.000Z"),
  };
}

/**
 * A pg pool stand-in that answers by SQL shape, so the repository's preference
 * lookups and its insert can be driven without a database — the same approach
 * as audit/repository.test.ts.
 */
function fakePool(input: {
  organizationId?: string | null;
  preferences?: Array<{ kind: string | null; enabled: boolean }>;
  muted?: boolean;
}): QueryRecorder {
  const preferences = input.preferences ?? [];
  // `??` would turn an explicit null (meaning "unresolvable") back into the
  // default, so the sentinel is distinguished from "not supplied".
  const organizationId =
    input.organizationId === undefined ? ORG_ID : input.organizationId;

  const query = vi.fn(async (sql: string, _values: unknown[] = []) => {
    if (sql.includes("INSERT INTO notifications")) {
      return { rows: [notificationRow(PROJECT_ID)] };
    }
    if (sql.includes("INSERT INTO project_notification_mutes")) {
      return { rows: [] };
    }
    if (sql.includes("DELETE FROM project_notification_mutes")) {
      return { rows: [] };
    }
    if (sql.includes("SELECT organization_id FROM projects")) {
      return { rows: organizationId ? [{ organization_id: organizationId }] : [] };
    }
    if (sql.includes("FROM notification_preferences")) {
      return {
        rows: preferences.map((row, index) => ({
          id: `pref_${index}`,
          user_id: USER_ID,
          organization_id: ORG_ID,
          kind: row.kind,
          enabled: row.enabled,
        })),
      };
    }
    if (sql.includes("FROM project_notification_mutes")) {
      return { rows: [{ muted: input.muted ?? false }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });

  return {
    pool: { query } as unknown as pg.Pool,
    query,
    inserted: () =>
      query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO notifications")),
  };
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER_ID,
    projectId: PROJECT_ID,
    kind: "feature_created",
    title: "Spec grill started",
    ...overrides,
  };
}

describe("NotificationRepository.create preference gating (ADR 027)", () => {
  it("inserts when the user has no preferences and no mute", async () => {
    const { pool, inserted, query } = fakePool({});
    const repository = new NotificationRepository(pool);

    const notification = await repository.create(createInput({}));

    expect(inserted()).toBe(true);
    expect(notification).not.toBeNull();
    expect(notification?.kind).toBe("feature_created");
    // The lookup still happened — absence of rows is what means "notify".
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("FROM notification_preferences")),
    ).toBe(true);
  });

  it("does not insert when the notification's kind is disabled", async () => {
    const { pool, inserted } = fakePool({
      preferences: [{ kind: "feature_created", enabled: false }],
    });
    const repository = new NotificationRepository(pool);

    const notification = await repository.create(createInput({}));

    expect(inserted()).toBe(false);
    expect(notification).toBeNull();
  });

  it("does not insert when the org-wide row disables every kind", async () => {
    const { pool, inserted } = fakePool({ preferences: [{ kind: null, enabled: false }] });
    const repository = new NotificationRepository(pool);

    const notification = await repository.create(createInput({}));

    expect(inserted()).toBe(false);
    expect(notification).toBeNull();
  });

  it("does not insert for a muted project", async () => {
    const { pool, inserted } = fakePool({
      muted: true,
      preferences: [{ kind: null, enabled: true }],
    });
    const repository = new NotificationRepository(pool);

    const notification = await repository.create(createInput({}));

    expect(inserted()).toBe(false);
    expect(notification).toBeNull();
  });

  it("still resolves the project's organization through the project row", async () => {
    const { pool, query } = fakePool({});
    const repository = new NotificationRepository(pool);

    await repository.create(createInput({ projectId: OTHER_PROJECT_ID }));

    const orgLookup = query.mock.calls.find(([sql]) =>
      String(sql).includes("SELECT organization_id FROM projects"),
    );
    expect(orgLookup).toBeDefined();
    expect((orgLookup?.[1] as unknown[])[0]).toBe(OTHER_PROJECT_ID);
  });

  /**
   * A notification with no project cannot be traced to an organization, so no
   * preference row can match and the documented answer is "notify" — including
   * when the user has muted projects elsewhere.
   */
  it("notifies a project-less notification without consulting preferences", async () => {
    const { pool, inserted, query } = fakePool({ muted: true });
    const repository = new NotificationRepository(pool);

    await repository.create(createInput({ projectId: undefined }));

    expect(inserted()).toBe(true);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("FROM notification_preferences"),
      ),
    ).toBe(false);
  });

  it("notifies when the project's organization cannot be resolved", async () => {
    const { pool, inserted } = fakePool({ organizationId: null, muted: true });
    const repository = new NotificationRepository(pool);

    await repository.create(createInput({}));

    expect(inserted()).toBe(true);
  });
});
