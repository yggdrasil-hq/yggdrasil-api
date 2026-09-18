import { describe, expect, it, vi } from "vitest";
import {
  MAX_CANDIDATES_PER_TICK,
  runSchedulerTick,
  startScheduler,
} from "./scheduler.js";
import type { DueCandidate } from "./repository.js";
import { JobRepository as RealJobRepository } from "../jobs/repository.js";

/**
 * The fake client records every statement the tick issues, so the tests can
 * assert on the transaction shape (BEGIN/COMMIT/ROLLBACK, and the *order* of
 * the job insert relative to the `last_run_at` stamp) rather than only on
 * return values. No database is needed: everything the tick asks of Postgres is
 * a statement, and everything it *decides* is the pure module already covered
 * by cron.test.ts.
 */
interface Recorded {
  sql: string;
  params: unknown[];
}

function makeHarness(candidates: DueCandidate[], failOnInsert = false) {
  const recorded: Recorded[] = [];
  const released: number[] = [];

  // The fake returns rows in the shape Postgres would, so the real
  // `TestScheduleRepository.listCandidates` mapping is exercised rather than
  // bypassed — a camelCase fixture here would silently produce undefined
  // fields and make every test look "not due".
  const rows = candidates.map((candidate) => ({
    id: candidate.testId,
    project_id: candidate.projectId,
    schedule_cron: candidate.scheduleCron,
    last_run_at: candidate.lastRunAt,
    created_at: candidate.createdAt,
    model_config_warning: candidate.projectModelConfigWarning,
    github_access_warning: candidate.projectGithubAccessWarning,
  }));

  const client = {
    async query(sql: string, params: unknown[] = []) {
      recorded.push({ sql, params });
      if (/^\s*SELECT t\.id/.test(sql)) {
        return { rows };
      }
      if (/^\s*INSERT INTO jobs/.test(sql)) {
        if (failOnInsert) throw new Error("insert failed");
        return { rows: [{}] };
      }
      return { rows: [] };
    },
    release() {
      released.push(1);
    },
  };

  const pool = { connect: async () => client };
  // A real repository over the fake client, so the tick's job insert is the
  // actual `INSERT INTO jobs` SQL going through the actual code path, while
  // the spy still allows call-shape assertions.
  const jobs = new RealJobRepository(client as never);
  const createSpy = vi.spyOn(jobs, "create");

  return { pool, jobs, recorded, released, client, createSpy };
}

const NOW = new Date(Date.UTC(2026, 8, 17, 9, 0, 0));

function candidate(overrides: Partial<DueCandidate> = {}): DueCandidate {
  return {
    testId: "test-1",
    projectId: "project-1",
    scheduleCron: "0 9 * * *",
    lastRunAt: null,
    createdAt: new Date(Date.UTC(2026, 8, 1)),
    projectModelConfigWarning: false,
    projectGithubAccessWarning: false,
    scheduleTimeZone: null,
    ...overrides,
  };
}

describe("runSchedulerTick — dispatching", () => {
  it("dispatches a due test as a scheduled test_run on main", async () => {
    const harness = makeHarness([candidate()]);

    const result = await runSchedulerTick(
      { pool: harness.pool as never, jobs: harness.jobs },
      NOW,
    );

    expect(result).toEqual({
      candidates: 1,
      dispatched: 1,
      skippedProjectNotRunnable: 0,
      skippedNotDue: 0,
    });
    expect(harness.createSpy).toHaveBeenCalledTimes(1);
    expect(harness.createSpy).toHaveBeenCalledWith(
      {
        projectId: "project-1",
        kind: "test_run",
        testId: "test-1",
        ref: "main",
        trigger: "schedule",
      },
      expect.anything(),
    );
  });

  it("wraps the whole tick in one transaction, committing once", async () => {
    const harness = makeHarness([candidate()]);

    await runSchedulerTick({ pool: harness.pool as never, jobs: harness.jobs }, NOW);

    const statements = harness.recorded.map((entry) => entry.sql.trim());
    expect(statements[0]).toBe("BEGIN");
    expect(statements[statements.length - 1]).toBe("COMMIT");
    expect(statements).not.toContain("ROLLBACK");
  });

  it("stamps last_run_at after creating the job, in the same transaction", async () => {
    const harness = makeHarness([candidate()]);

    await runSchedulerTick({ pool: harness.pool as never, jobs: harness.jobs }, NOW);

    const order = harness.recorded.map((entry) => entry.sql.trim()).join("\n");
    expect(order.indexOf("INSERT INTO jobs")).toBeGreaterThan(-1);
    expect(order.indexOf("UPDATE tests")).toBeGreaterThan(
      order.indexOf("INSERT INTO jobs"),
    );
    // The tick's single instant is what gets stamped, not a second clock read.
    const update = harness.recorded.find((entry) => /UPDATE tests/.test(entry.sql));
    expect(update?.params).toEqual(["test-1", NOW]);
  });

  it("bounds the candidate query and passes the tick's instant to it", async () => {
    const harness = makeHarness([]);

    await runSchedulerTick({ pool: harness.pool as never, jobs: harness.jobs }, NOW);

    const select = harness.recorded.find((entry) => /^\s*SELECT t\.id/.test(entry.sql));
    expect(select?.params).toEqual([NOW, MAX_CANDIDATES_PER_TICK]);
    expect(select?.sql).toContain("FOR UPDATE OF t SKIP LOCKED");
  });

  it("releases the client whether the tick succeeds or fails", async () => {
    const ok = makeHarness([candidate()]);
    await runSchedulerTick({ pool: ok.pool as never, jobs: ok.jobs }, NOW);
    expect(ok.released).toHaveLength(1);

    const bad = makeHarness([candidate()], true);
    await expect(
      runSchedulerTick({ pool: bad.pool as never, jobs: bad.jobs }, NOW),
    ).rejects.toThrow("insert failed");
    expect(bad.released).toHaveLength(1);
  });
});

