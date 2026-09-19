import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GRILL_REPLY_TIMEOUT_MS,
  DEFAULT_LIVE_DELTA_BYTES_PER_JOB,
  DEFAULT_RECORDING_MAX_BYTES,
  DEFAULT_SCREENSHOT_MAX_BYTES,
  DEFAULT_SCREENSHOT_MAX_PER_JOB,
  DEFAULT_SESSION_MAX_BYTES,
  GRILL_REPLY_TIMEOUT_ENV,
  appPublicRedirect,
  config,
  limitFrom,
  resolveGrillReplyTimeout,
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
 * Issue #104: a value of zero is an *instruction*, not an absence — and the rule is
 * tested in two halves because they fail differently.
 *
 * `limitFrom` is the rule. Before it there were three copies of it: `SESSION_MAX_BYTES`
 * accepted zero, `RECORDING_MAX_BYTES` and `LIVE_DELTA_BYTES_PER_JOB` were both
 * documented to and did not, and nothing failed to say so — the idiom they used,
 * `Number(env) || default`, cannot express zero at all. So the first block proves the
 * rule, and the second proves each cap actually reaches it with its own default; a
 * correct parser nobody calls is this burn-down's "looks finished, does nothing" shape.
 */
describe("limitFrom: an integer limit where zero is a value, not an absence (#104)", () => {
  // A fallback with no other reason to be this number, so a test that confuses the
  // fallback for the parsed value cannot pass by coincidence.
  const FALLBACK = 25_000_000;

  it("treats zero as the instruction it is", () => {
    expect(limitFrom("0", FALLBACK)).toBe(0);
    expect(limitFrom(" 0 ", FALLBACK)).toBe(0);
  });

  it("clamps a negative value to zero so two readers of one setting agree", () => {
    // `-1` and `0` must not mean different things to the upload path and the sweep.
    expect(limitFrom("-1", FALLBACK)).toBe(0);
    expect(limitFrom("-99999", FALLBACK)).toBe(0);
  });

  it("uses the fallback when the value is unset, empty or unparseable", () => {
    // The one case that *should* fall back: a typo must not switch a feature off.
    for (const raw of [undefined, "", "   ", "abc", "5MB", "NaN", "Infinity"]) {
      expect(limitFrom(raw, FALLBACK), String(raw)).toBe(FALLBACK);
    }
  });

  it("keeps a real value, and floors a fractional one", () => {
    // These are bytes and counts; `4096.5` bytes is not a size a comparison can
    // mean anything with, so it resolves to the same value as `4096`.
    expect(limitFrom("1000", FALLBACK)).toBe(1000);
    expect(limitFrom("1000.9", FALLBACK)).toBe(1000);
  });
});

/**
 * The wiring half: every cap reads its own environment variable through `limitFrom`,
 * and keeps its own default.
 *
 * **Why these re-import the module.** `config` is a single object built once at
 * import, so asserting on the imported binding only ever observes whatever this
 * process was started with. Setting a variable and importing again is the only way to
 * observe the parse rule *through* the wiring rather than beside it.
 */
describe("every cap reaches zero, and keeps its own default (#104)", () => {
  const caps = [
    {
      env: "RECORDING_MAX_BYTES",
      read: (c: typeof config) => c.recordings.maxBytes,
      fallback: DEFAULT_RECORDING_MAX_BYTES,
      means: "refuse every non-empty recording",
    },
    {
      env: "LIVE_DELTA_BYTES_PER_JOB",
      read: (c: typeof config) => c.live.deltaBytesPerJob,
      fallback: DEFAULT_LIVE_DELTA_BYTES_PER_JOB,
      means: "relay every delta, i.e. no ceiling",
    },
    {
      env: "SESSION_MAX_BYTES",
      read: (c: typeof config) => c.sessions.maxBytes,
      fallback: DEFAULT_SESSION_MAX_BYTES,
      means: "reclaim every session",
    },
    // Issue #107's pair, and the reason the `means` field is load-bearing rather
    // than decorative: these two share a prefix, sit adjacent in the env file, and
    // read zero in OPPOSITE directions. The strings below are the only place the
    // difference is stated as a fact a test holds.
    {
      env: "SCREENSHOT_MAX_BYTES",
      read: (c: typeof config) => c.screenshots.maxBytes,
      fallback: DEFAULT_SCREENSHOT_MAX_BYTES,
      means: "refuse every non-empty screenshot (fails closed)",
    },
    {
      env: "SCREENSHOT_MAX_PER_JOB",
      read: (c: typeof config) => c.screenshots.maxPerJob,
      fallback: DEFAULT_SCREENSHOT_MAX_PER_JOB,
      means: "permit every screenshot, i.e. no per-run ceiling (fails open)",
    },
  ];

  /** `config` re-evaluated with `name` set to `value`, or removed when undefined. */
  async function configWith(
    name: string,
    value: string | undefined,
  ): Promise<typeof config> {
    vi.resetModules();
    const saved = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    try {
      return (await import("./config.js")).config;
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
      vi.resetModules();
    }
  }

  for (const cap of caps) {
    it(`${cap.env}=0 reaches the cap (${cap.means}) rather than its default`, async () => {
      // The assertion the issue is about: an operator writing `=0` used to get
      // `cap.fallback` back, silently, because `0 || fallback` is the fallback.
      expect(cap.read(await configWith(cap.env, "0"))).toBe(0);
    });

    it(`${cap.env} falls back to its own default when unset, empty or unparseable`, async () => {
      for (const raw of [undefined, "", "   ", "not-a-number"]) {
        expect(cap.read(await configWith(cap.env, raw)), String(raw)).toBe(cap.fallback);
      }
    });
  }

  it("pins the session cap to the Orchestrator's own default", () => {
    // A cross-repo constant neither suite can see across: if the two disagree, the
    // API silently declines artifacts the Orchestrator considered within policy and
    // the only symptom is a 202 in the other service's log. The Orchestrator's
    // value lives at `orchestrator/internal/worker/sessions.go`
    // (`DefaultSessionMaxBytes`), and this asserts the equality so a change on
    // either side goes red here.
    expect(DEFAULT_SESSION_MAX_BYTES).toBe(5_000_000);
  });

  it("pins the screenshot cap to the Orchestrator's own default", () => {
    // The same coupling as the session cap above, and the same reason to pin it —
    // but with a wrinkle the session cap does not have: **both services read this
    // one variable name**, `SCREENSHOT_MAX_BYTES`, and the Orchestrator resolves it
    // independently (`orchestrator/cmd/server/main.go`'s `resolveScreenshotMaxBytes`,
    // whose default is `worker.DefaultScreenshotMaxBytes`). Its own env example says
    // the two "must agree" and tells an operator to set the variable on both sides,
    // so a drift here is a divergence in a value an operator believes is singular.
    //
    // Pinning became possible to state precisely in #107, which extracted this from
    // an inline literal into the named constant above — the price of the name is a
    // number now worth asserting.
    expect(DEFAULT_SCREENSHOT_MAX_BYTES).toBe(2_000_000);
  });
});
