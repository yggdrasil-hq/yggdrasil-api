import { describe, expect, it, vi } from "vitest";
import { requireInternalApiToken } from "./internal-auth.js";

function makeReq(authHeader: string | undefined) {
  return {
    header: (name: string) => (name.toLowerCase() === "authorization" ? authHeader : undefined),
  };
}

function makeRes() {
  const res: { statusCode?: number; body?: unknown; status: (code: number) => typeof res; json: (body: unknown) => void } = {
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
    },
  };
  return res;
}

describe("requireInternalApiToken", () => {
  it("calls next() with a valid bearer token", () => {
    const req = makeReq("Bearer test-internal-api-token");
    const res = makeRes();
    const next = vi.fn();

    requireInternalApiToken(req as never, res as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
  });

  it("rejects a missing authorization header", () => {
    const req = makeReq(undefined);
    const res = makeRes();
    const next = vi.fn();

    requireInternalApiToken(req as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("rejects an incorrect bearer token", () => {
    const req = makeReq("Bearer wrong-token");
    const res = makeRes();
    const next = vi.fn();

    requireInternalApiToken(req as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("rejects a non-bearer authorization header", () => {
    const req = makeReq("Basic dGVzdA==");
    const res = makeRes();
    const next = vi.fn();

    requireInternalApiToken(req as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