describe("runSchedulerTick — what it does not dispatch", () => {
  it("skips a test whose schedule is not yet due", async () => {
    const harness = makeHarness([
      // Daily 09:00, last ran at today's 09:00 — the next window is tomorrow.
      candidate({ lastRunAt: NOW }),
    ]);

    const result = await runSchedulerTick(
      { pool: harness.pool as never, jobs: harness.jobs },
      NOW,
    );

    expect(result).toEqual({
      candidates: 1,
      dispatched: 0,
      skippedProjectNotRunnable: 0,
      skippedNotDue: 1,
    });
    expect(harness.createSpy).not.toHaveBeenCalled();
    const order = harness.recorded.map((entry) => entry.sql.trim());
    expect(order).toContain("COMMIT");
    expect(order.some((sql) => /UPDATE tests/.test(sql))).toBe(false);
  });

  it("does not fire a freshly created test for a window that predates it", async () => {
    const harness = makeHarness([
      candidate({
        createdAt: new Date(Date.UTC(2026, 8, 17, 9, 30)),
        lastRunAt: null,
      }),
    ]);

    const result = await runSchedulerTick(
      { pool: harness.pool as never, jobs: harness.jobs },
      NOW,
    );

    expect(result.skippedNotDue).toBe(1);
    expect(harness.createSpy).not.toHaveBeenCalled();
  });

  it("never dispatches a test whose cron cannot be parsed", async () => {
    const harness = makeHarness([candidate({ scheduleCron: "0 0 * * MON" })]);

    const result = await runSchedulerTick(
      { pool: harness.pool as never, jobs: harness.jobs },
      NOW,
    );

    expect(result.skippedNotDue).toBe(1);
    expect(harness.createSpy).not.toHaveBeenCalled();
  });

  it("skips a project with a model-config warning and leaves it overdue", async () => {
    const harness = makeHarness([candidate({ projectModelConfigWarning: true })]);

    const result = await runSchedulerTick(
      { pool: harness.pool as never, jobs: harness.jobs },
      NOW,
    );

    expect(result).toEqual({
      candidates: 1,
      dispatched: 0,
      skippedProjectNotRunnable: 1,
      skippedNotDue: 0,
    });
    expect(harness.createSpy).not.toHaveBeenCalled();
    // Critically: last_run_at is NOT advanced, so the run happens as soon as
    // the operator clears the warning instead of being silently dropped.
    expect(
      harness.recorded.some((entry) => /UPDATE tests/.test(entry.sql)),
    ).toBe(false);
  });

  it("skips a project with a GitHub-access warning", async () => {
    const harness = makeHarness([candidate({ projectGithubAccessWarning: true })]);

    const result = await runSchedulerTick(
      { pool: harness.pool as never, jobs: harness.jobs },
      NOW,
    );

    expect(result.skippedProjectNotRunnable).toBe(1);
    expect(harness.createSpy).not.toHaveBeenCalled();
  });

  it("dispatches the runnable tests while skipping a blocked one in the same tick", async () => {
    const harness = makeHarness([
      candidate({ testId: "blocked", projectModelConfigWarning: true }),
      candidate({ testId: "fine" }),
    ]);

    const result = await runSchedulerTick(
      { pool: harness.pool as never, jobs: harness.jobs },
      NOW,
    );

    expect(result.dispatched).toBe(1);
    expect(result.skippedProjectNotRunnable).toBe(1);
    expect(harness.createSpy).toHaveBeenCalledTimes(1);
    expect(harness.createSpy.mock.calls[0][0]).toMatchObject({ testId: "fine" });
  });

  it("is a no-op when nothing is enabled or due", async () => {
    const harness = makeHarness([]);

    const result = await runSchedulerTick(
      { pool: harness.pool as never, jobs: harness.jobs },
      NOW,
    );

    expect(result).toEqual({
      candidates: 0,
      dispatched: 0,
      skippedProjectNotRunnable: 0,
      skippedNotDue: 0,
    });
    expect(harness.createSpy).not.toHaveBeenCalled();
    expect(harness.recorded.map((e) => e.sql.trim())).toEqual([
      "BEGIN",
      expect.any(String),
      "COMMIT",
    ]);
  });
});

