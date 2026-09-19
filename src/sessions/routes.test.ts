import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createSessionsRouter } from "./routes.js";
import type { JobForkPoints, JobSession, JobSessionContent } from "./types.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_JOB_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_COOKIE = "yggdrasil_session=sess_1";

const NOW = Date.now();

function makeSession(overrides: Partial<JobSession> = {}): JobSession {
  return {
    jobId: JOB_ID,
    projectId: PROJECT_ID,
    outcome: "collected",
    sessionId: "s-1",
    podFilePath: "/root/.pi/agent/sessions/x.jsonl",
    byteSize: 4_200,
    expiresAt: new Date(NOW + 30 * 86_400_000),
    purgedAt: null,
    createdAt: new Date(NOW - 60_000),
    ...overrides,
  };
}

function buildApp(
  overrides: {
    memberProjectId?: string | null;
    session?: JobSession | null;
    content?: JobSessionContent | null;
    jobFound?: boolean;
    forkPoints?: JobForkPoints | null;
  } = {},
) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const memberProjectId =
    overrides.memberProjectId === undefined ? PROJECT_ID : overrides.memberProjectId;
  const jobFound = overrides.jobFound !== false;

  const users = { findById: vi.fn(async () => ({ id: USER_ID })) };
  const sessions = {
    findValid: vi.fn(async () => ({ id: "sess_1", userId: USER_ID })),
    touch: vi.fn(async () => undefined),
  };
  const projects = {
    findByIdForUser: vi.fn(async (projectId: string) =>
      memberProjectId === projectId ? { id: projectId } : null,
    ),
  };
  const jobs = {
    findByIdForProject: vi.fn(async (_projectId: string, jobId: string) =>
      jobFound && jobId === JOB_ID ? { id: jobId, projectId: PROJECT_ID } : null,
    ),
  };
  const jobSessions = {
    findByJob: vi.fn(async () =>
      overrides.session === undefined ? makeSession() : overrides.session,
    ),
    findContent: vi.fn(async () => overrides.content ?? null),
    // ADR 032 item 2. Defaulted to **null** rather than to a captured-empty record,
    // because null is `unknown` — the state a run with no fork-point report is in —
    // and a double that defaulted to `captured: []` would let every test pass while
    // asserting the opposite of the distinction this field exists for.
    findForkPoints: vi.fn(async () => overrides.forkPoints ?? null),
  };

  app.use(
    "/projects",
    createSessionsRouter({
      users: users as never,
      sessions: sessions as never,
      projects: projects as never,
      jobs: jobs as never,
      jobSessions: jobSessions as never,
    }),
  );

  return { app, jobSessions, projects, jobs };
}

function get(app: express.Express, path: string) {
  return request(app).get(path).set("Cookie", SESSION_COOKIE);
}

const url = `/projects/${PROJECT_ID}/jobs/${JOB_ID}/session`;
const contentUrl = `${url}/content`;

describe("GET /projects/:projectId/jobs/:jobId/session (ADR 032 item 5)", () => {
  it("reports an available session and says a fork is possible", async () => {
    const { app } = buildApp();
    const res = await get(app, url);

    expect(res.status).toBe(200);
    expect(res.body.session.state).toBe("available");
    expect(res.body.session.canFork).toBe(true);
    expect(res.body.session.outcome).toBe("collected");
    expect(res.body.session.sessionId).toBe("s-1");
    // The pod path is evidence for an operator, not a storage key, and it is
    // deliberately *not* exported: the key is derived here from the job id, and
    // handing a caller a path that stopped existing with the pod would invite a
    // reader to treat it as addressable.
    expect(res.body.session.podFilePath).toBeUndefined();
  });

  /**
   * The three failing states must be told apart **to the user**, not only in the
   * database — that is the whole of item 5, and a single sentence for all of them
   * would undo it.
   */
  it("gives each non-available state its own wording, and no two alike", async () => {
    const cases = [
      { session: makeSession({ outcome: "not_collected", sessionId: null, byteSize: null, expiresAt: null }), state: "not_collected" },
      { session: makeSession({ outcome: "unavailable", sessionId: null, byteSize: null, expiresAt: null }), state: "unavailable" },
      { session: makeSession({ purgedAt: new Date() }), state: "expired" },
      { session: makeSession({ expiresAt: new Date(Date.now() - 1000) }), state: "expired" },
      { session: null, state: "unknown" },
    ];

    const explanations = new Set<string>();
    for (const testCase of cases) {
      const { app } = buildApp({ session: testCase.session });
      const res = await get(app, url);
      expect(res.status).toBe(200);
      expect(res.body.session.state).toBe(testCase.state);
      expect(res.body.session.canFork).toBe(false);
      explanations.add(res.body.explanation as string);
    }

    // `not_collected` and `unavailable` are the pair item 5 exists for; the other
    // three are distinct as well. Four distinct sentences for five states is
    // deliberate: the two *expiry* routes to `expired` are the same fact and must
    // read the same way.
    expect(explanations.size).toBe(4);
  });

  it("calls no row 'unknown' rather than claiming the run produced no session", async () => {
    // An install with collection switched off writes no row at all, so describing
    // that as "this run did not save a session" would blame the run for a
    // configuration choice.
    const { app } = buildApp({ session: null });
    const res = await get(app, url);

    expect(res.body.session.state).toBe("unknown");
    expect(res.body.session.outcome).toBeNull();
    expect(res.body.session.byteSize).toBeNull();
    expect(res.body.explanation).not.toContain("did not save");
  });

  it("404s for a job in another project, and for an unknown job", async () => {
    const otherProject = await get(
      buildApp({ memberProjectId: OTHER_PROJECT_ID }).app,
      url,
    );
    expect(otherProject.status).toBe(404);

    const unknownJob = await get(buildApp().app, `/projects/${PROJECT_ID}/jobs/${OTHER_JOB_ID}/session`);
    expect(unknownJob.status).toBe(404);
  });

  it("404s for a malformed id rather than querying", async () => {
    const { app, jobSessions } = buildApp();
    const res = await get(app, `/projects/${PROJECT_ID}/jobs/not-a-uuid/session`);

    expect(res.status).toBe(404);
    expect(jobSessions.findByJob).not.toHaveBeenCalled();
  });

  it("requires a session cookie", async () => {
    const { app } = buildApp();
    const res = await request(app).get(url);
    expect(res.status).toBe(401);
  });
});

