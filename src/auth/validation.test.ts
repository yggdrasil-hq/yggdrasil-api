import { describe, expect, it } from "vitest";
import { usernameSchema } from "./validation.js";

describe("auth validation", () => {
  it("accepts valid usernames", () => {
    expect(usernameSchema.safeParse("alice_dev").success).toBe(true);
  });

  it("rejects invalid usernames", () => {
    expect(usernameSchema.safeParse("ab").success).toBe(false);
    expect(usernameSchema.safeParse("bad user").success).toBe(false);
    expect(usernameSchema.safeParse("!!!").success).toBe(false);
  });
});