describe("runSchedulerTick — failure handling", () => {
  it("rolls back and rethrows when creating the job fails", async () => {
    const harness = makeHarness([candidate()], true);

    await expect(
      runSchedulerTick({ pool: harness.pool as never, jobs: harness.jobs }, NOW),
    ).rejects.toThrow("insert failed");

    const statements = harness.recorded.map((entry) => entry.sql.trim());
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("rolls back and rethrows when the candidate query fails", async () => {
    const recorded: string[] = [];
    const client = {
      async query(sql: string) {
        recorded.push(sql.trim());
        if (/^\s*SELECT t\.id/.test(sql)) throw new Error("connection lost");
        return { rows: [] };
      },
      release() {},
    };

    await expect(
      runSchedulerTick(
        { pool: { connect: async () => client } as never, jobs: { create: vi.fn() } as never },
        NOW,
      ),
    ).rejects.toThrow("connection lost");

    expect(recorded).toEqual(["BEGIN", expect.stringContaining("SELECT"), "ROLLBACK"]);
  });
});

describe("startScheduler", () => {
  it("returns a stop function that halts the interval", () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness([]);
      const stop = startScheduler(
        { pool: harness.pool as never, jobs: harness.jobs },
        1000,
        () => {},
      );
      stop();
      vi.advanceTimersByTime(5000);
      // No tick ran: the first statement of any tick is always BEGIN.
      expect(harness.recorded).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips an overlap instead of stacking ticks", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness([]);
      const log = vi.fn();
      // Hold the first tick open by never resolving its BEGIN.
      let releaseFirst: (() => void) | undefined;
      const client = {
        query: vi.fn(async (sql: string) => {
          if (sql.trim() === "BEGIN") {
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
          }
          return { rows: [] };
        }),
        release() {},
      };
      const pool = { connect: async () => client };

      const stop = startScheduler({ pool: pool as never, jobs: harness.jobs }, 1000, log);

      await vi.advanceTimersByTimeAsync(1000); // tick 1 starts and stalls
      await vi.advanceTimersByTimeAsync(3000); // two more intervals elapse
      expect(log).toHaveBeenCalledWith(
        "scheduler: previous tick still running, skipping this interval",
      );
      expect(client.query.mock.calls.filter(([sql]) => sql.trim() === "BEGIN")).toHaveLength(1);

      releaseFirst?.();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs and survives a failing tick rather than crashing the process", async () => {
    vi.useFakeTimers();
    try {
      const log = vi.fn();
      const client = {
        query: vi.fn(async (sql: string) => {
          if (sql.trim() === "BEGIN") throw new Error("db down");
          return { rows: [] };
        }),
        release() {},
      };
      const stop = startScheduler(
        { pool: { connect: async () => client } as never, jobs: { create: vi.fn() } as never },
        1000,
        log,
      );

      await vi.advanceTimersByTimeAsync(1000);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("db down"));
      // The interval is still armed, so the next tick gets a chance.
      await vi.advanceTimersByTimeAsync(1000);
      expect(log.mock.calls.length).toBeGreaterThanOrEqual(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays quiet when a tick dispatches nothing", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness([]);
      const log = vi.fn();
      const stop = startScheduler(
        { pool: harness.pool as never, jobs: harness.jobs },
        1000,
        log,
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(log).not.toHaveBeenCalled();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports how many runs it dispatched", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness([candidate()]);
      const log = vi.fn();
      const stop = startScheduler(
        { pool: harness.pool as never, jobs: harness.jobs },
        1000,
        log,
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(log).toHaveBeenCalledWith(
        "scheduler: dispatched 1 scheduled test run(s)",
      );
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
