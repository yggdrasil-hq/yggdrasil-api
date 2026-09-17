import { describe, expect, it } from "vitest";
import { composeDesignBrief } from "./brief.js";

describe("composeDesignBrief (ADR 020 item 5)", () => {
  it("returns the brief untouched for a first session", () => {
    expect(composeDesignBrief("A checkout flow", "checkout", null)).toBe("A checkout flow");
  });

  it("frames a re-opened design as a continuation of the same folder", () => {
    const brief = composeDesignBrief("Make the cart clearer", "checkout", {
      sessionId: "session_1",
      prUrl: null,
      paths: [],
    });

    expect(brief.startsWith("Make the cart clearer")).toBe(true);
    // The original brief must survive verbatim — the agent still needs it.
    expect(brief).toContain("Make the cart clearer");
    expect(brief).toContain("continuation of an earlier design session");
    expect(brief).toContain("`designs/checkout/`");
    // The whole point: stop the agent inventing a parallel folder.
    expect(brief).toContain("Do not start a parallel folder");
  });

  it("names the previous draft PR and warns the files may not be present yet", () => {
    const brief = composeDesignBrief("Iterate", "checkout", {
      sessionId: "session_1",
      prUrl: "https://github.com/acme/web/pull/7",
      paths: ["designs/checkout/page.html"],
    });

    expect(brief).toContain("https://github.com/acme/web/pull/7");
    expect(brief).toContain("may not be merged");
  });

  it("lists the previously committed paths", () => {
    const brief = composeDesignBrief("Iterate", "checkout", {
      sessionId: "session_1",
      prUrl: null,
      paths: ["designs/checkout/page.html", "designs/checkout/empty.html"],
    });

    expect(brief).toContain("- designs/checkout/page.html");
    expect(brief).toContain("- designs/checkout/empty.html");
  });

  it("omits the PR line and the path list when there is nothing to say", () => {
    const brief = composeDesignBrief("Iterate", "checkout", {
      sessionId: "session_1",
      prUrl: null,
      paths: [],
    });

    expect(brief).not.toContain("draft PR");
    expect(brief).not.toContain("Files the previous session committed");
  });
});
