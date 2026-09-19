import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRILL_REPLY_TIMEOUT_MS,
  DEFAULT_SESSION_MAX_BYTES,
  GRILL_REPLY_TIMEOUT_ENV,
  appPublicRedirect,
  config,
  resolveGrillReplyTimeout,
  sessionMaxBytesFrom,
} from "./config.js";

describe("appPublicRedirect", () => {
  it("joins paths under APP_PUBLIC_URL without dropping the base path", () => {
    expect(appPublicRedirect("/login")).toBe("http://localhost:8080/app/login");
    expect(appPublicRedirect("/onboarding/confirm-username")).toBe(
      "http://localhost:8080/app/onboarding/confirm-username",
    );
    expect(appPublicRedirect("/")).toBe("http://localhost:8080/app");
  });

  it("appends query params", () => {
    const url = appPublicRedirect("/login", {
      error: "github_unlinked",
      github_login: "octocat",
    });
    expect(url).toBe(
      "http://localhost:8080/app/login?error=github_unlinked&github_login=octocat",
    );
  });
});

/**
 * Issue #92: the API mirrors a bound the Orchestrator owns, so this is the test
 * that keeps the mirror honest.
 *
 * The precedent is #63's, where `capabilities.DefaultReportInterval` (in the
 * Orchestrator) had to stay below the API's trust window: neither side's suite can
 * see the other repo, so the repo that owns one constant **declares the other's
 * value locally** and asserts the relationship. Here the relationship is equality
 * of defaults, and the Orchestrator's value lives at
 * `orchestrator/internal/worker/replytimeout.go` (`defaultReplyTimeout`).
 *
 * **What this does and does not catch.** It catches a *shipped default* drifting
 * on either side — if someone changes one and not the other, one repo's suite goes
 * red with a message naming the other repo. It cannot catch an operator setting
 * `GRILL_REPLY_TIMEOUT` on the Orchestrator only, because the API cannot read that
 * environment; that gap is why the read exposes `timeoutSource` instead of
 * asserting the value is authoritative. Both halves are stated in the module
 * comment rather than left for a reader to assume the test proves more.
 */
describe("the grill reply bound mirrors the Orchestrator's (#92)", () => {
  /*
   * The Orchestrator's default, transcribed. Spelled as the source value rather
   * than as `24 * 60 * 60 * 1000` so the two are visibly the same number written
   * the same way.
   */
  const orchestratorDefaultReplyTimeoutMs = 24 * 60 * 60 * 1000;

  it("ships the same default as the Orchestrator", () => {
    expect(DEFAULT_GRILL_REPLY_TIMEOUT_MS).toBe(orchestratorDefaultReplyTimeoutMs);
  });

  it("resolves to that default when the variable is unset", () => {
    // The suite sets no GRILL_REPLY_TIMEOUT, so this is the unset path. It is
    // asserted rather than assumed because the whole point of the mirror is that
    // an install which configures neither side still agrees with itself.
    expect(process.env[GRILL_REPLY_TIMEOUT_ENV]).toBeUndefined();
    expect(config.grills.replyTimeoutMs).toBe(orchestratorDefaultReplyTimeoutMs);
    expect(config.grills.replyTimeoutSource).toBe("default");
  });

  it("reads the same variable name the Orchestrator does", () => {
    // A different name would make the duplicate un-settable from one value, which
    // is the version of this that is indefensible rather than merely risky.
    expect(GRILL_REPLY_TIMEOUT_ENV).toBe("GRILL_REPLY_TIMEOUT");
  });

  /*
   * The configured half — reachable because the resolution is a function rather
   * than only a `config` property, and the half that matters: what a string an
   * operator writes actually resolves to, and whether the read will say it was
   * configured.
   */
  it("reads a configured value in Go's syntax and reports it as configured", () => {
    expect(resolveGrillReplyTimeout("48h")).toEqual({
      timeoutMs: 48 * 60 * 60 * 1000,
      source: "configured",
    });
    // Compound and sub-hour forms too, since the Orchestrator accepts them and
    // the whole point is that one value is copy-pasteable between the env files.
    expect(resolveGrillReplyTimeout("1h30m")).toEqual({
      timeoutMs: 5_400_000,
      source: "configured",
    });
    expect(resolveGrillReplyTimeout("90m")).toEqual({
      timeoutMs: 5_400_000,
      source: "configured",
    });
  });

  it("falls back to the default, and says so, for anything unusable", () => {
    // Every one of these is "not a bound this can honour", and the shared
    // response is the default *with the provenance flag set* — so a client is
    // never told an assumption is a configured fact. The Orchestrator resolves
    // all of them to its own default too, which is why the two agree here.
    for (const raw of [undefined, "", "   ", "3600", "1d", "1h30", "abc", "0", "0s", "-5m", "-1h"]) {
      expect(resolveGrillReplyTimeout(raw), String(raw)).toEqual({
        timeoutMs: DEFAULT_GRILL_REPLY_TIMEOUT_MS,
        source: "default",
      });
    }
  });
});

/**
 * ADR 032 item 4's session cap, and the trap it exists to avoid.
 *
 * The sibling config blocks parse with `Number(env) || default`, which **cannot
 * express zero**: `0 || 5_000_000` is the default, so `SESSION_MAX_BYTES=0` would
 * silently configure the cap it was meant to switch off. Item 4 requires zero to
 * mean "reclaim everything", so the value is parsed explicitly and this is the test
 * that proves the difference — it fails against the idiom, which is the point.
 */
describe("sessionMaxBytesFrom", () => {
  it("treats zero as the instruction it is, not as an absence", () => {
    expect(sessionMaxBytesFrom("0")).toBe(0);
    expect(sessionMaxBytesFrom(" 0 ")).toBe(0);
  });

  it("clamps a negative value to zero so the upload path and the sweep agree", () => {
    // `-1` and `0` must not mean different things to two readers of one setting.
    expect(sessionMaxBytesFrom("-1")).toBe(0);
    expect(sessionMaxBytesFrom("-99999")).toBe(0);
  });

  it("uses the default when the value is unset, empty or unparseable", () => {
    // The one case that *should* fall back: a typo must not switch collection off.
    for (const raw of [undefined, "", "   ", "abc", "5MB", "NaN", "Infinity"]) {
      expect(sessionMaxBytesFrom(raw), String(raw)).toBe(DEFAULT_SESSION_MAX_BYTES);
    }
  });

  it("keeps a real value, and floors a fractional one", () => {
    expect(sessionMaxBytesFrom("1000")).toBe(1000);
    expect(sessionMaxBytesFrom("1000.9")).toBe(1000);
  });

  it("matches the Orchestrator's own default cap", () => {
    // A cross-repo constant neither suite can see across: if the two disagree, the
    // API silently declines artifacts the Orchestrator considered within policy and
    // the only symptom is a 202 in the other service's log. The Orchestrator's
    // value lives at `orchestrator/internal/worker/sessions.go`
    // (`DefaultSessionMaxBytes`), and this asserts the equality so a change on
    // either side goes red here.
    expect(DEFAULT_SESSION_MAX_BYTES).toBe(5_000_000);
    expect(config.sessions.maxBytes).toBe(DEFAULT_SESSION_MAX_BYTES);
  });
});