describe("GET /projects/:projectId/jobs/:jobId/session/content", () => {
  it("streams the bytes with a private cache and no sniffing", async () => {
    const data = Buffer.from('{"type":"user"}\n');
    const { app } = buildApp({ content: { ...makeSession(), data } });
    const res = await get(app, contentUrl);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    expect(res.headers["cache-control"]).toBe("private, max-age=300");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    // `attachment`, unlike a recording's `inline`: a session is raw JSONL that no
    // browser renders, so the useful behaviour is to save it.
    expect(res.headers["content-disposition"]).toBe("attachment");
    expect(res.text).toBe(data.toString());
  });

  /**
   * 410 versus 404 is load-bearing: an expired session was *stored*, so it is
   * finished rather than missing. Conflating them renders a reclaimed artifact as a
   * broken link with no explanation.
   */
  it("410s a reclaimed session and names the reason", async () => {
    const { app } = buildApp({
      content: { ...makeSession({ purgedAt: new Date() }), data: null },
    });
    const res = await get(app, contentUrl);

    expect(res.status).toBe(410);
    expect(res.body.error).toContain("retention window");
  });

  it("410s a session past its window even before the sweep runs", async () => {
    const { app } = buildApp({
      content: {
        ...makeSession({ expiresAt: new Date(Date.now() - 1000) }),
        data: Buffer.from("x"),
      },
    });
    expect((await get(app, contentUrl)).status).toBe(410);
  });

  it("404s a failing outcome, using its own wording rather than the retention one", async () => {
    for (const outcome of ["not_collected", "unavailable"] as const) {
      const { app } = buildApp({
        content: {
          ...makeSession({ outcome, sessionId: null, byteSize: null, expiresAt: null }),
          data: null,
        },
      });
      const res = await get(app, contentUrl);

      expect(res.status).toBe(404);
      // A failing outcome is not a tombstone, so it must not be described as
      // "removed after its retention window".
      expect(res.body.error).not.toContain("retention");
      expect(res.body.error).toContain(
        outcome === "not_collected" ? "did not save" : "could not be retrieved",
      );
    }
  });

  it("404s when nothing was ever stored", async () => {
    const { app } = buildApp({ content: null });
    expect((await get(app, contentUrl)).status).toBe(404);
  });
});

/**
 * ADR 032 items 2/3's read side (#103): the fork points, and the distinction between
 * "there are none" and "we could not find out".
 *
 * This is the user-facing half of the honesty requirement, which is why it gets its
 * own block: the state is what a page renders, and rendering an empty list for an
 * unanswered question tells a user there is nothing to resume from on the strength of
 * a question nobody asked.
 */
describe("GET .../session fork points (#103)", () => {
  it("reports no fork-point record as unknown, not as an answered empty list", async () => {
    const { app } = buildApp({ forkPoints: null });
    const res = await get(app, url);

    expect(res.status).toBe(200);
    // `unknown` and `captured: []` are different claims, and the default double
    // returns null precisely so this cannot pass by accident.
    expect(res.body.session.forkPoints.state).toBe("unknown");
    expect(res.body.session.forkPoints.points).toBeNull();
    // ...and the wording says so, rather than borrowing the "none" case's.
    expect(res.body.forkPointsExplanation).toContain("No resumable points were reported");
  });

  it("reports captured points, keeping Pi's order", async () => {
    const points = [
      { entryId: "a1b2c3d4", text: "First reply" },
      { entryId: "c3d4e5f6", text: "Second reply" },
    ];
    const { app } = buildApp({
      forkPoints: {
        jobId: JOB_ID,
        state: "captured",
        outcome: "captured",
        points,
        capturedAt: new Date(),
      },
    });
    const res = await get(app, url);

    expect(res.body.session.forkPoints.state).toBe("captured");
    expect(res.body.session.forkPoints.points).toEqual(points);
  });

  it("reports an answered empty list as captured with nothing, not as unavailable", async () => {
    const { app } = buildApp({
      forkPoints: {
        jobId: JOB_ID,
        state: "captured",
        outcome: "captured",
        points: [],
        capturedAt: new Date(),
      },
    });
    const res = await get(app, url);

    expect(res.body.session.forkPoints.state).toBe("captured");
    expect(res.body.session.forkPoints.points).toEqual([]);
  });

  it("reports an unanswered capture as unavailable, with its own wording", async () => {
    const { app } = buildApp({
      forkPoints: {
        jobId: JOB_ID,
        state: "unavailable",
        outcome: "unavailable",
        points: null,
        capturedAt: new Date(),
      },
    });
    const res = await get(app, url);

    expect(res.body.session.forkPoints.state).toBe("unavailable");
    expect(res.body.forkPointsExplanation).toContain("could not be determined");
  });
});
