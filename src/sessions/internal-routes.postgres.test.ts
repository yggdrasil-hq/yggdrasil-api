import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import request from "supertest";
import { createApp } from "../app.js";
import { config } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { createObjectStorage } from "../storage/client.js";
import { livePostgresSkipWarning, probeLivePostgres } from "../testing/live-postgres.js";
import { JobSessionRepository } from "./repository.js";

/**
 * ADR 032 item 1's upload route, driven through the **real app** against a **real
 * Postgres** — the seam between the Orchestrator's writer and this reader.
 *
 * **Why this file exists when `internal-routes.test.ts` already covers the route.**
 * That file builds a bare router with a fake repository, which cannot tell whether
 * the route is *mounted* on the app, whether the internal bearer gate passes, or
 * whether the raw body parser is wired to the content type the Orchestrator sends.
 * Issue #56 was exactly that: four routes whose units passed and which 404'd in
 * production because the composition was wrong. `routes-resolve.test.ts` guards the
 * paths the Web client calls, and it asserts routing only — a 401 proves the route
 * matched, not that a real upload succeeds. This closes the remaining half.
 *
 * **It also answers a question the Orchestrator's own suite cannot.** Its
 * `TestPostJobSession_TreatsAMissingRouteAsAnError` uses a fake server that always
 * answers 404, so it tests the *client's* handling of a missing route and can never
 * flip to asserting a 201 when the route lands. Whether the two halves now meet is
 * a claim about *this* service, so it is checked here: a real POST of the
 * Orchestrator's exact wire shape, through the real app, against the real database,
 * asserting the row it produced.
 *
 * The bytes and the query parameters are the writer's own: `?outcome=`, `?sessionId=`,
 * `?podFilePath=`, and the body as raw JSONL with `Content-Type: application/x-ndjson`
 * (`apiclient.PostJobSession`).
 *
 * **Why the backend is asserted as a relationship rather than as a value.** Whether
 * a session lands in the `data` column or in the object store is decided by
 * *configuration*, and the three environments this file runs in disagree about it
 * (issue #106):
 *
 * | environment | Postgres | MinIO | what this file does |
 * |---|---|---|---|
 * | `docker compose … up` | unreachable (a VPN mesh shadows the compose subnet — see `testing/live-postgres.ts`) | unreachable | **skipped** |
 * | `scripts/test-against-real-db.sh` | reachable (host network, dev Postgres) | not published to the host | runs, takes the **postgres** path |
 * | CI | reachable | reachable | runs, takes the **object** path |
 *
 * A hardcoded `expect(row.storage_backend).toBe("postgres")` here was an
 * *environment* assertion wearing an invariant's clothes. It held in the two
 * environments the work was normally checked in and failed in the only one nobody
 * was watching, which is how it went red on CI for two commits without being
 * noticed — the same class as #97 and #102, a check that cannot fail where it is
 * usually run. What is asserted instead is the durable property (the bytes come
 * back, read through the same method the download route uses) and the relationship
 * that holds in *both* backends: exactly one of `data` / `object_key` carries the
 * bytes, and it is the one `storage_backend` names — the table's own `CHECK`.
 *
 * Skipping is loud rather than silent — see `testing/live-postgres.ts`.
 */

const connectionString = process.env.DATABASE_URL ?? "";

const reachability = await probeLivePostgres(connectionString);

if (!reachability.ok) {
  console.warn(
    livePostgresSkipWarning({
      label: "session-upload-route",
      probe: reachability,
      unverified:
        "that the Orchestrator's session upload reaches the real route through the real " +
        "app — the internal bearer gate, the raw parser at the session content type, and " +
        "the row it writes — rather than only through a router mounted in isolation",
    }),
  );
}

