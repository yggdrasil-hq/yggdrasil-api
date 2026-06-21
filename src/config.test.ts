import { describe, expect, it } from "vitest";
import { appPublicRedirect } from "./config.js";

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
