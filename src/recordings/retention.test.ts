import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECORDING_CONTENT_TYPE,
  exceedsSizeCap,
  formatByteSize,
  formatRetention,
  isSupportedContentType,
  recordingState,
  rejectUpload,
  resolveExpiry,
} from "./retention.js";

const NOW = new Date("2026-09-18T12:00:00.000Z");

function facts(overrides: Partial<Parameters<typeof recordingState>[0]> = {}) {
  return {
    expiresAt: new Date("2026-10-18T12:00:00.000Z"),
    purgedAt: null,
    hasData: true,
    ...overrides,
  };
}

describe("recordingState", () => {
  it("is available while bytes are held and the window is open", () => {
    expect(recordingState(facts(), NOW)).toBe("available");
  });

  it("expires exactly at expiry, not a millisecond after", () => {
    // The boundary is inclusive on both sides and must match the sweeper's
    // `expires_at <= NOW()`. If these drift, a recording is either a link that
    // 404s or bytes that are never reclaimed.
    expect(recordingState(facts({ expiresAt: NOW }), NOW)).toBe("expired");
  });

  it("is available one millisecond before expiry", () => {
    expect(
      recordingState(facts({ expiresAt: new Date(NOW.getTime() + 1) }), NOW),
    ).toBe("available");
  });

  it("is expired one millisecond after expiry", () => {
    expect(
      recordingState(facts({ expiresAt: new Date(NOW.getTime() - 1) }), NOW),
    ).toBe("expired");
  });

  it("is expired when the bytes are gone, even if the window is still open", () => {
    // A tombstone is expired regardless of its timestamp: the bytes are what
    // the user came for. This is what makes an early/manual purge safe.
    expect(
      recordingState(
        facts({ purgedAt: NOW, hasData: false, expiresAt: new Date("2030-01-01T00:00:00.000Z") }),
        NOW,
      ),
    ).toBe("expired");
  });

  it("treats a purged stamp without bytes as expired", () => {
    expect(recordingState(facts({ purgedAt: NOW, hasData: false }), NOW)).toBe(
      "expired",
    );
  });

  it("never reports available for a row with no bytes", () => {
    expect(
      recordingState(facts({ hasData: false, purgedAt: null }), NOW),
    ).toBe("expired");
  });
});

describe("resolveExpiry", () => {
  it("anchors to the recording's own creation, not to now", () => {
    const createdAt = new Date("2026-09-01T00:00:00.000Z");
    expect(resolveExpiry(createdAt, 30).toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("adds whole days", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    expect(resolveExpiry(createdAt, 1).toISOString()).toBe(
      "2026-01-02T00:00:00.000Z",
    );
  });

  it("stays correct across a DST transition", () => {
    // UTC arithmetic, so a window never becomes 23 or 25 hours long. This is
    // the same reason ADR 026's schedules are UTC.
    const createdAt = new Date("2026-03-08T00:00:00.000Z");
    expect(resolveExpiry(createdAt, 1).getTime() - createdAt.getTime()).toBe(
      86_400_000,
    );
  });

  it("stays correct across a leap day", () => {
    const createdAt = new Date("2028-02-28T00:00:00.000Z");
    expect(resolveExpiry(createdAt, 1).toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });
});

describe("exceedsSizeCap", () => {
  it("accepts a recording exactly at the cap", () => {
    // `>`, not `>=`: the configured number reads as "the largest recording you
    // may store" rather than one byte less than that.
    expect(exceedsSizeCap(25_000_000, 25_000_000)).toBe(false);
  });

  it("rejects one byte over the cap", () => {
    expect(exceedsSizeCap(25_000_001, 25_000_000)).toBe(true);
  });

  it("rejects everything non-empty when the cap is zero", () => {
    expect(exceedsSizeCap(1, 0)).toBe(true);
    expect(exceedsSizeCap(0, 0)).toBe(false);
  });

  it("rejects a non-finite size rather than storing it", () => {
    expect(exceedsSizeCap(Number.NaN, 25_000_000)).toBe(true);
    expect(exceedsSizeCap(Number.POSITIVE_INFINITY, 25_000_000)).toBe(true);
  });
});

describe("isSupportedContentType", () => {
  it("accepts the two playable formats", () => {
    expect(isSupportedContentType("video/webm")).toBe(true);
    expect(isSupportedContentType("video/mp4")).toBe(true);
  });

  it("rejects a format a browser cannot play in a video element", () => {
    // Storing one of these would produce a download that looks broken.
    expect(isSupportedContentType("video/quicktime")).toBe(false);
    expect(isSupportedContentType("application/octet-stream")).toBe(false);
    expect(isSupportedContentType("video/x-msvideo")).toBe(false);
  });

  it("defaults to webm, which is what Playwright itself writes", () => {
    expect(DEFAULT_RECORDING_CONTENT_TYPE).toBe("video/webm");
  });
});

describe("rejectUpload", () => {
  const base = { contentType: "video/webm", byteSize: 1_000, maxBytes: 25_000_000 };

  it("accepts a well-formed artifact", () => {
    expect(rejectUpload(base)).toBeNull();
  });

  it("names emptiness separately from size", () => {
    expect(rejectUpload({ ...base, byteSize: 0 })).toMatch(/empty/i);
  });

  it("reports the actual size alongside the limit", () => {
    const reason = rejectUpload({ ...base, byteSize: 30_000_000 });
    expect(reason).toContain("25 MB");
    expect(reason).toContain("30 MB");
  });

  it("names the offending format", () => {
    expect(rejectUpload({ ...base, contentType: "video/quicktime" })).toContain(
      "video/quicktime",
    );
  });

  it("prefers the size reason when both size and format are wrong", () => {
    // Size is the reason an operator is more likely to act on (raise the cap vs
    // fix a client), and a single reason is what the caller logs.
    expect(
      rejectUpload({ ...base, byteSize: 30_000_000, contentType: "video/quicktime" }),
    ).toMatch(/limit/i);
  });
});

describe("formatByteSize", () => {
  it("uses decimal units, matching how storage reports size", () => {
    expect(formatByteSize(999)).toBe("999 B");
    expect(formatByteSize(1_000)).toBe("1.0 kB");
    expect(formatByteSize(25_000_000)).toBe("25 MB");
  });

  it("keeps one decimal only while the number is small enough to need it", () => {
    expect(formatByteSize(1_500)).toBe("1.5 kB");
    expect(formatByteSize(15_000)).toBe("15 kB");
  });

  it("climbs to GB for a very large artifact", () => {
    expect(formatByteSize(2_500_000_000)).toBe("2.5 GB");
  });

  it("renders a non-value as a dash rather than NaN", () => {
    expect(formatByteSize(Number.NaN)).toBe("—");
    expect(formatByteSize(-1)).toBe("—");
  });
});

describe("formatRetention", () => {
  it("reads naturally for the common windows", () => {
    expect(formatRetention(1)).toBe("1 day");
    expect(formatRetention(30)).toBe("30 days");
    expect(formatRetention(365)).toBe("1 year");
    expect(formatRetention(730)).toBe("2 years");
  });
});
