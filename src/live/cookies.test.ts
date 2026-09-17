import { describe, expect, it } from "vitest";
import { readCookie } from "./cookies.js";

describe("readCookie", () => {
  it("finds the named cookie among others", () => {
    expect(readCookie("theme=dark; yggdrasil_session=sess_1; lang=en", "yggdrasil_session")).toBe(
      "sess_1",
    );
  });

  it("handles the single-cookie and no-space-separator forms", () => {
    // Browsers emit "; " but the grammar allows any whitespace run, and a
    // hand-rolled proxy may not normalise it.
    expect(readCookie("yggdrasil_session=sess_1", "yggdrasil_session")).toBe("sess_1");
    expect(readCookie("a=1;yggdrasil_session=sess_2;b=2", "yggdrasil_session")).toBe("sess_2");
  });

  it("splits on the first '=' so a value may contain '='", () => {
    // Real sessions are uuids, but a signed/encoded value would contain padding
    // and truncating it would produce a string that looks valid and is not.
    expect(readCookie("yggdrasil_session=abc=def==", "yggdrasil_session")).toBe("abc=def==");
  });

  it("does not confuse a cookie whose name ends with the target's name", () => {
    // `x_yggdrasil_session` must not match `yggdrasil_session` — a prefix/suffix
    // comparison instead of equality would be an authentication bypass.
    expect(readCookie("x_yggdrasil_session=attacker", "yggdrasil_session")).toBeNull();
    expect(readCookie("yggdrasil_session_x=attacker", "yggdrasil_session")).toBeNull();
  });

  it("strips one layer of surrounding quotes", () => {
    expect(readCookie('yggdrasil_session="sess_1"', "yggdrasil_session")).toBe("sess_1");
  });

  it("returns null for an absent, empty, or malformed header", () => {
    expect(readCookie(undefined, "yggdrasil_session")).toBeNull();
    expect(readCookie("", "yggdrasil_session")).toBeNull();
    expect(readCookie("theme=dark", "yggdrasil_session")).toBeNull();
    // An empty value means "no credential", not an empty-string session id.
    expect(readCookie("yggdrasil_session=", "yggdrasil_session")).toBeNull();
    expect(readCookie("yggdrasil_session", "yggdrasil_session")).toBeNull();
  });

  it("returns null for a missing name", () => {
    expect(readCookie("yggdrasil_session=sess_1", "")).toBeNull();
  });
});