describe.skipIf(!reachability.ok)(
  "POST /internal/jobs/:jobId/session through the real app and a real Postgres",
  () => {
    let pool: pg.Pool;
    let projectId: string;
    let jobId: string;
    let app: ReturnType<typeof createApp>;
    let sessions: JobSessionRepository;

    const bytes = Buffer.from(
      '{"type":"user","id":"e1","text":"hello"}\n{"type":"assistant","id":"e2"}\n',
    );

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString });
      await runMigrations(pool);
      // The real app, exactly as `index.ts` builds it: this is the composition the
      // Orchestrator's call has to survive.
      app = createApp({ pool });
      // A **second, independent reader**, built from the same expression `app.ts`
      // builds its own from, so reading a session back has to go to the durable
      // store rather than to anything the upload happened to leave in the app's
      // process. It also means this file exercises whichever backend the
      // configuration selects instead of only the one the environment supplies.
      sessions = new JobSessionRepository(
        pool,
        createObjectStorage(config.storage.configured ? config.storage : null),
      );

      const stamp = Date.now();
      const userId = (
        await pool.query(
          `INSERT INTO users (username, display_name, github_id, github_login)
           VALUES ($1, 'I28R', $2, $1) RETURNING id`,
          [`i28r_${stamp}`, stamp],
        )
      ).rows[0].id;
      const orgId = (
        await pool.query(
          `INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING id`,
          [`i28r-org-${stamp}`],
        )
      ).rows[0].id;
      projectId = (
        await pool.query(
          `INSERT INTO projects (owner_user_id, organization_id, name, slug, status)
           VALUES ($1, $2, 'I28R', $3, 'ready') RETURNING id`,
          [userId, orgId, `i28r-${stamp}`],
        )
      ).rows[0].id;
      jobId = (
        await pool.query(
          `INSERT INTO jobs (project_id, kind, status)
           VALUES ($1, 'spec_grill', 'completed') RETURNING id`,
          [projectId],
        )
      ).rows[0].id;
    });

    afterAll(async () => {
      await pool
        .query("DELETE FROM projects WHERE id = $1", [projectId])
        .catch(() => undefined);
      await pool.end().catch(() => undefined);
    });

    function post(query: string) {
      return request(app)
        .post(`/internal/jobs/${jobId}/session?${query}`)
        .set("Authorization", `Bearer ${config.internalApiToken}`)
        .set("Content-Type", "application/x-ndjson");
    }

    it("201s the Orchestrator's exact shape, and the row it wrote is readable", async () => {
      const res = await post(
        "outcome=collected&sessionId=s-real&podFilePath=%2Froot%2Fsessions%2Fx.jsonl",
      ).send(bytes);

      expect(res.status).toBe(201);
      expect(res.body.stored).toBe(true);
      expect(res.body.session.state).toBe("available");
      expect(res.body.session.canFork).toBe(true);

      // Read straight from the table: the claim is about what Postgres holds, not
      // about the response the handler composed.
      const row = (
        await pool.query(
          `SELECT outcome, session_id, pod_file_path, byte_size, storage_backend,
                  data, object_key, expires_at, purged_at
             FROM job_sessions WHERE job_id = $1`,
          [jobId],
        )
      ).rows[0];

      expect(row.outcome).toBe("collected");
      expect(row.session_id).toBe("s-real");
      expect(row.pod_file_path).toBe("/root/sessions/x.jsonl");
      // Measured by the API from the body it received — the wire contract has no
      // size field on purpose, because a value sent alongside could disagree with
      // the bytes it describes.
      expect(row.byte_size).toBe(bytes.byteLength);
      // Where the bytes live is configuration, not a constant — CI has MinIO
      // reachable and the local runs do not — so this asserts the code agrees with
      // the configuration it reads rather than pinning one backend. A repository
      // that ignored its storage would still be caught: the row would say
      // `postgres` while the config said object.
      expect(row.storage_backend).toBe(config.storage.configured ? "object" : "postgres");
      // Exactly one home, and it is the one the backend names. This is the table's
      // own CHECK restated as the relationship that is true in both backends, so it
      // does not encode which environment is running.
      //
      // Both halves are asserted as present-ness *and* absence rather than only
      // absence, because a column missing from the SELECT above reads as
      // `undefined` and `expect(undefined).not.toBeNull()` passes — which is how the
      // first version of this check looked green on the object path for entirely the
      // wrong reason.
      const [inBackend, inColumn] =
        row.storage_backend === "object" ? [row.object_key, row.data] : [row.data, row.object_key];
      expect(inBackend).toBeDefined();
      expect(inBackend).not.toBeNull();
      expect(inColumn).toBeNull();
      expect(row.purged_at).toBeNull();
      expect(row.expires_at).not.toBeNull();

      // The durable property this test is really about: what was posted comes back
      // byte for byte, through the reader the Web download route calls
      // (`sessions/routes.ts` → `findContent`). Asserting the row's columns alone
      // would miss a reader that cannot reach the bytes it stored, which is the
      // failure the object backend makes possible and the postgres one cannot.
      const readBack = await sessions.findContent(jobId);
      expect(readBack?.data).not.toBeNull();
      expect(Buffer.compare(readBack!.data!, bytes)).toBe(0);
    });

    it("rejects the upload without the internal bearer token", async () => {
      const res = await request(app)
        .post(`/internal/jobs/${jobId}/session?outcome=collected`)
        .set("Content-Type", "application/x-ndjson")
        .send(Buffer.from("x"));

      // 401, not 404: the route is mounted and its gate ran. Distinguished from the
      // missing-route case deliberately — a 404 here would mean the composition is
      // wrong, which is the failure this file exists to catch.
      expect(res.status).toBe(401);
    });

    it("records an unavailable outcome with no bytes, keeping it distinct in the row", async () => {
      const otherJob = (
        await pool.query(
          `INSERT INTO jobs (project_id, kind, status)
           VALUES ($1, 'spec_grill', 'completed') RETURNING id`,
          [projectId],
        )
      ).rows[0].id as string;

      const res = await request(app)
        .post(`/internal/jobs/${otherJob}/session?outcome=unavailable`)
        .set("Authorization", `Bearer ${config.internalApiToken}`)
        .set("Content-Type", "application/x-ndjson")
        .send(Buffer.alloc(0));

      expect(res.status).toBe(201);

      const row = (
        await pool.query(
          `SELECT outcome, byte_size, data, object_key, expires_at, purged_at
             FROM job_sessions WHERE job_id = $1`,
          [otherJob],
        )
      ).rows[0];

      // The distinction item 5 is about, surviving the whole path: a row exists, it
      // says `unavailable` rather than `not_collected`, and it holds nothing.
      expect(row.outcome).toBe("unavailable");
      expect(row.byte_size).toBeNull();
      expect(row.data).toBeNull();
      expect(row.object_key).toBeNull();
      expect(row.expires_at).toBeNull();
      expect(row.purged_at).toBeNull();
    });
  },
);
