import { describe, expect, it, vi } from "vitest";
import {
  startScreenshotSweep,
  sweepExpiredScreenshots,
} from "./sweep.js";
import type { JobScreenshotRepository } from "./repository.js";

/**
 * Issue #22's retention sweep.
 *
 * The properties that matter are the operational ones: a failing sweep must not
 * take the process down, a slow sweep must not stack up, and the interval must
 * actually be running — a retention policy nothing enforces is a policy that is
 * silently false.
 */

function fakeRepository(purged = 0) {
  return {
    purgeExpired: vi.fn(async () => purged),
  } as unknown as JobScreenshotRepository;
}

describe("sweepExpiredScreenshots", () => {
  it("logs only when it reclaimed something", async () => {
    // A sweep that logs nothing when it does nothing keeps the log line
    // meaningful: seeing it means retention actually ran and found work.
    const lines: string[] = [];
    await sweepExpiredScreenshots(fakeRepository(0), (m) => lines.push(m));
    expect(lines).toHaveLength(0);

    await sweepExpiredScreenshots(fakeRepository(3), (m) => lines.push(m));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("reclaimed 3");
  });
});

describe("startScreenshotSweep", () => {
  it("runs immediately rather than waiting a full interval", async () => {
    // A fresh install should not wait 15 minutes to learn whether the sweep works.
    const repository = fakeRepository();
    const stop = startScreenshotSweep(repository, 60_000);
    try {
      await vi.waitFor(() => {
        expect(repository.purgeExpired).toHaveBeenCalled();
      });
    } finally {
      stop();
    }
  });

  it("keeps ticking on the interval", async () => {
    vi.useFakeTimers();
    const repository = fakeRepository();
    const stop = startScreenshotSweep(repository, 1_000);
    try {
      await vi.advanceTimersByTimeAsync(3_100);
      // Once for the immediate tick, plus three intervals.
      expect((repository.purgeExpired as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(4);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it("stops when the returned function is called", async () => {
    vi.useFakeTimers();
    const repository = fakeRepository();
    const stop = startScreenshotSweep(repository, 1_000);
    await vi.advanceTimersByTimeAsync(1_100);
    const before = (repository.purgeExpired as ReturnType<typeof vi.fn>).mock.calls.length;

    stop();
    await vi.advanceTimersByTimeAsync(5_000);

    try {
      expect((repository.purgeExpired as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows a failing sweep instead of taking the process down", async () => {
    // Retention being late is a storage cost; an exception escaping the ticker
    // would make every other request in the process fail.
    const lines: string[] = [];
    const repository = {
      purgeExpired: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    } as unknown as JobScreenshotRepository;

    const stop = startScreenshotSweep(repository, 60_000, (m) => lines.push(m));
    try {
      await vi.waitFor(() => {
        expect(lines.some((l) => l.includes("sweep failed"))).toBe(true);
      });
    } finally {
      stop();
    }
  });

  it("does not stack up when a sweep outlasts its interval", async () => {
    // Overlap is skipped rather than queued: a slow database must not accumulate
    // concurrent purges.
    vi.useFakeTimers();
    let inFlight = 0;
    let maxConcurrent = 0;
    const repository = {
      purgeExpired: vi.fn(async () => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        inFlight -= 1;
        return 0;
      }),
    } as unknown as JobScreenshotRepository;

    const stop = startScreenshotSweep(repository, 1_000);
    try {
      await vi.advanceTimersByTimeAsync(10_500);
    } finally {
      stop();
      vi.useRealTimers();
    }

    expect(maxConcurrent).toBe(1);
  });
});
