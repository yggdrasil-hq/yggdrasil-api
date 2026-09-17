import { describe, expect, it, vi } from "vitest";
import { startRecordingSweep, sweepExpiredRecordings } from "./sweep.js";

function fakeRepo(purge: () => Promise<number>) {
  return { purgeExpired: vi.fn(purge) } as never as {
    purgeExpired: ReturnType<typeof vi.fn>;
  };
}

describe("sweepExpiredRecordings", () => {
  it("logs only when something was actually reclaimed", async () => {
    const log = vi.fn();
    const purged = await sweepExpiredRecordings(fakeRepo(async () => 0) as never, log);
    expect(purged).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  it("says how many artifacts it reclaimed", async () => {
    const log = vi.fn();
    const purged = await sweepExpiredRecordings(fakeRepo(async () => 4) as never, log);
    expect(purged).toBe(4);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("4"));
  });
});

describe("startRecordingSweep", () => {
  it("runs an immediate first pass so a restart does not defer retention", async () => {
    const repo = fakeRepo(async () => 1);
    const stop = startRecordingSweep(repo as never, 60_000, () => {});
    await vi.waitFor(() => expect(repo.purgeExpired).toHaveBeenCalled());
    stop();
  });

  it("keeps ticking on the interval", async () => {
    vi.useFakeTimers();
    try {
      const repo = fakeRepo(async () => 0);
      const stop = startRecordingSweep(repo as never, 1_000, () => {});
      await vi.advanceTimersByTimeAsync(3_000);
      stop();
      expect(repo.purgeExpired.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops when the returned function is called", async () => {
    vi.useFakeTimers();
    try {
      const repo = fakeRepo(async () => 0);
      const stop = startRecordingSweep(repo as never, 1_000, () => {});
      await vi.advanceTimersByTimeAsync(1_000);
      stop();
      const callsAfterStop = repo.purgeExpired.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(repo.purgeExpired.mock.calls.length).toBe(callsAfterStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows a failing sweep instead of taking the process down", async () => {
    // Retention being late is a storage cost; an exception escaping the ticker
    // would make every other request fail.
    const log = vi.fn();
    const repo = fakeRepo(async () => {
      throw new Error("database is on fire");
    });
    const stop = startRecordingSweep(repo as never, 60_000, log);
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    expect(log.mock.calls[0]![0]).toContain("database is on fire");
    stop();
  });

  it("does not stack passes when one runs longer than the interval", async () => {
    vi.useFakeTimers();
    try {
      let inFlight = 0;
      let maxInFlight = 0;
      const repo = fakeRepo(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        inFlight -= 1;
        return 0;
      });

      const stop = startRecordingSweep(repo as never, 1_000, () => {});
      await vi.advanceTimersByTimeAsync(10_000);
      stop();

      expect(maxInFlight).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
